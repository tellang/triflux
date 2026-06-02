// ============================================================================
// Gemini 쿼터 API / 세션 토큰 / RPM 트래커
// ============================================================================

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_KEYCHAIN_ACCOUNT,
  ANTIGRAVITY_KEYCHAIN_SERVICE,
  ANTIGRAVITY_MODEL_ABBREV,
  ANTIGRAVITY_OAUTH_PATHS,
  ANTIGRAVITY_SETTINGS_PATH,
  GEMINI_API_TIMEOUT_MS,
  GEMINI_OAUTH_PATH,
  GEMINI_PROJECT_CACHE_PATH,
  GEMINI_QUOTA_CACHE_PATH,
  GEMINI_QUOTA_REFRESH_LOCK_PATH,
  GEMINI_QUOTA_STALE_MS,
  GEMINI_REFRESH_FLAG,
  GEMINI_RPM_TRACKER_PATH,
  GEMINI_RPM_WINDOW_MS,
  GEMINI_SESSION_CACHE_PATH,
  GEMINI_SESSION_REFRESH_FLAG,
  GEMINI_SESSION_REFRESH_LOCK_PATH,
  GEMINI_SESSION_STALE_MS,
  LEGACY_GEMINI_PROJECT_CACHE,
  LEGACY_GEMINI_QUOTA_CACHE,
  LEGACY_GEMINI_RPM_TRACKER,
  LEGACY_GEMINI_SESSION_CACHE,
  SPAWN_LOCK_TTL_MS,
} from "../constants.mjs";
import {
  clampPercent,
  createHttpsPost,
  decodeJwtEmail,
  makeHash,
  readJson,
  readJsonMigrate,
  writeJsonSafe,
} from "../utils.mjs";

const httpsPost = createHttpsPost(https, GEMINI_API_TIMEOUT_MS);

// Gemini 모델별 RPM 한도 (실측 기반: Pro 25, Flash 300)
export function getGeminiRpmLimit(model) {
  if (model?.includes("pro")) return 25;
  return 300; // Flash 기본
}

// Gemini 모델 ID → HUD 표시 라벨 (동적 매핑)
export function getGeminiModelLabel(model) {
  if (!model) return "";
  // 버전 + 티어 추출: gemini-3.1-pro-preview → [3.1Pro], gemini-2.5-flash → [2.5Flash]
  const m = model.match(/gemini-(\d+(?:\.\d+)?)-(\w+)/);
  if (!m) return "";
  const ver = m[1];
  const tier = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  return `[${ver}${tier}]`;
}

// remainingFraction → 사용 퍼센트 변환 (remainingAmount가 있으면 절대값도 제공)
export function deriveGeminiLimits(bucket) {
  if (!bucket) return null;
  // TODO(verify): Workspace quota 응답 모양 라이브 확인 필요
  if (isGeminiUnlimitedBucket(bucket, bucket.remainingFraction)) {
    return {
      unlimited: true,
      usedPct: null,
      remaining: null,
      limit: null,
      resetTime: bucket.resetTime,
      modelId: bucket.modelId,
    };
  }
  if (bucket.remainingFraction == null) return null;
  const fraction = bucket.remainingFraction;
  const usedPct = clampPercent(Math.round((1 - fraction) * 100));
  // remainingAmount가 API에서 오면 절대값 역산 (Gemini CLI 방식)
  if (bucket.remainingAmount != null) {
    const remaining = parseInt(bucket.remainingAmount, 10);
    const limit = fraction > 0 ? Math.round(remaining / fraction) : 0;
    return {
      usedPct,
      remaining,
      limit,
      resetTime: bucket.resetTime,
      modelId: bucket.modelId,
    };
  }
  return {
    usedPct,
    remaining: null,
    limit: null,
    resetTime: bucket.resetTime,
    modelId: bucket.modelId,
  };
}

function isUnlimitedValue(value) {
  if (value === Infinity) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "infinity" || normalized === "unlimited";
}

function isGeminiUnlimitedBucket(bucket, fraction) {
  return (
    bucket?.unlimited === true ||
    isUnlimitedValue(fraction) ||
    isUnlimitedValue(bucket?.limit) ||
    isUnlimitedValue(bucket?.remaining) ||
    isUnlimitedValue(bucket?.remainingAmount)
  );
}

function getCredentialEmail(credential) {
  return (
    decodeJwtEmail(credential?.id_token) ||
    credential?.email ||
    credential?.account?.email ||
    credential?.user?.email ||
    credential?.profile?.email ||
    null
  );
}

export function getGeminiEmail() {
  try {
    const oauth = readJson(GEMINI_OAUTH_PATH, null);
    return getCredentialEmail(oauth);
  } catch {
    return null;
  }
}

export function getAntigravityEmail() {
  for (const oauthPath of ANTIGRAVITY_OAUTH_PATHS) {
    try {
      const oauth = readJson(oauthPath, null);
      const email = getCredentialEmail(oauth);
      if (email) return email;
    } catch {
      // Try the next known Antigravity credential path.
    }
  }
  return null;
}

// agy 1.0.1+ settings.json `model` 필드에서 현재 장착 모델 라벨을 읽는다.
// 예: "Gemini 3.5 Flash (High)". 없으면 null.
export function getAntigravityCurrentModel() {
  const s = readJson(ANTIGRAVITY_SETTINGS_PATH, null);
  return s?.model || null;
}

// 모델 라벨 → 2자 약어 (constants의 ANTIGRAVITY_MODEL_ABBREV 매핑).
// 매핑에 없으면 "<Head> ... (<Level>)" 패턴에서 자동 추출.
export function getAntigravityModelAbbrev(label) {
  if (!label) return "??";
  const known = ANTIGRAVITY_MODEL_ABBREV[label];
  if (known) return known;
  const parens = label.match(/\(([^)]+)\)/);
  const head = label.match(/^(\w+)/);
  if (head && parens) {
    return `${head[1][0].toUpperCase()}${parens[1][0].toLowerCase()}`;
  }
  if (head) return head[1].slice(0, 2);
  return "??";
}

// 모델 라벨 → family ("gemini" | "claude" | "gpt-oss" | "unknown")
// quota 풀이 family 단위로 분리되므로 slot1 데이터 채울지 결정할 때 사용.
export function getAntigravityModelFamily(label) {
  if (!label) return "unknown";
  if (label.startsWith("Gemini")) return "gemini";
  if (label.startsWith("Claude")) return "claude";
  if (label.startsWith("GPT")) return "gpt-oss";
  return "unknown";
}

// Gemini family 통합 quota — 모든 bucket 중 최소 remainingFraction을 가진 bucket을 대표로 반환.
// /usage 실측 (2026-05-22): 4개 모델이 같은 reset window 공유하므로 결과는 사실상 family 단일 카운터.
export function deriveGeminiFamilyBucket(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  let chosen = null;
  for (const b of buckets) {
    if (b?.remainingFraction == null) continue;
    if (!chosen || b.remainingFraction < chosen.remainingFraction) {
      chosen = b;
    }
  }
  return chosen;
}

export function buildGeminiAuthContext(accountId) {
  let oauth = readJson(GEMINI_OAUTH_PATH, null);
  if (!oauth?.access_token) {
    const keychainOAuth = getAntigravityTokenFromKeychain();
    if (keychainOAuth?.access_token) {
      oauth = { ...(oauth || {}), ...keychainOAuth };
    }
  }
  const tokenSource =
    oauth?.refresh_token || oauth?.id_token || oauth?.access_token || "";
  const tokenFingerprint = tokenSource ? makeHash(tokenSource) : "none";
  const cacheKey = `${accountId || "gemini-main"}::${tokenFingerprint}`;
  return { oauth, tokenFingerprint, cacheKey };
}

function firstPresent(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return null;
}

function normalizeExpiryDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeExpiryDate(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeAntigravityCredential(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const accessToken = firstPresent(
    parsed.access_token,
    parsed.accessToken,
    parsed.access?.token,
    parsed.token,
  );
  if (!accessToken) return null;
  const normalized = { ...parsed, access_token: accessToken };
  const idToken = firstPresent(parsed.id_token, parsed.idToken);
  if (idToken) normalized.id_token = idToken;
  const refreshToken = firstPresent(parsed.refresh_token, parsed.refreshToken);
  if (refreshToken) normalized.refresh_token = refreshToken;
  const expiryDate = normalizeExpiryDate(
    firstPresent(
      parsed.expiry_date,
      parsed.expiryDate,
      parsed.expiry,
      parsed.expires_at,
      parsed.expiresAt,
    ),
  );
  if (expiryDate != null) normalized.expiry_date = expiryDate;
  return normalized;
}

function getAntigravityTokenFromKeychain() {
  try {
    const result = spawnSync(
      "security",
      [
        "find-generic-password",
        "-s",
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        "-a",
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status !== 0) return null;
    const stdout = result.stdout?.trim();
    if (!stdout) return null;
    try {
      return normalizeAntigravityCredential(JSON.parse(stdout));
    } catch {
      return { access_token: stdout };
    }
  } catch {
    return null;
  }
}

// ============================================================================
// Gemini 쿼터 API 호출 (5분 캐시)
// ============================================================================
export async function fetchGeminiQuota(accountId, options = {}) {
  const authContext = options.authContext || buildGeminiAuthContext(accountId);
  const { oauth, tokenFingerprint, cacheKey } = authContext;
  const forceRefresh = options.forceRefresh === true;

  // 1. 캐시 확인 (계정/토큰별)
  const cache = readJsonMigrate(
    GEMINI_QUOTA_CACHE_PATH,
    LEGACY_GEMINI_QUOTA_CACHE,
    null,
  );
  if (
    !forceRefresh &&
    cache?.cacheKey === cacheKey &&
    cache?.timestamp &&
    Date.now() - cache.timestamp < GEMINI_QUOTA_STALE_MS
  ) {
    return cache;
  }

  if (!oauth?.access_token) {
    // access_token 없음: 에러 힌트를 캐시에 기록하고 stale 캐시 반환
    writeJsonSafe(GEMINI_QUOTA_CACHE_PATH, {
      ...(cache || {}),
      timestamp: cache?.timestamp || Date.now(),
      error: true,
      errorType: "auth",
      errorHint: "no access_token in oauth_creds.json",
    });
    return cache;
  }
  if (oauth.expiry_date && oauth.expiry_date < Date.now()) {
    // OAuth 토큰 만료: 에러 힌트를 캐시에 기록 (refresh_token 갱신은 Gemini CLI 담당)
    writeJsonSafe(GEMINI_QUOTA_CACHE_PATH, {
      ...(cache || {}),
      timestamp: cache?.timestamp || Date.now(),
      error: true,
      errorType: "auth",
      errorHint: `token expired at ${new Date(oauth.expiry_date).toISOString()}`,
    });
    return cache;
  }

  // 3. projectId (캐시 or API)
  const fetchProjectId = async () => {
    const loadRes = await httpsPost(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      { metadata: { pluginType: "GEMINI" } },
      oauth.access_token,
    );
    const id = loadRes?.cloudaicompanionProject;
    if (id)
      writeJsonSafe(GEMINI_PROJECT_CACHE_PATH, {
        cacheKey,
        projectId: id,
        timestamp: Date.now(),
      });
    return id || null;
  };

  const projCache = readJsonMigrate(
    GEMINI_PROJECT_CACHE_PATH,
    LEGACY_GEMINI_PROJECT_CACHE,
    null,
  );
  let projectId =
    projCache?.cacheKey === cacheKey ? projCache?.projectId : null;
  if (!projectId) projectId = await fetchProjectId();
  if (!projectId) return cache;

  // 4. retrieveUserQuota 호출
  let quotaRes = await httpsPost(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    { project: projectId },
    oauth.access_token,
  );

  // projectId 캐시가 만료/변경된 경우 1회 재시도
  if (!quotaRes?.buckets && projCache?.projectId) {
    projectId = await fetchProjectId();
    if (!projectId) return cache;
    quotaRes = await httpsPost(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      { project: projectId },
      oauth.access_token,
    );
  }

  if (!quotaRes?.buckets) {
    // API 응답에 buckets 없음: 에러 코드 또는 응답 내용을 캐시에 기록
    const apiError =
      quotaRes?.error?.message ||
      quotaRes?.error?.code ||
      quotaRes?.error ||
      "no buckets in response";
    writeJsonSafe(GEMINI_QUOTA_CACHE_PATH, {
      ...(cache || {}),
      timestamp: cache?.timestamp || Date.now(),
      error: true,
      errorType: "api",
      errorHint: String(apiError),
    });
    return cache;
  }

  // 5. 캐시 저장
  const result = {
    timestamp: Date.now(),
    cacheKey,
    accountId: accountId || "gemini-main",
    tokenFingerprint,
    buckets: quotaRes.buckets,
  };
  writeJsonSafe(GEMINI_QUOTA_CACHE_PATH, result);
  return result;
}

/**
 * Gemini RPM 트래커에서 최근 60초 내 요청 수를 읽는다.
 * @returns {{ count: number, percent: number, remainingSec: number }}
 */
export function readGeminiRpm(model) {
  try {
    // 새 경로 → 레거시 경로 fallback
    const rpmPath = existsSync(GEMINI_RPM_TRACKER_PATH)
      ? GEMINI_RPM_TRACKER_PATH
      : existsSync(LEGACY_GEMINI_RPM_TRACKER)
        ? LEGACY_GEMINI_RPM_TRACKER
        : null;
    if (!rpmPath) return { count: 0, percent: 0, remainingSec: 60 };
    const raw = readFileSync(rpmPath, "utf-8");
    const parsed = JSON.parse(raw);
    const timestamps = Array.isArray(parsed.timestamps)
      ? parsed.timestamps
      : [];
    const now = Date.now();
    const recent = timestamps.filter((t) => now - t < GEMINI_RPM_WINDOW_MS);
    const count = recent.length;
    const rpmLimit = getGeminiRpmLimit(model);
    const percent = clampPercent(Math.round((count / rpmLimit) * 100));
    // 가장 오래된 엔트리가 윈도우에서 빠지기까지 남은 초 (0건이면 0s)
    // 5초 단위 반올림으로 HUD 깜빡임 감소
    const rawRemainingSec =
      recent.length > 0
        ? Math.max(
            0,
            Math.ceil(
              (GEMINI_RPM_WINDOW_MS - (now - Math.min(...recent))) / 1000,
            ),
          )
        : 0;
    const remainingSec = Math.ceil(rawRemainingSec / 5) * 5;
    return { count, percent, remainingSec };
  } catch {
    return { count: 0, percent: 0, remainingSec: 60 };
  }
}

export function readGeminiQuotaSnapshot(accountId, authContext) {
  const cache = readJsonMigrate(
    GEMINI_QUOTA_CACHE_PATH,
    LEGACY_GEMINI_QUOTA_CACHE,
    null,
  );
  if (!cache?.buckets) {
    return { quota: null, shouldRefresh: true };
  }

  const cacheKey = authContext.cacheKey;
  const isLegacyCache = !cache.cacheKey;
  const keyMatched = cache.cacheKey === cacheKey;
  const cacheTs = Number(cache.timestamp);
  const ageMs = Number.isFinite(cacheTs)
    ? Date.now() - cacheTs
    : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < GEMINI_QUOTA_STALE_MS;

  if (keyMatched) {
    // resetTime이 지난 버킷의 remainingFraction을 1로 보정 (stale 캐시 방지)
    if (Array.isArray(cache.buckets)) {
      const now = Date.now();
      const patchedBuckets = cache.buckets.map((b) =>
        b?.resetTime && new Date(b.resetTime).getTime() <= now
          ? { ...b, remainingFraction: 1 }
          : b,
      );
      return {
        quota: { ...cache, buckets: patchedBuckets },
        shouldRefresh: !isFresh,
      };
    }
    return { quota: cache, shouldRefresh: !isFresh };
  }
  if (isLegacyCache) {
    return { quota: cache, shouldRefresh: true };
  }
  return { quota: null, shouldRefresh: true };
}

export function scheduleGeminiQuotaRefresh(accountId) {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;

  // 스폰 락: 30초 내 이미 스폰했으면 중복 방지
  try {
    if (existsSync(GEMINI_QUOTA_REFRESH_LOCK_PATH)) {
      const lockAge =
        Date.now() - readJson(GEMINI_QUOTA_REFRESH_LOCK_PATH, {}).t;
      if (lockAge < SPAWN_LOCK_TTL_MS) return;
    }
    writeJsonSafe(GEMINI_QUOTA_REFRESH_LOCK_PATH, { t: Date.now() });
  } catch {
    /* 락 실패 무시 — 스폰 진행 */
  }

  try {
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        GEMINI_REFRESH_FLAG,
        "--account",
        accountId || "gemini-main",
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  } catch (spawnErr) {
    // spawn 실패 시 캐시에 에러 힌트 기록 (다음 HUD 렌더에서 원인 확인 가능)
    writeJsonSafe(GEMINI_QUOTA_CACHE_PATH, {
      timestamp: Date.now(),
      error: true,
      errorHint: String(spawnErr?.message || spawnErr),
    });
  }
}

export function readGeminiSessionSnapshot() {
  const cache = readJsonMigrate(
    GEMINI_SESSION_CACHE_PATH,
    LEGACY_GEMINI_SESSION_CACHE,
    null,
  );
  if (!cache?.session) {
    return { session: null, shouldRefresh: true };
  }
  const ts = Number(cache.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < GEMINI_SESSION_STALE_MS;
  return { session: cache.session, shouldRefresh: !isFresh };
}

export function refreshGeminiSessionCache() {
  const session = scanGeminiSessionTokens();
  if (!session) return null;
  writeJsonSafe(GEMINI_SESSION_CACHE_PATH, { timestamp: Date.now(), session });
  return session;
}

export function scheduleGeminiSessionRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;

  // 스폰 락: 30초 내 이미 스폰했으면 중복 방지
  try {
    if (existsSync(GEMINI_SESSION_REFRESH_LOCK_PATH)) {
      const lockAge =
        Date.now() - readJson(GEMINI_SESSION_REFRESH_LOCK_PATH, {}).t;
      if (lockAge < SPAWN_LOCK_TTL_MS) return;
    }
    writeJsonSafe(GEMINI_SESSION_REFRESH_LOCK_PATH, { t: Date.now() });
  } catch {
    /* 락 실패 무시 — 스폰 진행 */
  }

  try {
    const child = spawn(
      process.execPath,
      [scriptPath, GEMINI_SESSION_REFRESH_FLAG],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  } catch {
    /* 백그라운드 실행 실패 무시 */
  }
}

// ============================================================================
// Gemini 세션 JSON에서 토큰 사용량 추출
// ============================================================================
export function scanGeminiSessionTokens() {
  const tmpDir = join(homedir(), ".gemini", "tmp");
  if (!existsSync(tmpDir)) return null;
  let best = null;
  let bestTime = 0;
  try {
    const dirs = readdirSync(tmpDir).filter((d) =>
      existsSync(join(tmpDir, d, "chats")),
    );
    for (const dir of dirs) {
      const chatsDir = join(tmpDir, dir, "chats");
      let files;
      try {
        files = readdirSync(chatsDir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(chatsDir, file), "utf-8"));
          const updatedAt = new Date(data.lastUpdated || 0).getTime();
          if (updatedAt <= bestTime) continue;
          let input = 0,
            output = 0;
          let model = "unknown";
          for (const msg of data.messages || []) {
            if (msg.tokens) {
              input += msg.tokens.input || 0;
              output += msg.tokens.output || 0;
            }
            if (msg.model) model = msg.model;
          }
          bestTime = updatedAt;
          best = {
            input,
            output,
            total: input + output,
            model,
            lastUpdated: data.lastUpdated,
          };
        } catch {
          /* 무시 */
        }
      }
    }
  } catch {
    /* 무시 */
  }
  return best;
}
