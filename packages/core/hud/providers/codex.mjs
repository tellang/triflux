// ============================================================================
// Codex rate limits 추출 / 캐싱
// ============================================================================

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEX_AUTH_PATH,
  CODEX_BROKER_AUTH_CACHE_DIR,
  CODEX_MIN_BUCKETS,
  CODEX_PROBE_STATE_PATH,
  CODEX_PROBE_TIMEOUT_MS,
  CODEX_PROBE_TTL_MS,
  CODEX_QUOTA_CACHE_PATH,
  CODEX_QUOTA_STALE_MS,
  CODEX_REFRESH_FLAG,
  CODEX_REFRESH_LOCK_PATH,
  SPAWN_LOCK_TTL_MS,
} from "../constants.mjs";
import { decodeJwtEmail, readJson, writeJsonSafe } from "../utils.mjs";
import {
  listProbeTargets,
  probeRateLimitsViaAppServer,
  recordProbe,
} from "./codex-probe.mjs";

// window_minutes 기반 5h/1w 슬롯 분류
// 5h: ≤360min (300min 표준, ±20% 허용)
// weekly: ≥7000min (10080min 표준, ~5d 이상만 허용 — 24h/48h 등 중간 버킷 도입 시 silent 오분류 방지)
export function classifyBucket(bucket) {
  if (!bucket?.window_minutes) return null;
  if (bucket.window_minutes <= 360) return "five_hour";
  if (bucket.window_minutes >= 7000) return "weekly";
  return null;
}

// primary/secondary를 window_minutes 기준으로 정규화
// HUD 규약: primary=5h, secondary=1w
export function normalizeBuckets(rl) {
  let primary = null;
  let secondary = null;
  for (const bucket of [rl.primary, rl.secondary].filter(Boolean)) {
    const kind = classifyBucket(bucket);
    if (kind === "five_hour") primary = bucket;
    else if (kind === "weekly") secondary = bucket;
  }
  return { primary, secondary };
}

export function getCodexEmail() {
  try {
    const auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8"));
    return decodeJwtEmail(auth?.tokens?.id_token);
  } catch {
    return null;
  }
}

// resets_at이 지난 윈도우의 used_percent를 0으로 보정
export function expireStaleCodexBuckets(
  buckets,
  nowSec = Math.floor(Date.now() / 1000),
) {
  if (!buckets) return buckets;
  const result = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    if (!bucket) {
      result[key] = bucket;
      continue;
    }
    let updated = bucket;
    if (bucket.primary?.resets_at && bucket.primary.resets_at <= nowSec) {
      updated = {
        ...updated,
        primary: { ...updated.primary, used_percent: 0, expired: true },
      };
    }
    if (bucket.secondary?.resets_at && bucket.secondary.resets_at <= nowSec) {
      updated = {
        ...updated,
        secondary: { ...updated.secondary, used_percent: 0, expired: true },
      };
    }
    result[key] = updated;
  }
  return result;
}

const RESET_CLUSTER_TOLERANCE_SEC = 90;
// A probe may miss the instant immediately after a reset. Keep that brief
// polling gap, but never let a long-expired cached window win the fallback.
const STALE_WINDOW_FALLBACK_GRACE_SEC = CODEX_PROBE_TTL_MS / 1000;

function isNewerSnapshot(candidate, current) {
  if (!current) return true;
  const candidateTimestamp = Date.parse(candidate.timestamp);
  const currentTimestamp = Date.parse(current.timestamp);
  return (
    Number.isFinite(candidateTimestamp) &&
    (!Number.isFinite(currentTimestamp) ||
      candidateTimestamp > currentTimestamp)
  );
}

function selectCodexWindowSnapshot(snapshots, nowSec, windowKey) {
  const groups = [];
  const ungrouped = [];

  for (const snapshot of snapshots) {
    const resetAt = Number(snapshot[windowKey]?.resets_at);
    if (!Number.isFinite(resetAt)) {
      ungrouped.push(snapshot);
      continue;
    }

    let group = groups.find(
      (candidate) =>
        Math.max(candidate.maxResetAt, resetAt) -
          Math.min(candidate.minResetAt, resetAt) <=
        RESET_CLUSTER_TOLERANCE_SEC,
    );
    if (!group) {
      group = {
        minResetAt: resetAt,
        maxResetAt: resetAt,
        latest: snapshot,
      };
      groups.push(group);
      continue;
    }

    group.minResetAt = Math.min(group.minResetAt, resetAt);
    group.maxResetAt = Math.max(group.maxResetAt, resetAt);
    if (isNewerSnapshot(snapshot, group.latest)) group.latest = snapshot;
  }

  const activeGroups = groups.filter(
    (group) => Number(group.latest[windowKey]?.resets_at) > nowSec,
  );
  let selected = null;
  if (activeGroups.length > 0) {
    selected = activeGroups
      .map((group) => group.latest)
      .sort((a, b) => {
        const usedDifference =
          Number(b[windowKey]?.used_percent || 0) -
          Number(a[windowKey]?.used_percent || 0);
        if (usedDifference !== 0) return usedDifference;
        return Date.parse(b.timestamp) - Date.parse(a.timestamp);
      })[0];
  } else {
    for (const snapshot of [
      ...groups
        .filter(
          (group) =>
            nowSec - Number(group.latest[windowKey]?.resets_at) <=
            STALE_WINDOW_FALLBACK_GRACE_SEC,
        )
        .map((group) => group.latest),
      ...ungrouped,
    ]) {
      if (isNewerSnapshot(snapshot, selected)) selected = snapshot;
    }
  }

  return { snapshot: selected, activeGroupCount: activeGroups.length };
}

function selectCodexSnapshot(snapshots, nowSec) {
  const primarySelection = selectCodexWindowSnapshot(
    snapshots,
    nowSec,
    "primary",
  );
  const secondarySelection = selectCodexWindowSnapshot(
    snapshots,
    nowSec,
    "secondary",
  );
  const primarySnapshot = primarySelection.snapshot;
  if (!primarySnapshot) return null;

  const secondarySnapshot = secondarySelection.snapshot;
  const selected = {
    ...primarySnapshot,
    secondary: secondarySnapshot?.secondary || null,
    secondaryTimestamp:
      secondarySnapshot?.timestamp || primarySnapshot.timestamp,
  };
  if (
    primarySelection.activeGroupCount >= 2 ||
    secondarySelection.activeGroupCount >= 2
  ) {
    selected.mixedWindows = true;
  }
  return selected;
}

function mergeRateLimitSnapshots(snapshots, nowSec) {
  const merged = {};
  const codexSnapshots = [];
  for (const snapshot of snapshots) {
    if (snapshot.limitId === "codex") {
      codexSnapshots.push(snapshot);
      continue;
    }
    if (isNewerSnapshot(snapshot, merged[snapshot.limitId])) {
      merged[snapshot.limitId] = snapshot;
    }
  }

  const codex = selectCodexSnapshot(codexSnapshots, nowSec);
  if (codex) merged.codex = codex;
  return merged;
}

// ============================================================================
// Codex 세션 JSONL에서 실제 rate limits 추출
// 한계: rate_limits는 세션별 스냅샷이므로 여러 세션 간 토큰 합산은 불가.
// 최근 7일간 세션 파일을 스캔해 가장 최신 rate_limits 버킷을 수집한다.
// 합성 버킷(token_count 기반)은 2일 이내 데이터만 허용하여 stale 방지.
// ============================================================================
export function getCodexRateLimits({
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  now = new Date(),
  maxLinesPerFile = 800,
  extraSnapshots = [],
} = {}) {
  let syntheticBucket = null; // 최근 token_count에서 합성 (행 활성화 + 토큰 데이터용)
  const recentSnapshots = [...extraSnapshots];
  const nowSec = Math.floor(now.getTime() / 1000);

  // 7일간 스캔: 실제 rate_limits 우선, 합성 버킷은 폴백
  for (let dayOffset = 0; dayOffset <= 6; dayOffset++) {
    const d = new Date(now.getTime() - dayOffset * 86_400_000);
    const sessDir = join(
      sessionsRoot,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    let files = [];
    if (existsSync(sessDir)) {
      try {
        files = readdirSync(sessDir)
          .filter((f) => f.endsWith(".jsonl"))
          .sort()
          .reverse();
      } catch {
        files = [];
      }
    }

    const daySnapshots = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(sessDir, file), "utf-8");
        const found = {};
        const lines = content.trim().split("\n").reverse();
        let scanned = 0;
        for (const line of lines) {
          if (++scanned > maxLinesPerFile) break;
          try {
            const evt = JSON.parse(line);
            const rl = evt?.payload?.rate_limits;
            if (rl?.limit_id && !found[rl.limit_id]) {
              // window_minutes 기준으로 5h/1w 슬롯 정규화
              const { primary, secondary } = normalizeBuckets(rl);
              found[rl.limit_id] = {
                limitId: rl.limit_id,
                limitName: rl.limit_name,
                primary,
                secondary,
                credits: rl.credits,
                tokens: evt.payload?.info?.total_token_usage,
                contextWindow: evt.payload?.info?.model_context_window,
                timestamp: evt.timestamp,
              };
            } else if (
              dayOffset <= 1 &&
              !rl &&
              evt?.payload?.info?.total_token_usage &&
              !syntheticBucket
            ) {
              // 2일 이내 token_count: 합성 버킷 (rate_limits가 null일 때 행 활성화용, stale 방지)
              syntheticBucket = {
                limitId: "codex",
                limitName: "codex-session",
                primary: null,
                secondary: null,
                credits: null,
                tokens: evt.payload.info.total_token_usage,
                contextWindow: evt.payload.info.model_context_window,
                timestamp: evt.timestamp,
              };
            }
          } catch {
            /* 라인 파싱 실패 무시 */
          }
          if (Object.keys(found).length >= CODEX_MIN_BUCKETS) break;
        }
        daySnapshots.push(...Object.values(found));
      } catch {
        /* 파일 읽기 실패 무시 */
      }
    }

    if (dayOffset <= 1) {
      recentSnapshots.push(...daySnapshots);
      if (dayOffset === 0) continue;
    }

    const snapshots = dayOffset <= 1 ? recentSnapshots : daySnapshots;
    const mergedBuckets = mergeRateLimitSnapshots(snapshots, nowSec);
    if (Object.keys(mergedBuckets).length > 0) {
      if (syntheticBucket) {
        const main =
          mergedBuckets.codex || mergedBuckets[Object.keys(mergedBuckets)[0]];
        if (main && !main.tokens) main.tokens = syntheticBucket.tokens;
      }
      return expireStaleCodexBuckets(mergedBuckets, nowSec);
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
  const buckets = expireStaleCodexBuckets(cache.buckets);
  const ts = Number(cache.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < CODEX_QUOTA_STALE_MS;
  return { buckets, shouldRefresh: !isFresh };
}

export async function collectProbeSnapshots(now = new Date()) {
  if (process.env.TFX_CODEX_PROBE === "0") return [];
  let targets = [];
  try {
    targets = listProbeTargets({
      codexAuthPath: CODEX_AUTH_PATH,
      brokerCacheDir: CODEX_BROKER_AUTH_CACHE_DIR,
      stateFilePath: CODEX_PROBE_STATE_PATH,
      ttlMs: Number(process.env.TFX_CODEX_PROBE_TTL_MS) || CODEX_PROBE_TTL_MS,
      nowMs: now.getTime(),
    });
  } catch {
    return [];
  }
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      const snapshots = await probeRateLimitsViaAppServer({
        codexHome: target.codexHome,
        timeoutMs: CODEX_PROBE_TIMEOUT_MS,
        now,
      });
      recordProbe(CODEX_PROBE_STATE_PATH, target.key, now.getTime());
      return snapshots || [];
    }),
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
}

export async function refreshCodexRateLimitsCache() {
  const now = new Date();
  const extraSnapshots = await collectProbeSnapshots(now);
  const buckets = getCodexRateLimits({ now, extraSnapshots });
  // buckets가 null이어도 캐시 갱신 (stale 데이터 제거)
  writeJsonSafe(CODEX_QUOTA_CACHE_PATH, { timestamp: Date.now(), buckets });
  return buckets;
}

export function scheduleCodexRateLimitRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;

  // 스폰 락: 30초 내 이미 스폰했으면 중복 방지
  try {
    if (existsSync(CODEX_REFRESH_LOCK_PATH)) {
      const lockAge = Date.now() - readJson(CODEX_REFRESH_LOCK_PATH, {}).t;
      if (lockAge < SPAWN_LOCK_TTL_MS) return;
    }
    writeJsonSafe(CODEX_REFRESH_LOCK_PATH, { t: Date.now() });
  } catch {
    /* 락 실패 무시 — 스폰 진행 */
  }

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
