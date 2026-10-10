// ============================================================================
// Claude Usage API (api.anthropic.com/api/oauth/usage)
// ============================================================================

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import https from "node:https";
import { userInfo } from "node:os";
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
  getClaudeCodeUserAgent,
  getClaudeCredentialPaths,
  OMC_PLUGIN_USAGE_CACHE_PATH,
  SEVEN_DAY_MS,
  SPAWN_LOCK_TTL_MS,
} from "../constants.mjs";
import {
  acquireSpawnLock,
  advanceToNextCycle,
  clampPercent,
  parseRetryAfterMs,
  readJson,
  writeJsonSafe,
} from "../utils.mjs";

export const CLAUDE_USAGE_POLL_BASE_MS = 5_000;
export const CLAUDE_USAGE_POLL_JITTER_RATIO = 0.2;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
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

// 서버가 Retry-After 로 더 기다리라고 하면 따르되, 잘못된 큰 값에 오래 묶이지 않게 1시간에서 자른다.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
function withRetryAfter(pollState, retryAfterMs) {
  if (!retryAfterMs) return pollState;
  return {
    ...pollState,
    delayMs: Math.max(
      pollState.delayMs,
      Math.min(retryAfterMs, MAX_RETRY_AFTER_MS),
    ),
  };
}

function getSnapshotSchedule(cache) {
  const timestamp = Number(cache?.timestamp);
  const nextRefreshAt = Number(cache?.nextRefreshAt);
  // 다음 갱신이 상한보다 멀면 시계가 뒤로 간 것이다. 그대로 두면 갱신이 오래 멈춘다.
  if (
    Number.isFinite(nextRefreshAt) &&
    nextRefreshAt - Date.now() <= MAX_RETRY_AFTER_MS
  ) {
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

function normalizeClaudeCredentials(data, source, supportsUsageApi = true) {
  if (!data) return null;
  const creds = data.claudeAiOauth || data;
  if (!creds.accessToken) return null;
  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    source,
    supportsUsageApi,
  };
}

// 격리된 설정 디렉터리는 기본 Keychain 항목과 다른 서비스 이름을 사용한다.
export function getKeychainServiceName(env = process.env) {
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  let scope = "";
  if (secureDir !== undefined) {
    scope = secureDir ? secureDir.normalize("NFC") : "";
  } else {
    // CLAUDE_CONFIG_DIR은 정규화하지 않고 빈 문자열은 기본값으로 본다.
    scope = env.CLAUDE_CONFIG_DIR || "";
  }
  if (!scope) return CLAUDE_KEYCHAIN_SERVICE;
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const KEYCHAIN_ACCOUNT_FALLBACK = "claude-code-user";

// Claude Code 와 같은 계정 규칙: USER 환경변수 → os.userInfo().username → 허용 문자 밖이면 고정 대체값.
export function getKeychainAccount(env = process.env) {
  let name = null;
  try {
    name = env.USER || userInfo().username;
  } catch {
    name = null;
  }
  if (typeof name !== "string" || !KEYCHAIN_ACCOUNT_PATTERN.test(name)) {
    return KEYCHAIN_ACCOUNT_FALLBACK;
  }
  return name;
}

function readClaudeKeychainRaw(
  serviceName,
  account,
  execFileSyncFn = execFileSync,
) {
  try {
    const raw = execFileSyncFn(
      "security",
      ["find-generic-password", "-s", serviceName, "-a", account, "-w"],
      { encoding: "utf8" },
    );
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

// service와 account를 함께 지정해야 다른 계정의 항목을 읽지 않는다.
export function readClaudeKeychainEntry({
  execFileSyncFn = execFileSync,
  env = process.env,
} = {}) {
  const serviceName = getKeychainServiceName(env);
  const account = getKeychainAccount(env);
  const raw = readClaudeKeychainRaw(serviceName, account, execFileSyncFn);
  return raw ? { raw, account, serviceName } : null;
}

function readClaudeKeychainCredentials(
  execFileSyncFn = execFileSync,
  env = process.env,
) {
  const entry = readClaudeKeychainEntry({ execFileSyncFn, env });
  if (!entry) return null;
  const creds = normalizeClaudeCredentials(entry.raw, "keychain");
  if (!creds) return null;
  // 만료된 항목도 그대로 돌려준다. 호출자가 refreshToken 으로 갱신한 뒤 같은 항목에 되쓴다.
  const lineLength = keychainWriteLine(
    entry.account,
    entry.serviceName,
    entry.raw,
  ).length;
  return {
    ...creds,
    keychainAccount: entry.account,
    keychainWritable:
      lineLength + KEYCHAIN_TOKEN_GROWTH_MARGIN <= KEYCHAIN_STDIN_LINE_LIMIT,
  };
}

// 읽기 순서는 Claude Code 와 같다. macOS 에서는 Keychain 이 정본이고 평문 파일은 Keychain 을 못 쓸 때의
// 폴백이라, 옛 파일이 남아 있어도 Keychain 항목이 있으면 그쪽이 현재 로그인이다.
// 반환값에는 되쓰기 대상을 고정하기 위해 출처 위치(keychainAccount 또는 filePath)를 함께 싣는다.
export function readClaudeCredentials({
  readCredentialFile = (filePath = CLAUDE_CREDENTIALS_PATH) =>
    readJson(filePath, null),
  platform = process.platform,
  execFileSyncFn = execFileSync,
  env = process.env,
} = {}) {
  const tryKeychain = () =>
    platform === "darwin"
      ? readClaudeKeychainCredentials(execFileSyncFn, env)
      : null;

  const tryFile = () => {
    for (const filePath of getClaudeCredentialPaths(env)) {
      try {
        const fileCreds = normalizeClaudeCredentials(
          readCredentialFile(filePath),
          "file",
        );
        if (fileCreds) return { ...fileCreds, filePath };
      } catch {
        /* try next credential source */
      }
    }
    return null;
  };

  const readers =
    platform === "darwin" ? [tryKeychain, tryFile] : [tryFile, tryKeychain];
  for (const read of readers) {
    const creds = read();
    if (creds) return creds;
  }

  if (env.ANTHROPIC_API_KEY) {
    return {
      accessToken: env.ANTHROPIC_API_KEY,
      refreshToken: null,
      expiresAt: null,
      source: "env",
      supportsUsageApi: false,
    };
  }

  return null;
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
          "User-Agent": getClaudeCodeUserAgent(),
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

// 기존 항목의 나머지 필드(scopes, subscriptionType, rateLimitTier, refreshTokenExpiresAt, mcpOAuth 등)를
// 보존하고 토큰 필드만 갈아 끼운다. 저장 형태(claudeAiOauth 래퍼 또는 legacy 평면)는 그대로 둔다.
function mergeClaudeCredentials(creds, existingRaw) {
  const base =
    existingRaw &&
    typeof existingRaw === "object" &&
    !Array.isArray(existingRaw)
      ? existingRaw
      : null;
  const hasWrapper =
    !!base?.claudeAiOauth && typeof base.claudeAiOauth === "object";
  const oauth = {
    ...(hasWrapper ? base.claudeAiOauth : (base ?? {})),
    accessToken: creds.accessToken,
  };
  if (creds.expiresAt != null) oauth.expiresAt = creds.expiresAt;
  if (creds.refreshToken) oauth.refreshToken = creds.refreshToken;
  if (hasWrapper) return { ...base, claudeAiOauth: oauth };
  if (base) return oauth;
  return { claudeAiOauth: oauth };
}

// Claude Code 와 같은 쓰기 경로: 비밀값을 argv 에 두지 않도록 `security -i` 표준입력으로 명령 한 줄을
// 넘기고 payload 는 `-X` 16진수로 싣는다. 한 줄 상한(4032B)을 넘는 큰 항목은 argv 로 넘기면 토큰이
// ps 에 보여서 되쓰지 않는다.
const KEYCHAIN_STDIN_LINE_LIMIT = 4032;
// 갱신 뒤 토큰 길이가 조금 달라져도 상한을 넘지 않도록 둔 여유(글자 수).
const KEYCHAIN_TOKEN_GROWTH_MARGIN = 512;

function keychainWriteLine(account, serviceName, payload) {
  const hex = Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
  return `add-generic-password -U -a "${account}" -s "${serviceName}" -X "${hex}"\n`;
}

function writeClaudeKeychainCredentials(
  creds,
  execFileSyncFn = execFileSync,
  env = process.env,
) {
  const serviceName = getKeychainServiceName(env);
  // 읽어 온 항목(keychainAccount)에 그대로 되쓴다. 현재 USER 와 달라도 다른 계정 항목을 만들지 않는다.
  const account = creds.keychainAccount || getKeychainAccount(env);
  const existingRaw = readClaudeKeychainRaw(
    serviceName,
    account,
    execFileSyncFn,
  );
  const payload = mergeClaudeCredentials(creds, existingRaw);
  const line = keychainWriteLine(account, serviceName, payload);
  if (line.length > KEYCHAIN_STDIN_LINE_LIMIT) {
    process.stderr.write(
      "[hud] Keychain 항목이 커서 갱신한 토큰을 되쓰지 않습니다\n",
    );
    return;
  }
  execFileSyncFn("security", ["-i"], {
    input: line,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

function writeClaudeFileCredentials(
  creds,
  readCredentialFile,
  writeCredentialFile,
) {
  const filePath = creds.filePath || CLAUDE_CREDENTIALS_PATH;
  let data = null;
  try {
    data = readCredentialFile(filePath);
  } catch {
    data = null;
  }
  // 파일이 사라졌으면 새로 만들지 않는다 (Claude Code 가 Keychain 으로 옮긴 뒤 지운 경우)
  if (!data) return;
  writeCredentialFile(mergeClaudeCredentials(creds, data), filePath);
}

// 자격증명을 읽어 온 저장소에만 써서 다른 계정의 토큰을 덮어쓰지 않는다.
export function writeBackClaudeCredentials(
  creds,
  {
    readCredentialFile = (filePath = CLAUDE_CREDENTIALS_PATH) =>
      readJson(filePath, null),
    writeCredentialFile = (data, filePath = CLAUDE_CREDENTIALS_PATH) =>
      writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 }),
    platform = process.platform,
    execFileSyncFn = execFileSync,
    env = process.env,
  } = {},
) {
  if (!creds || creds.source === "env") return;

  if (creds.source === "keychain") {
    if (platform !== "darwin") return;
    try {
      writeClaudeKeychainCredentials(creds, execFileSyncFn, env);
    } catch {
      /* Keychain 쓰기 실패 무시 */
    }
    return;
  }

  if (creds.source === "file") {
    try {
      writeClaudeFileCredentials(
        creds,
        readCredentialFile,
        writeCredentialFile,
      );
    } catch {
      /* 파일 쓰기 실패 무시 */
    }
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
          "User-Agent": getClaudeCodeUserAgent(),
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
            resolve({
              ok: false,
              status: res.statusCode,
              retryAfterMs: parseRetryAfterMs(res.headers?.["retry-after"]),
            });
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
  if (creds.supportsUsageApi === false) {
    writeClaudeUsageCache(null, { type: "auth", status: 0 });
    return existingSnapshot.data || null;
  }

  // 토큰 만료 시 리프레시
  if (creds.expiresAt && creds.expiresAt <= Date.now() && creds.refreshToken) {
    // 되쓰지 못할 갱신은 회전된 refreshToken 을 잃어 Claude Code 로그인을 풀 수 있다. 갱신은 Claude Code 에 맡긴다.
    const refreshed =
      creds.keychainWritable === false
        ? null
        : await refreshClaudeAccessToken(creds.refreshToken);
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
        ? withRetryAfter(
            computeClaudeUsagePollState({
              consecutive429s,
              outcome: "rate_limit",
            }),
            result.retryAfterMs,
          )
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
    if (!acquireSpawnLock(CLAUDE_REFRESH_LOCK_PATH, SPAWN_LOCK_TTL_MS)) return;
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
