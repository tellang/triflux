// ============================================================================
// Claude Usage API (api.anthropic.com/api/oauth/usage)
// ============================================================================

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import https from "node:https";
import {
  CLAUDE_API_TIMEOUT_MS,
  CLAUDE_CREDENTIALS_PATH,
  CLAUDE_REFRESH_FLAG,
  CLAUDE_REFRESH_LOCK_PATH,
  CLAUDE_USAGE_429_BACKOFF_MS,
  CLAUDE_USAGE_CACHE_PATH,
  CLAUDE_USAGE_ERROR_BACKOFF_MS,
  CLAUDE_USAGE_STALE_MS_SOLO,
  CLAUDE_USAGE_STALE_MS_WITH_OMC,
  DEFAULT_OAUTH_CLIENT_ID,
  FIVE_HOUR_MS,
  OMC_PLUGIN_USAGE_CACHE_PATH,
  SEVEN_DAY_MS,
  SPAWN_LOCK_TTL_MS,
} from "../constants.mjs";
import { readContextMonitorSnapshot } from "../context-monitor.mjs";
import {
  advanceToNextCycle,
  clampPercent,
  readJson,
  writeJsonSafe,
} from "../utils.mjs";

export const CLAUDE_USAGE_POLL_BASE_MS = 5_000;
export const CLAUDE_USAGE_POLL_JITTER_RATIO = 0.2;
export const CLAUDE_USAGE_RATE_LIMIT_BACKOFF_MS = [
  CLAUDE_USAGE_POLL_BASE_MS,
  10_000,
  30_000,
  60_000,
  120_000,
];

// OMC 활성 여부에 따라 캐시 TTL 동적 결정
function getClaudeUsageStaleMs() {
  return existsSync(OMC_PLUGIN_USAGE_CACHE_PATH)
    ? CLAUDE_USAGE_STALE_MS_WITH_OMC
    : CLAUDE_USAGE_STALE_MS_SOLO;
}

export function computeClaudeUsagePollState({
  consecutive429s = 0,
  outcome = "success",
  random = Math.random,
  jitterRatio = CLAUDE_USAGE_POLL_JITTER_RATIO,
} = {}) {
  const current429s = Number.isFinite(consecutive429s)
    ? Math.max(0, consecutive429s)
    : 0;
  const next429s = outcome === "rate_limit" ? current429s + 1 : 0;
  const stepIndex =
    outcome === "rate_limit"
      ? Math.min(next429s, CLAUDE_USAGE_RATE_LIMIT_BACKOFF_MS.length - 1)
      : 0;
  const baseDelayMs = CLAUDE_USAGE_RATE_LIMIT_BACKOFF_MS[stepIndex];
  const sample = Number(random?.());
  const normalized = Number.isFinite(sample)
    ? Math.min(1, Math.max(0, sample))
    : 0.5;
  const jitterFactor = 1 + (normalized * 2 - 1) * jitterRatio;
  return {
    consecutive429s: next429s,
    baseDelayMs,
    delayMs: Math.max(1, Math.round(baseDelayMs * jitterFactor)),
  };
}

function getSnapshotSchedule(cache) {
  const timestamp = Number(cache?.timestamp);
  const nextRefreshAt = Number(cache?.nextRefreshAt);
  if (Number.isFinite(nextRefreshAt)) {
    return {
      nextRefreshAt,
      shouldRefresh: Date.now() >= nextRefreshAt,
    };
  }

  const ageMs = Number.isFinite(timestamp)
    ? Date.now() - timestamp
    : Number.MAX_SAFE_INTEGER;
  const fallbackMs = cache?.error
    ? cache.errorType === "rate_limit"
      ? CLAUDE_USAGE_429_BACKOFF_MS
      : CLAUDE_USAGE_ERROR_BACKOFF_MS
    : getClaudeUsageStaleMs();

  return {
    nextRefreshAt: Number.isFinite(timestamp) ? timestamp + fallbackMs : null,
    shouldRefresh: ageMs >= fallbackMs,
  };
}

export function readClaudeCredentials() {
  const data = readJson(CLAUDE_CREDENTIALS_PATH, null);
  if (!data) return null;
  const creds = data.claudeAiOauth || data;
  if (!creds.accessToken) return null;
  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };
}

export function refreshClaudeAccessToken(refreshToken) {
  return new Promise((resolve) => {
    const clientId =
      process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString();
    const req = https.request(
      {
        hostname: "platform.claude.com",
        path: "/v1/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: CLAUDE_API_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.access_token) {
                resolve({
                  accessToken: parsed.access_token,
                  refreshToken: parsed.refresh_token || refreshToken,
                  expiresAt: parsed.expires_in
                    ? Date.now() + parsed.expires_in * 1000
                    : parsed.expires_at,
                });
                return;
              }
            } catch {
              /* parse 실패 */
            }
          }
          resolve(null);
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end(body);
  });
}

export function writeBackClaudeCredentials(creds) {
  try {
    const data = readJson(CLAUDE_CREDENTIALS_PATH, null);
    if (!data) return;
    const target = data.claudeAiOauth || data;
    target.accessToken = creds.accessToken;
    if (creds.expiresAt != null) target.expiresAt = creds.expiresAt;
    if (creds.refreshToken) target.refreshToken = creds.refreshToken;
    writeFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(data, null, 2));
  } catch {
    /* 쓰기 실패 무시 */
  }
}

export function fetchClaudeUsageFromApi(accessToken) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
        },
        timeout: CLAUDE_API_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve({ ok: true, data: JSON.parse(data) });
            } catch {
              resolve({ ok: false, status: 0 });
            }
          } else {
            resolve({ ok: false, status: res.statusCode });
          }
        });
      },
    );
    req.on("error", () => resolve({ ok: false, status: 0, error: "network" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: "timeout" });
    });
    req.end();
  });
}

export function parseClaudeUsageResponse(response) {
  if (!response || typeof response !== "object") return null;
  // five_hour/seven_day 키 자체가 없으면 비정상 응답
  if (!response.five_hour && !response.seven_day) return null;
  // 키 자체가 부재하면 percent=null (HUD --% placeholder), utilization=null 만 0%로 처리
  const fiveHourPresent = response.five_hour != null;
  const sevenDayPresent = response.seven_day != null;
  return {
    fiveHourPercent: fiveHourPresent
      ? clampPercent(response.five_hour.utilization ?? 0)
      : null,
    weeklyPercent: sevenDayPresent
      ? clampPercent(response.seven_day.utilization ?? 0)
      : null,
    fiveHourResetsAt: response.five_hour?.resets_at || null,
    weeklyResetsAt: response.seven_day?.resets_at || null,
  };
}

// stale 캐시의 과거 resetsAt → 다음 주기로 순환 추정 (null 대신 다음 reset 시간 계산)
export function stripStaleResets(data) {
  if (!data) return data;
  const copy = { ...data };
  if (copy.fiveHourResetsAt) {
    const t = new Date(copy.fiveHourResetsAt).getTime();
    if (!Number.isNaN(t))
      copy.fiveHourResetsAt = new Date(
        advanceToNextCycle(t, FIVE_HOUR_MS),
      ).toISOString();
  }
  if (copy.weeklyResetsAt) {
    const t = new Date(copy.weeklyResetsAt).getTime();
    if (!Number.isNaN(t))
      copy.weeklyResetsAt = new Date(
        advanceToNextCycle(t, SEVEN_DAY_MS),
      ).toISOString();
  }
  return copy;
}

export function readClaudeUsageSnapshot() {
  const cache = readJson(CLAUDE_USAGE_CACHE_PATH, null);
  const ts = Number(cache?.timestamp);
  const schedule = getSnapshotSchedule(cache);
  const staleBackoffActive =
    cache?.errorType === "rate_limit" &&
    Number.isFinite(schedule.nextRefreshAt) &&
    Date.now() < schedule.nextRefreshAt;

  // 1차: 자체 캐시에 유효 데이터가 있는 경우
  if (cache?.data) {
    // 에러 상태에서 보존된 stale 데이터 → backoff 존중하되 표시용 데이터 반환
    if (cache.error) {
      return {
        data: stripStaleResets(cache.data),
        shouldRefresh: schedule.shouldRefresh,
        isStale: staleBackoffActive,
      };
    }
    // resets_at이 지난 윈도우의 percent를 0으로 보정 (stale 캐시 방지)
    const data = { ...cache.data };
    const now = Date.now();
    if (
      data.fiveHourResetsAt &&
      new Date(data.fiveHourResetsAt).getTime() <= now
    ) {
      data.fiveHourPercent = 0;
    }
    if (data.weeklyResetsAt && new Date(data.weeklyResetsAt).getTime() <= now) {
      data.weeklyPercent = 0;
    }
    return { data, shouldRefresh: schedule.shouldRefresh, isStale: false };
  }

  // 2차: 에러 backoff — 최근 에러 시 재시도 억제 (무한 spawn 방지)
  if (cache?.error && Number.isFinite(ts)) {
    if (!schedule.shouldRefresh) {
      const omcCache = readJson(OMC_PLUGIN_USAGE_CACHE_PATH, null);
      // OMC 캐시가 에러 이후 갱신되었으면 → 에러 캐시 덮어쓰고 그 데이터 사용
      if (omcCache?.data?.fiveHourPercent != null && omcCache.timestamp > ts) {
        writeClaudeUsageCache(omcCache.data);
        return { data: omcCache.data, shouldRefresh: false, isStale: false };
      }
      // stale OMC fallback 또는 null (--% 플레이스홀더 표시, 가짜 0% 방지)
      const staleData =
        omcCache?.data?.fiveHourPercent != null
          ? stripStaleResets(omcCache.data)
          : null;
      return {
        data: staleData,
        shouldRefresh: false,
        isStale: staleBackoffActive,
      };
    }
  }

  // 3차: OMC 플러그인 캐시 (같은 API 데이터, 중복 호출 방지)
  const OMC_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
  const omcCache = readJson(OMC_PLUGIN_USAGE_CACHE_PATH, null);
  if (omcCache?.data?.fiveHourPercent != null) {
    const omcAge = Number.isFinite(omcCache.timestamp)
      ? Date.now() - omcCache.timestamp
      : Number.MAX_SAFE_INTEGER;
    if (omcAge < OMC_CACHE_MAX_AGE_MS) {
      writeClaudeUsageCache(omcCache.data);
      return {
        data: omcCache.data,
        shouldRefresh: omcAge > getClaudeUsageStaleMs(),
        isStale: false,
      };
    }
    // stale이어도 data: null보다는 오래된 데이터를 fallback으로 표시
    return {
      data: stripStaleResets(omcCache.data),
      shouldRefresh: true,
      isStale: false,
    };
  }

  // 캐시/fallback 모두 없음: null 반환 → --% 플레이스홀더 + 리프레시 시도
  return { data: null, shouldRefresh: true, isStale: false };
}

export function writeClaudeUsageCache(
  data,
  errorInfo = null,
  pollState = null,
) {
  const state =
    pollState ||
    (errorInfo
      ? {
          consecutive429s: errorInfo.type === "rate_limit" ? 1 : 0,
          baseDelayMs:
            errorInfo.type === "rate_limit"
              ? CLAUDE_USAGE_429_BACKOFF_MS
              : CLAUDE_USAGE_ERROR_BACKOFF_MS,
          delayMs:
            errorInfo.type === "rate_limit"
              ? CLAUDE_USAGE_429_BACKOFF_MS
              : CLAUDE_USAGE_ERROR_BACKOFF_MS,
        }
      : computeClaudeUsagePollState({ outcome: "success" }));
  const entry = {
    timestamp: Date.now(),
    data,
    error: !!errorInfo,
    errorType: errorInfo?.type || null, // "rate_limit" | "auth" | "network" | "unknown"
    errorStatus: errorInfo?.status || null, // HTTP 상태 코드
    consecutive429s: state.consecutive429s,
    nextRefreshBaseMs: state.baseDelayMs,
    nextRefreshAt: Date.now() + state.delayMs,
  };
  // 에러 시 기존 유효 데이터 보존 (--% n/a 방지)
  if (errorInfo && data == null) {
    const prev = readJson(CLAUDE_USAGE_CACHE_PATH, null);
    if (prev?.data) {
      entry.data = prev.data;
      entry.stale = true;
    }
  }
  writeJsonSafe(CLAUDE_USAGE_CACHE_PATH, entry);
}

export async function fetchClaudeUsage(forceRefresh = false) {
  const existingSnapshot = readClaudeUsageSnapshot();
  if (!forceRefresh && !existingSnapshot.shouldRefresh) {
    return existingSnapshot.data || null;
  }
  const cache = readJson(CLAUDE_USAGE_CACHE_PATH, null);
  const consecutive429s = Number.isFinite(cache?.consecutive429s)
    ? cache.consecutive429s
    : 0;
  let creds = readClaudeCredentials();
  if (!creds) {
    writeClaudeUsageCache(null, { type: "auth", status: 0 });
    return existingSnapshot.data || null;
  }

  // 토큰 만료 시 리프레시
  if (creds.expiresAt && creds.expiresAt <= Date.now() && creds.refreshToken) {
    const refreshed = await refreshClaudeAccessToken(creds.refreshToken);
    if (refreshed) {
      creds = { ...creds, ...refreshed };
      writeBackClaudeCredentials(creds);
    } else {
      writeClaudeUsageCache(null, { type: "auth", status: 0 });
      return existingSnapshot.data || null;
    }
  }

  const result = await fetchClaudeUsageFromApi(creds.accessToken);
  if (!result.ok) {
    // 에러 유형별 분류하여 backoff 차등 적용
    const errorType =
      result.status === 429
        ? "rate_limit"
        : result.status === 401 || result.status === 403
          ? "auth"
          : result.error === "timeout" || result.error === "network"
            ? "network"
            : "unknown";
    const pollState =
      errorType === "rate_limit"
        ? computeClaudeUsagePollState({
            consecutive429s,
            outcome: "rate_limit",
          })
        : null;
    writeClaudeUsageCache(
      existingSnapshot.data,
      { type: errorType, status: result.status },
      pollState,
    );
    return existingSnapshot.data || null;
  }
  const usage = parseClaudeUsageResponse(result.data);
  const pollState = usage
    ? computeClaudeUsagePollState({ outcome: "success" })
    : null;
  writeClaudeUsageCache(
    usage,
    usage ? null : { type: "unknown", status: 0 },
    pollState,
  );
  return usage;
}

export function scheduleClaudeUsageRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;

  // OMC 플러그인이 이미 fresh 데이터를 가지고 있으면 HUD 리프레시 불필요 (429 방지)
  try {
    const omcCache = readJson(OMC_PLUGIN_USAGE_CACHE_PATH, null);
    if (omcCache?.data?.fiveHourPercent != null) {
      const omcAge = Number.isFinite(omcCache.timestamp)
        ? Date.now() - omcCache.timestamp
        : Infinity;
      if (omcAge < getClaudeUsageStaleMs()) {
        writeClaudeUsageCache(omcCache.data); // HUD 캐시에 복사만
        return;
      }
    }
  } catch {
    /* 무시 */
  }

  // 스폰 락: 30초 내 이미 스폰했으면 중복 방지 (첫 설치 시 429 방지)
  try {
    if (existsSync(CLAUDE_REFRESH_LOCK_PATH)) {
      const lockAge = Date.now() - readJson(CLAUDE_REFRESH_LOCK_PATH, {}).t;
      if (lockAge < SPAWN_LOCK_TTL_MS) return;
    }
    writeJsonSafe(CLAUDE_REFRESH_LOCK_PATH, { t: Date.now() });
  } catch {
    /* 락 실패 무시 — 스폰 진행 */
  }

  try {
    const child = spawn(process.execPath, [scriptPath, CLAUDE_REFRESH_FLAG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (spawnErr) {
    // spawn 실패 시 에러 유형을 캐시에 기록 (HUD에서 원인 힌트 표시 가능)
    writeClaudeUsageCache(null, {
      type: "network",
      status: 0,
      hint: String(spawnErr?.message || spawnErr),
    });
  }
}

export function readClaudeContextSnapshot() {
  return readContextMonitorSnapshot();
}
