// ============================================================================
// Codex rate limits 추출 / 캐싱
// ============================================================================
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  CODEX_AUTH_PATH, CODEX_QUOTA_CACHE_PATH, CODEX_QUOTA_STALE_MS,
  CODEX_MIN_BUCKETS, CODEX_REFRESH_FLAG,
} from "../constants.mjs";
import { readJson, writeJsonSafe, decodeJwtEmail } from "../utils.mjs";

export function getCodexEmail() {
  try {
    const auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8"));
    return decodeJwtEmail(auth?.tokens?.id_token);
  } catch { return null; }
}

// resets_at이 지난 윈도우의 used_percent를 0으로 보정
export function expireStaleCodexBuckets(buckets) {
  if (!buckets) return buckets;
  const nowSec = Math.floor(Date.now() / 1000);
  const result = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    if (!bucket) { result[key] = bucket; continue; }
    let updated = bucket;
    if (bucket.primary?.resets_at && bucket.primary.resets_at <= nowSec) {
      updated = { ...updated, primary: { ...updated.primary, used_percent: 0 } };
    }
    if (bucket.secondary?.resets_at && bucket.secondary.resets_at <= nowSec) {
      updated = { ...updated, secondary: { ...updated.secondary, used_percent: 0 } };
    }
    result[key] = updated;
  }
  return result;
}

// ============================================================================
// Codex 세션 JSONL에서 실제 rate limits 추출
// 한계: rate_limits는 세션별 스냅샷이므로 여러 세션 간 토큰 합산은 불가.
// 최근 7일간 세션 파일을 스캔해 가장 최신 rate_limits 버킷을 수집한다.
// 합성 버킷(token_count 기반)은 2일 이내 데이터만 허용하여 stale 방지.
// ============================================================================
export function getCodexRateLimits() {
  const now = new Date();
  let syntheticBucket = null; // 최근 token_count에서 합성 (행 활성화 + 토큰 데이터용)

  // 7일간 스캔: 실제 rate_limits 우선, 합성 버킷은 폴백
  for (let dayOffset = 0; dayOffset <= 6; dayOffset++) {
    const d = new Date(now.getTime() - dayOffset * 86_400_000);
    const sessDir = join(
      homedir(), ".codex", "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    if (!existsSync(sessDir)) continue;
    let files;
    try { files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")).sort().reverse(); }
    catch { continue; }

    const mergedBuckets = {};
    for (const file of files) {
      try {
        const content = readFileSync(join(sessDir, file), "utf-8");
        const lines = content.trim().split("\n").reverse();
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            const rl = evt?.payload?.rate_limits;
            if (rl?.limit_id && !mergedBuckets[rl.limit_id]) {
              // 실제 rate_limits: limit_id별 최신 이벤트만 기록
              mergedBuckets[rl.limit_id] = {
                limitId: rl.limit_id, limitName: rl.limit_name,
                primary: rl.primary, secondary: rl.secondary,
                credits: rl.credits,
                tokens: evt.payload?.info?.total_token_usage,
                contextWindow: evt.payload?.info?.model_context_window,
                timestamp: evt.timestamp,
              };
            } else if (dayOffset <= 1 && !rl && evt?.payload?.info?.total_token_usage && !syntheticBucket) {
              // 2일 이내 token_count: 합성 버킷 (rate_limits가 null일 때 행 활성화용, stale 방지)
              syntheticBucket = {
                limitId: "codex", limitName: "codex-session",
                primary: null, secondary: null,
                credits: null,
                tokens: evt.payload.info.total_token_usage,
                contextWindow: evt.payload.info.model_context_window,
                timestamp: evt.timestamp,
              };
            }
          } catch { /* 라인 파싱 실패 무시 */ }
          if (Object.keys(mergedBuckets).length >= CODEX_MIN_BUCKETS) break;
        }
      } catch { /* 파일 읽기 실패 무시 */ }
    }
    // 실제 rate_limits 발견 → 토큰 데이터 병합 후 즉시 반환
    if (Object.keys(mergedBuckets).length > 0) {
      if (syntheticBucket) {
        const main = mergedBuckets.codex || mergedBuckets[Object.keys(mergedBuckets)[0]];
        if (main && !main.tokens) main.tokens = syntheticBucket.tokens;
      }
      expireStaleCodexBuckets(mergedBuckets);
      return mergedBuckets;
    }
  }
  // 실제 rate_limits 없음 → 합성 버킷이라도 반환 (행 활성화)
  return syntheticBucket ? { codex: syntheticBucket } : null;
}

export function readCodexRateLimitSnapshot() {
  const cache = readJson(CODEX_QUOTA_CACHE_PATH, null);
  if (!cache?.buckets) {
    return { buckets: null, shouldRefresh: true };
  }
  expireStaleCodexBuckets(cache.buckets);
  const ts = Number(cache.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < CODEX_QUOTA_STALE_MS;
  return { buckets: cache.buckets, shouldRefresh: !isFresh };
}

export function refreshCodexRateLimitsCache() {
  const buckets = getCodexRateLimits();
  // buckets가 null이어도 캐시 갱신 (stale 데이터 제거)
  writeJsonSafe(CODEX_QUOTA_CACHE_PATH, { timestamp: Date.now(), buckets });
  return buckets;
}

export function scheduleCodexRateLimitRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;
  try {
    const child = spawn(process.execPath, [scriptPath, CODEX_REFRESH_FLAG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (spawnErr) {
    // spawn 실패 시 캐시에 에러 힌트 기록
    writeJsonSafe(CODEX_QUOTA_CACHE_PATH, {
      timestamp: Date.now(),
      buckets: null,
      error: true,
      errorHint: String(spawnErr?.message || spawnErr),
    });
  }
}
