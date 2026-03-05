#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import { spawn, execSync } from "node:child_process";

const VERSION = "1.7";

// ============================================================================
// ANSI 색상 (OMC colors.js 스키마 일치)
// ============================================================================
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const CLAUDE_ORANGE = "\x1b[38;5;214m";
const CODEX_WHITE = "\x1b[97m"; // bright white (SGR 37은 Windows Terminal에서 연회색 매핑)
const GEMINI_BLUE = "\x1b[38;5;39m";

function green(t) { return `${GREEN}${t}${RESET}`; }
function yellow(t) { return `${YELLOW}${t}${RESET}`; }
function red(t) { return `${RED}${t}${RESET}`; }
function cyan(t) { return `${CYAN}${t}${RESET}`; }
function dim(t) { return `${DIM}${t}${RESET}`; }
function bold(t) { return `${BOLD}${t}${RESET}`; }
function claudeOrange(t) { return `${CLAUDE_ORANGE}${t}${RESET}`; }
function codexWhite(t) { return `${CODEX_WHITE}${t}${RESET}`; }
function geminiBlue(t) { return `${GEMINI_BLUE}${t}${RESET}`; }

function colorByPercent(value, text) {
  if (value >= 85) return red(text);
  if (value >= 70) return yellow(text);
  if (value >= 50) return cyan(text);
  return green(text);
}

function colorCooldown(seconds, text) {
  if (seconds > 120) return red(text);
  if (seconds > 0) return yellow(text);
  return dim(text);
}

function colorParallel(current, cap) {
  if (current >= cap) return green(`${current}/${cap}`);
  if (current > 1) return yellow(`${current}/${cap}`);
  return red(`${current}/${cap}`);
}

function coloredBar(percent, width = 8) {
  const safePercent = Math.min(100, Math.max(0, percent));
  const filled = Math.round((safePercent / 100) * width);
  const empty = width - filled;
  let barColor;
  if (safePercent >= 85) barColor = RED;
  else if (safePercent >= 70) barColor = YELLOW;
  else barColor = GREEN;
  return `${barColor}${"█".repeat(filled)}${DIM}${"░".repeat(empty)}${RESET}`;
}

// ============================================================================
// 상수 / 경로
// ============================================================================
const QOS_PATH = join(homedir(), ".omc", "state", "cli_qos_profile.json");
const ACCOUNTS_CONFIG_PATH = join(homedir(), ".omc", "router", "accounts.json");
const ACCOUNTS_STATE_PATH = join(homedir(), ".omc", "state", "cli_accounts_state.json");

// Claude OAuth Usage API (api.anthropic.com/api/oauth/usage)
const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const CLAUDE_USAGE_CACHE_PATH = join(homedir(), ".claude", "cache", "claude-usage-cache.json");
const OMC_PLUGIN_USAGE_CACHE_PATH = join(homedir(), ".claude", "plugins", "oh-my-claudecode", ".usage-cache.json");
const CLAUDE_USAGE_STALE_MS = 5 * 60 * 1000; // 5분 캐시 (OMC 플러그인과 API 충돌 방지)
const CLAUDE_USAGE_429_BACKOFF_MS = 10 * 60 * 1000; // 429 에러 시 10분 backoff
const CLAUDE_USAGE_ERROR_BACKOFF_MS = 3 * 60 * 1000; // 기타 에러 시 3분 backoff
const CLAUDE_API_TIMEOUT_MS = 10_000;
const DEFAULT_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_QUOTA_CACHE_PATH = join(homedir(), ".claude", "cache", "codex-rate-limits-cache.json");
const CODEX_QUOTA_STALE_MS = 15 * 1000; // 15초

// Gemini 쿼터 API 관련
const GEMINI_OAUTH_PATH = join(homedir(), ".gemini", "oauth_creds.json");
const GEMINI_QUOTA_CACHE_PATH = join(homedir(), ".claude", "cache", "gemini-quota-cache.json");
const GEMINI_PROJECT_CACHE_PATH = join(homedir(), ".claude", "cache", "gemini-project-id.json");
const GEMINI_SESSION_CACHE_PATH = join(homedir(), ".claude", "cache", "gemini-session-cache.json");
const GEMINI_RPM_TRACKER_PATH = join(homedir(), ".claude", "cache", "gemini-rpm-tracker.json");
const SV_ACCUMULATOR_PATH = join(homedir(), ".claude", "cache", "sv-accumulator.json");
// 이전 .omc/ 경로 fallback (기존 환경 호환)
const LEGACY_GEMINI_QUOTA_CACHE = join(homedir(), ".omc", "state", "gemini_quota_cache.json");
const LEGACY_GEMINI_PROJECT_CACHE = join(homedir(), ".omc", "state", "gemini_project_id.json");
const LEGACY_GEMINI_SESSION_CACHE = join(homedir(), ".omc", "state", "gemini_session_tokens_cache.json");
const LEGACY_GEMINI_RPM_TRACKER = join(homedir(), ".omc", "state", "gemini_rpm_tracker.json");
const LEGACY_SV_ACCUMULATOR = join(homedir(), ".omc", "state", "sv-accumulator.json");
// Gemini 모델별 RPM 한도 (실측 기반: Pro 25, Flash 300)
function getGeminiRpmLimit(model) {
  if (model && model.includes("pro")) return 25;
  return 300; // Flash 기본
}

// Gemini 모델 ID → HUD 표시 라벨
function getGeminiModelLabel(model) {
  if (!model) return "";
  if (model.includes("pro")) return "[Pro3.1]";
  if (model.includes("flash")) return "[Flash3]";
  return "";
}
const GEMINI_RPM_WINDOW_MS = 60 * 1000; // 60초 슬라이딩 윈도우
const GEMINI_QUOTA_STALE_MS = 5 * 60 * 1000; // 5분
const GEMINI_SESSION_STALE_MS = 15 * 1000; // 15초
const GEMINI_API_TIMEOUT_MS = 3000; // 3초
const ACCOUNT_LABEL_WIDTH = 10;
const PROVIDER_PREFIX_WIDTH = 2;
const PERCENT_CELL_WIDTH = 4;
const TIME_CELL_INNER_WIDTH = 6;
const CLAUDE_REFRESH_FLAG = "--refresh-claude-usage";
const CODEX_REFRESH_FLAG = "--refresh-codex-rate-limits";
const GEMINI_REFRESH_FLAG = "--refresh-gemini-quota";
const GEMINI_SESSION_REFRESH_FLAG = "--refresh-gemini-session";

// ============================================================================
// 모바일/Termux 컴팩트 모드 감지
// ============================================================================
const HUD_CONFIG_PATH = join(homedir(), ".omc", "config", "hud.json");
const COMPACT_COLS_THRESHOLD = 80;
const MINIMAL_COLS_THRESHOLD = 60;

let _cachedColumns = 0;
function getTerminalColumns() {
  if (_cachedColumns > 0) return _cachedColumns;
  if (process.stdout.columns) { _cachedColumns = process.stdout.columns; return _cachedColumns; }
  if (process.stderr.columns) { _cachedColumns = process.stderr.columns; return _cachedColumns; }
  const envCols = Number(process.env.COLUMNS);
  if (envCols > 0) { _cachedColumns = envCols; return _cachedColumns; }
  try {
    if (process.platform === "win32") {
      const raw = execSync("mode con", { timeout: 2000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }).toString();
      const m = raw.match(/Columns[^:]*:\s*(\d+)/i) || raw.match(/열[^:]*:\s*(\d+)/);
      if (m) { _cachedColumns = Number(m[1]); return _cachedColumns; }
    } else {
      const raw = execSync("tput cols 2>/dev/null || stty size 2>/dev/null | awk '{print $2}'", {
        timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      }).toString().trim();
      if (raw && !isNaN(Number(raw))) { _cachedColumns = Number(raw); return _cachedColumns; }
    }
  } catch { /* 감지 실패 */ }
  return 0;
}

function detectCompactMode() {
  // 1. 명시적 CLI 플래그
  if (process.argv.includes("--compact")) return true;
  if (process.argv.includes("--no-compact")) return false;
  // 2. 환경변수 오버라이드
  if (process.env.TERMUX_VERSION) return true;
  if (process.env.OMC_HUD_COMPACT === "1") return true;
  if (process.env.OMC_HUD_COMPACT === "0") return false;
  // 3. 설정 파일 (~/.omc/config/hud.json)
  const hudConfig = readJson(HUD_CONFIG_PATH, null);
  if (hudConfig?.compact === true || hudConfig?.compact === "always") return true;
  if (hudConfig?.compact === false || hudConfig?.compact === "never") return false;
  // 4. maxLines < 3이면 자동 컴팩트 (알림 배너 공존 대응)
  if (Number(hudConfig?.lines) > 0 && Number(hudConfig?.lines) < 3) return true;
  // 5. 터미널 폭 자동 감지 (TTY 있을 때만 유효)
  const threshold = Number(hudConfig?.compactThreshold) || COMPACT_COLS_THRESHOLD;
  const cols = getTerminalColumns();
  if (cols > 0 && cols < threshold) return true;
  return false;
}

const COMPACT_MODE = detectCompactMode();

function detectMinimalMode() {
  // 1. 명시적 CLI 플래그
  if (process.argv.includes("--minimal")) return true;
  // 2. 환경변수
  if (process.env.OMC_HUD_MINIMAL === "1") return true;
  if (process.env.OMC_HUD_MINIMAL === "0") return false;
  // 3. 설정 파일 (~/.omc/config/hud.json)
  const hudConfig = readJson(HUD_CONFIG_PATH, null);
  if (hudConfig?.compact === "minimal") return true;
  // 4. 터미널 폭 자동 감지
  const cols = getTerminalColumns();
  if (cols > 0 && cols < MINIMAL_COLS_THRESHOLD) return true;
  return false;
}

const MINIMAL_MODE = detectMinimalMode();

// ============================================================================
// 유틸
// ============================================================================
async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      resolve({});
    }, 200);
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      const raw = chunks.join("").trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    process.stdin.on("error", () => {
      clearTimeout(timeout);
      resolve({});
    });
    process.stdin.resume();
  });
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try { return JSON.parse(readFileSync(filePath, "utf-8")); } catch { return fallback; }
}

function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data));
  } catch { /* 쓰기 실패 무시 */ }
}

// .omc/ → .claude/cache/ 마이그레이션: 새 경로 우선, 없으면 레거시 읽고 복사
function readJsonMigrate(newPath, legacyPath, fallback) {
  const data = readJson(newPath, null);
  if (data != null) return data;
  const legacy = readJson(legacyPath, null);
  if (legacy != null) { writeJsonSafe(newPath, legacy); return legacy; }
  return fallback;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function padAnsiRight(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

function padAnsiLeft(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return " ".repeat(width - len) + text;
}

function fitText(text, width) {
  const t = String(text || "");
  if (t.length <= width) return t;
  if (width <= 1) return "…";
  return `${t.slice(0, width - 1)}…`;
}

function makeHash(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

function getProviderAccountId(provider, accountsConfig, accountsState) {
  const providerState = accountsState?.providers?.[provider] || {};
  const selectedId = providerState.last_selected_id;
  if (selectedId) return selectedId;
  const providerConfig = accountsConfig?.providers?.[provider] || [];
  return providerConfig[0]?.id || `${provider}-main`;
}

function renderAlignedRows(rows) {
  const rightRows = rows.filter((row) => stripAnsi(String(row.right || "")).trim().length > 0);
  const rawLeftWidth = rightRows.reduce((max, row) => Math.max(max, stripAnsi(row.left).length), 0);
  return rows.map((row) => {
    const prefix = padAnsiRight(row.prefix, PROVIDER_PREFIX_WIDTH);
    const hasRight = stripAnsi(String(row.right || "")).trim().length > 0;
    if (!hasRight) {
      return `${prefix} ${row.left}`;
    }
    // 자기 left 대비 패딩 상한: 최대 2칸까지만 패딩 (과도한 공백 방지)
    const ownLen = stripAnsi(row.left).length;
    const effectiveWidth = Math.min(rawLeftWidth, ownLen + 2);
    const left = padAnsiRight(row.left, effectiveWidth);
    return `${prefix} ${left} ${dim("|")} ${row.right}`;
  });
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function formatPercentCell(value) {
  return `${clampPercent(value)}%`.padStart(PERCENT_CELL_WIDTH, " ");
}

function formatPlaceholderPercentCell() {
  return "--%".padStart(PERCENT_CELL_WIDTH, " ");
}

function normalizeTimeToken(value) {
  const text = String(value || "n/a");
  const hourMinute = text.match(/^(\d+)h(\d+)m$/);
  if (hourMinute) {
    const hours = String(Number(hourMinute[1])).padStart(2, "0");
    const minutes = String(Number(hourMinute[2])).padStart(2, "0");
    return `${hours}h${minutes}m`;
  }
  const dayHour = text.match(/^(\d+)d(\d+)h$/);
  if (dayHour) {
    const days = String(Number(dayHour[1]));
    const hours = String(Number(dayHour[2])).padStart(2, "0");
    return `${days}d${hours}h`;
  }
  return text;
}

function formatTimeCell(value) {
  const text = normalizeTimeToken(value);
  return `(${text.padStart(TIME_CELL_INNER_WIDTH, " ")})`;
}

// 주간(d/h) 전용 — 최대 7d00h(5자)이므로 공백 불필요
function formatTimeCellDH(value) {
  const text = normalizeTimeToken(value);
  return `(${text})`;
}

function getCliArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

function buildGeminiAuthContext(accountId) {
  const oauth = readJson(GEMINI_OAUTH_PATH, null);
  const tokenSource = oauth?.refresh_token || oauth?.id_token || oauth?.access_token || "";
  const tokenFingerprint = tokenSource ? makeHash(tokenSource) : "none";
  const cacheKey = `${accountId || "gemini-main"}::${tokenFingerprint}`;
  return { oauth, tokenFingerprint, cacheKey };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// ============================================================================
// Claude OAuth Usage API (api.anthropic.com/api/oauth/usage)
// ============================================================================
function readClaudeCredentials() {
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

function refreshClaudeAccessToken(refreshToken) {
  return new Promise((resolve) => {
    const clientId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString();
    const req = https.request({
      hostname: "platform.claude.com",
      path: "/v1/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: CLAUDE_API_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
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
          } catch { /* parse 실패 */ }
        }
        resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function writeBackClaudeCredentials(creds) {
  try {
    const data = readJson(CLAUDE_CREDENTIALS_PATH, null);
    if (!data) return;
    const target = data.claudeAiOauth || data;
    target.accessToken = creds.accessToken;
    if (creds.expiresAt != null) target.expiresAt = creds.expiresAt;
    if (creds.refreshToken) target.refreshToken = creds.refreshToken;
    writeFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(data, null, 2));
  } catch { /* 쓰기 실패 무시 */ }
}

function fetchClaudeUsageFromApi(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      timeout: CLAUDE_API_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve({ ok: true, data: JSON.parse(data) }); } catch { resolve({ ok: false, status: 0 }); }
        } else {
          resolve({ ok: false, status: res.statusCode });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, status: 0, error: "network" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, error: "timeout" }); });
    req.end();
  });
}

function parseClaudeUsageResponse(response) {
  const fiveHour = response?.five_hour?.utilization;
  const sevenDay = response?.seven_day?.utilization;
  if (fiveHour == null && sevenDay == null) return null;
  return {
    fiveHourPercent: clampPercent(fiveHour ?? 0),
    weeklyPercent: clampPercent(sevenDay ?? 0),
    fiveHourResetsAt: response?.five_hour?.resets_at || null,
    weeklyResetsAt: response?.seven_day?.resets_at || null,
  };
}

// stale 캐시의 과거 resetsAt → 다음 주기로 순환 추정 (null 대신 다음 reset 시간 계산)
function stripStaleResets(data) {
  if (!data) return data;
  const now = Date.now();
  const copy = { ...data };

  // 5시간 주기: 과거 reset → 5시간씩 전진하여 미래 시점 추정
  if (copy.fiveHourResetsAt) {
    let t = new Date(copy.fiveHourResetsAt).getTime();
    if (t < now) {
      const cycle = 5 * 60 * 60 * 1000;
      const elapsed = now - t;
      t += Math.ceil(elapsed / cycle) * cycle;
      copy.fiveHourResetsAt = new Date(t).toISOString();
    }
  }

  // 7일 주기: 과거 reset → 7일씩 전진하여 미래 시점 추정
  if (copy.weeklyResetsAt) {
    let t = new Date(copy.weeklyResetsAt).getTime();
    if (t < now) {
      const cycle = 7 * 24 * 60 * 60 * 1000;
      const elapsed = now - t;
      t += Math.ceil(elapsed / cycle) * cycle;
      copy.weeklyResetsAt = new Date(t).toISOString();
    }
  }

  return copy;
}

function readClaudeUsageSnapshot() {
  const cache = readJson(CLAUDE_USAGE_CACHE_PATH, null);
  const ts = Number(cache?.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;

  // 1차: 자체 캐시에 유효 데이터가 있는 경우
  if (cache?.data) {
    const isFresh = ageMs < CLAUDE_USAGE_STALE_MS;
    return { data: cache.data, shouldRefresh: !isFresh };
  }

  // 2차: 에러 backoff — 최근 에러 시 재시도 억제 (무한 spawn 방지)
  if (cache?.error && Number.isFinite(ts)) {
    const backoffMs = cache.errorType === "rate_limit"
      ? CLAUDE_USAGE_429_BACKOFF_MS
      : CLAUDE_USAGE_ERROR_BACKOFF_MS;
    if (ageMs < backoffMs) {
      const omcCache = readJson(OMC_PLUGIN_USAGE_CACHE_PATH, null);
      // OMC 캐시가 에러 이후 갱신되었으면 → 에러 캐시 덮어쓰고 그 데이터 사용
      if (omcCache?.data?.fiveHourPercent != null && omcCache.timestamp > ts) {
        writeClaudeUsageCache(omcCache.data);
        return { data: omcCache.data, shouldRefresh: false };
      }
      // stale OMC fallback 또는 기본 0%
      const staleData = omcCache?.data?.fiveHourPercent != null ? stripStaleResets(omcCache.data) : null;
      const fallback = staleData || { fiveHourPercent: 0, weeklyPercent: 0, fiveHourResetsAt: null, weeklyResetsAt: null };
      return { data: fallback, shouldRefresh: false };
    }
  }

  // 3차: OMC 플러그인 캐시 (같은 API 데이터, 중복 호출 방지)
  const OMC_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
  const omcCache = readJson(OMC_PLUGIN_USAGE_CACHE_PATH, null);
  if (omcCache?.data?.fiveHourPercent != null) {
    const omcAge = Number.isFinite(omcCache.timestamp) ? Date.now() - omcCache.timestamp : Number.MAX_SAFE_INTEGER;
    if (omcAge < OMC_CACHE_MAX_AGE_MS) {
      writeClaudeUsageCache(omcCache.data);
      return { data: omcCache.data, shouldRefresh: omcAge > CLAUDE_USAGE_STALE_MS };
    }
    // stale이어도 data: null보다는 오래된 데이터를 fallback으로 표시
    return { data: stripStaleResets(omcCache.data), shouldRefresh: true };
  }

  // 캐시/fallback 모두 없음: 기본 0% 표시 + 리프레시 시도 (--% 방지)
  return { data: { fiveHourPercent: 0, weeklyPercent: 0, fiveHourResetsAt: null, weeklyResetsAt: null }, shouldRefresh: true };
}

function writeClaudeUsageCache(data, errorInfo = null) {
  writeJsonSafe(CLAUDE_USAGE_CACHE_PATH, {
    timestamp: Date.now(),
    data,
    error: !!errorInfo,
    errorType: errorInfo?.type || null,   // "rate_limit" | "auth" | "network" | "unknown"
    errorStatus: errorInfo?.status || null, // HTTP 상태 코드
  });
}

async function fetchClaudeUsage(forceRefresh = false) {
  const existingSnapshot = readClaudeUsageSnapshot();
  if (!forceRefresh && !existingSnapshot.shouldRefresh && existingSnapshot.data) {
    return existingSnapshot.data;
  }
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
    const errorType = result.status === 429 ? "rate_limit"
      : result.status === 401 || result.status === 403 ? "auth"
      : result.error === "timeout" || result.error === "network" ? "network"
      : "unknown";
    writeClaudeUsageCache(null, { type: errorType, status: result.status });
    return existingSnapshot.data || null;
  }
  const usage = parseClaudeUsageResponse(result.data);
  writeClaudeUsageCache(usage, usage ? null : { type: "unknown", status: 0 });
  return usage;
}

function scheduleClaudeUsageRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;

  // OMC 플러그인이 이미 fresh 데이터를 가지고 있으면 HUD 리프레시 불필요 (429 방지)
  try {
    const omcCache = readJson(OMC_PLUGIN_USAGE_CACHE_PATH, null);
    if (omcCache?.data?.fiveHourPercent != null) {
      const omcAge = Number.isFinite(omcCache.timestamp) ? Date.now() - omcCache.timestamp : Infinity;
      if (omcAge < CLAUDE_USAGE_STALE_MS) {
        writeClaudeUsageCache(omcCache.data); // HUD 캐시에 복사만
        return;
      }
    }
  } catch { /* 무시 */ }

  // 스폰 락: 30초 내 이미 스폰했으면 중복 방지 (첫 설치 시 429 방지)
  const lockPath = join(homedir(), ".claude", "cache", ".claude-refresh-lock");
  try {
    if (existsSync(lockPath)) {
      const lockAge = Date.now() - readJson(lockPath, {}).t;
      if (lockAge < 30000) return; // 30초 이내 스폰 이력 → 건너뜀
    }
    writeJsonSafe(lockPath, { t: Date.now() });
  } catch { /* 락 실패 무시 — 스폰 진행 */ }

  try {
    const child = spawn(process.execPath, [scriptPath, CLAUDE_REFRESH_FLAG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch { /* 백그라운드 실행 실패 무시 */ }
}

function getContextPercent(stdin) {
  const nativePercent = stdin?.context_window?.used_percentage;
  if (typeof nativePercent === "number" && Number.isFinite(nativePercent)) return clampPercent(nativePercent);
  const usage = stdin?.context_window?.current_usage || {};
  const totalTokens = Number(usage.input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0);
  const capacity = Number(stdin?.context_window?.context_window_size || 0);
  if (!capacity || capacity <= 0) return 0;
  return clampPercent((totalTokens / capacity) * 100);
}

function formatResetRemaining(isoOrUnix) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "00h00m";
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(totalHours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}m`;
}

function isResetPast(isoOrUnix) {
  if (!isoOrUnix) return false;
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  return !isNaN(d.getTime()) && d.getTime() <= Date.now();
}

function formatResetRemainingDayHour(isoOrUnix) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "0d00h";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  return `${days}d${String(hours).padStart(2, "0")}h`;
}

function calcCooldownLeftSeconds(isoDatetime) {
  if (!isoDatetime) return 0;
  const cooldownMs = new Date(isoDatetime).getTime() - Date.now();
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return 0;
  return Math.ceil(cooldownMs / 1000);
}

// ============================================================================
// HTTPS POST (타임아웃 포함)
// ============================================================================
function httpsPost(url, body, accessToken) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: GEMINI_API_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

// ============================================================================
// Codex JWT에서 이메일 추출
// ============================================================================
function getCodexEmail() {
  try {
    const auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8"));
    const idToken = auth?.tokens?.id_token;
    if (!idToken) return null;
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded.email || null;
  } catch { return null; }
}

// ============================================================================
// Gemini JWT에서 이메일 추출
// ============================================================================
function getGeminiEmail() {
  try {
    const oauth = readJson(GEMINI_OAUTH_PATH, null);
    const idToken = oauth?.id_token;
    if (!idToken) return null;
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded.email || null;
  } catch { return null; }
}

// ============================================================================
// Codex 세션 JSONL에서 실제 rate limits 추출
// ============================================================================
function getCodexRateLimits() {
  const now = new Date();
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
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
    for (const file of files) {
      try {
        const content = readFileSync(join(sessDir, file), "utf-8");
        const lines = content.trim().split("\n").reverse();
        const buckets = {};
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            const rl = evt?.payload?.rate_limits;
            if (rl?.limit_id && !buckets[rl.limit_id]) {
              buckets[rl.limit_id] = {
                limitId: rl.limit_id, limitName: rl.limit_name,
                primary: rl.primary, secondary: rl.secondary,
                credits: rl.credits,
                tokens: evt.payload?.info?.total_token_usage,
                contextWindow: evt.payload?.info?.model_context_window,
                timestamp: evt.timestamp,
              };
            }
          } catch { /* 라인 파싱 실패 무시 */ }
          if (Object.keys(buckets).length >= 2) break;
        }
        if (Object.keys(buckets).length > 0) return buckets;
      } catch { /* 파일 읽기 실패 무시 */ }
    }
  }
  return null;
}

// ============================================================================
// Gemini 쿼터 API 호출 (5분 캐시)
// ============================================================================
async function fetchGeminiQuota(accountId, options = {}) {
  const authContext = options.authContext || buildGeminiAuthContext(accountId);
  const { oauth, tokenFingerprint, cacheKey } = authContext;
  const forceRefresh = options.forceRefresh === true;

  // 1. 캐시 확인 (계정/토큰별)
  const cache = readJsonMigrate(GEMINI_QUOTA_CACHE_PATH, LEGACY_GEMINI_QUOTA_CACHE, null);
  if (!forceRefresh
    && cache?.cacheKey === cacheKey
    && cache?.timestamp
    && (Date.now() - cache.timestamp < GEMINI_QUOTA_STALE_MS)) {
    return cache;
  }

  if (!oauth?.access_token) return cache;
  if (oauth.expiry_date && oauth.expiry_date < Date.now()) return cache; // 만료 시 stale 캐시

  // 3. projectId (캐시 or API)
  const fetchProjectId = async () => {
    const loadRes = await httpsPost(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      { metadata: { pluginType: "GEMINI" } },
      oauth.access_token,
    );
    const id = loadRes?.cloudaicompanionProject;
    if (id) writeJsonSafe(GEMINI_PROJECT_CACHE_PATH, { cacheKey, projectId: id, timestamp: Date.now() });
    return id || null;
  };

  const projCache = readJsonMigrate(GEMINI_PROJECT_CACHE_PATH, LEGACY_GEMINI_PROJECT_CACHE, null);
  let projectId = projCache?.cacheKey === cacheKey ? projCache?.projectId : null;
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

  if (!quotaRes?.buckets) return cache;

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
function readGeminiRpm(model) {
  try {
    // 새 경로 → 레거시 경로 fallback
    const rpmPath = existsSync(GEMINI_RPM_TRACKER_PATH) ? GEMINI_RPM_TRACKER_PATH
      : existsSync(LEGACY_GEMINI_RPM_TRACKER) ? LEGACY_GEMINI_RPM_TRACKER : null;
    if (!rpmPath) return { count: 0, percent: 0, remainingSec: 60 };
    const raw = readFileSync(rpmPath, "utf-8");
    const parsed = JSON.parse(raw);
    const timestamps = Array.isArray(parsed.timestamps) ? parsed.timestamps : [];
    const now = Date.now();
    const recent = timestamps.filter((t) => now - t < GEMINI_RPM_WINDOW_MS);
    const count = recent.length;
    const rpmLimit = getGeminiRpmLimit(model);
    const percent = clampPercent(Math.round((count / rpmLimit) * 100));
    // 가장 오래된 엔트리가 윈도우에서 빠지기까지 남은 초
    // 가장 오래된 엔트리가 윈도우에서 빠지기까지 남은 초 (0건이면 0s)
    // 5초 단위 반올림으로 HUD 깜빡임 감소
    const rawRemainingSec = recent.length > 0
      ? Math.max(0, Math.ceil((GEMINI_RPM_WINDOW_MS - (now - Math.min(...recent))) / 1000))
      : 0;
    const remainingSec = Math.ceil(rawRemainingSec / 5) * 5;
    return { count, percent, remainingSec };
  } catch {
    return { count: 0, percent: 0, remainingSec: 60 };
  }
}

function readGeminiQuotaSnapshot(accountId, authContext) {
  const cache = readJsonMigrate(GEMINI_QUOTA_CACHE_PATH, LEGACY_GEMINI_QUOTA_CACHE, null);
  if (!cache?.buckets) {
    return { quota: null, shouldRefresh: true };
  }

  const cacheKey = authContext.cacheKey;
  const isLegacyCache = !cache.cacheKey;
  const keyMatched = cache.cacheKey === cacheKey;
  const cacheTs = Number(cache.timestamp);
  const ageMs = Number.isFinite(cacheTs) ? Date.now() - cacheTs : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < GEMINI_QUOTA_STALE_MS;

  if (keyMatched) {
    return { quota: cache, shouldRefresh: !isFresh };
  }
  if (isLegacyCache) {
    return { quota: cache, shouldRefresh: true };
  }
  return { quota: null, shouldRefresh: true };
}

function scheduleGeminiQuotaRefresh(accountId) {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;
  try {
    const child = spawn(
      process.execPath,
      [scriptPath, GEMINI_REFRESH_FLAG, "--account", accountId || "gemini-main"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  } catch { /* 백그라운드 실행 실패 무시 */ }
}

function readCodexRateLimitSnapshot() {
  const cache = readJson(CODEX_QUOTA_CACHE_PATH, null);
  if (!cache?.buckets) {
    return { buckets: null, shouldRefresh: true };
  }
  const ts = Number(cache.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < CODEX_QUOTA_STALE_MS;
  return { buckets: cache.buckets, shouldRefresh: !isFresh };
}

function refreshCodexRateLimitsCache() {
  const buckets = getCodexRateLimits();
  if (!buckets) return null;
  writeJsonSafe(CODEX_QUOTA_CACHE_PATH, { timestamp: Date.now(), buckets });
  return buckets;
}

function scheduleCodexRateLimitRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;
  try {
    const child = spawn(process.execPath, [scriptPath, CODEX_REFRESH_FLAG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch { /* 백그라운드 실행 실패 무시 */ }
}

function readGeminiSessionSnapshot() {
  const cache = readJsonMigrate(GEMINI_SESSION_CACHE_PATH, LEGACY_GEMINI_SESSION_CACHE, null);
  if (!cache?.session) {
    return { session: null, shouldRefresh: true };
  }
  const ts = Number(cache.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < GEMINI_SESSION_STALE_MS;
  return { session: cache.session, shouldRefresh: !isFresh };
}

function refreshGeminiSessionCache() {
  const session = scanGeminiSessionTokens();
  if (!session) return null;
  writeJsonSafe(GEMINI_SESSION_CACHE_PATH, { timestamp: Date.now(), session });
  return session;
}

function scheduleGeminiSessionRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;
  try {
    const child = spawn(process.execPath, [scriptPath, GEMINI_SESSION_REFRESH_FLAG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch { /* 백그라운드 실행 실패 무시 */ }
}

// ============================================================================
// Gemini 세션 JSON에서 토큰 사용량 추출
// ============================================================================
function scanGeminiSessionTokens() {
  const tmpDir = join(homedir(), ".gemini", "tmp");
  if (!existsSync(tmpDir)) return null;
  let best = null;
  let bestTime = 0;
  try {
    const dirs = readdirSync(tmpDir).filter((d) => existsSync(join(tmpDir, d, "chats")));
    for (const dir of dirs) {
      const chatsDir = join(tmpDir, dir, "chats");
      let files;
      try { files = readdirSync(chatsDir).filter((f) => f.endsWith(".json")); } catch { continue; }
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(chatsDir, file), "utf-8"));
          const updatedAt = new Date(data.lastUpdated || 0).getTime();
          if (updatedAt <= bestTime) continue;
          let input = 0, output = 0;
          let model = "unknown";
          for (const msg of data.messages || []) {
            if (msg.tokens) { input += msg.tokens.input || 0; output += msg.tokens.output || 0; }
            if (msg.model) model = msg.model;
          }
          bestTime = updatedAt;
          best = { input, output, total: input + output, model, lastUpdated: data.lastUpdated };
        } catch { /* 무시 */ }
      }
    }
  } catch { /* 무시 */ }
  return best;
}

// ============================================================================
// 라인 렌더러
// ============================================================================
// 토큰 절약액 누적치 읽기 (tfx-auto token tracker)
function readTokenSavings() {
  const savingsPath = join(homedir(), ".omc", "state", "tfx-auto-tokens", "savings-total.json");
  const data = readJson(savingsPath, null);
  if (!data || data.totalSaved === 0) return null;
  return data;
}

// sv-accumulator.json에서 누적 토큰/비용 읽기
function readSvAccumulator() {
  return readJsonMigrate(SV_ACCUMULATOR_PATH, LEGACY_SV_ACCUMULATOR, null);
}

function formatSavings(dollars) {
  if (dollars >= 100) return `$${Math.round(dollars)}`;
  if (dollars >= 10) return `$${dollars.toFixed(1)}`;
  return `$${dollars.toFixed(2)}`;
}

function getClaudeRows(stdin, claudeUsage, totalSvDollar) {
  const contextPercent = getContextPercent(stdin);
  const prefix = `${bold(claudeOrange("c"))}:`;

  // 절약 달러 누적 (Codex+Gemini 합산)
  const svText = totalSvDollar > 0 ? formatSavings(totalSvDollar) : "$0";
  const svSuffix = `${dim("sv:")}${cyan(svText.padStart(6))}`;

  // API 실측 데이터 사용 (없으면 플레이스홀더)
  const fiveHourPercent = claudeUsage?.fiveHourPercent ?? 0;
  const weeklyPercent = claudeUsage?.weeklyPercent ?? 0;
  const fiveHourReset = claudeUsage?.fiveHourResetsAt
    ? formatResetRemaining(claudeUsage.fiveHourResetsAt)
    : (claudeUsage ? "n/a" : "--h--m");
  const weeklyReset = claudeUsage?.weeklyResetsAt
    ? formatResetRemainingDayHour(claudeUsage.weeklyResetsAt)
    : (claudeUsage ? "n/a" : "--d--h");

  const hasData = claudeUsage != null;

  if (MINIMAL_MODE) {
    const cols = getTerminalColumns() || 80;
    if (!hasData) {
      const quotaSection = cols < 40
        ? `${dim("--%/--%")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`
        : `${dim("5h --% 1w --% sv:-- ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
      return [{ prefix, left: quotaSection, right: "" }];
    }
    if (cols < 40) {
      // 초소형: c: 12%/8% ctx:45%
      const quotaSection = `${colorByPercent(fiveHourPercent, `${fiveHourPercent}%`)}${dim("/")}` +
        `${colorByPercent(weeklyPercent, `${weeklyPercent}%`)} ` +
        `${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
      return [{ prefix, left: quotaSection, right: "" }];
    }
    // minimal: c: 5h 12% 1w 8% sv:$16.57 ctx:45%
    const svCompact = `${dim("sv:")}${cyan(svText)}`;
    const quotaSection = `${dim("5h")} ${colorByPercent(fiveHourPercent, `${fiveHourPercent}%`)} ` +
      `${dim("1w")} ${colorByPercent(weeklyPercent, `${weeklyPercent}%`)} ` +
      `${svCompact} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  if (COMPACT_MODE) {
    // 데이터 없을 때: 전체 dim 처리 (green 0% 대신)
    if (!hasData) {
      const quotaSection = `${dim("5h: --% 1w: --% ")}` +
        `${svSuffix} ${dim("|")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
      return [{ prefix, left: quotaSection, right: "" }];
    }
    const quotaSection = `${dim("5h:")}${colorByPercent(fiveHourPercent, `${fiveHourPercent}%`)} ` +
      `${dim("1w:")}${colorByPercent(weeklyPercent, `${weeklyPercent}%`)} ` +
      `${svSuffix} ${dim("|")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  // 데이터 없을 때: 퍼센트+시간 모두 dim 처리 (green 0% 대신)
  if (!hasData) {
    const quotaSection = `${dim("5h:")}${dim(formatPlaceholderPercentCell())} ` +
      `${dim(formatTimeCell(fiveHourReset))} ` +
      `${dim("1w:")}${dim(formatPlaceholderPercentCell())} ` +
      `${dim(formatTimeCellDH(weeklyReset))}`;
    const contextSection = `${svSuffix} ${dim("|")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: contextSection }];
  }

  const fiveHourPercentCell = formatPercentCell(fiveHourPercent);
  const weeklyPercentCell = formatPercentCell(weeklyPercent);
  const fiveHourTimeCell = formatTimeCell(fiveHourReset);
  const weeklyTimeCell = formatTimeCellDH(weeklyReset);
  const quotaSection = `${dim("5h:")}${colorByPercent(fiveHourPercent, fiveHourPercentCell)} ` +
    `${dim(fiveHourTimeCell)} ` +
    `${dim("1w:")}${colorByPercent(weeklyPercent, weeklyPercentCell)} ` +
    `${dim(weeklyTimeCell)}`;
  const contextSection = `${svSuffix} ${dim("|")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
  return [{ prefix, left: quotaSection, right: contextSection }];
}

function getAccountLabel(provider, accountsConfig, accountsState, codexEmail) {
  const providerConfig = accountsConfig?.providers?.[provider] || [];
  const providerState = accountsState?.providers?.[provider] || {};
  const lastId = providerState.last_selected_id;
  const picked = providerConfig.find((a) => a.id === lastId) || providerConfig[0]
    || { id: `${provider}-main`, label: provider };
  let label = picked.label || picked.id;
  if (codexEmail) label = codexEmail;
  if (label.includes("@")) label = label.split("@")[0];
  return label;
}

function getProviderRow(provider, marker, markerColor, qosProfile, accountsConfig, accountsState, realQuota, codexEmail, savingsMultiplier, modelLabel) {
  const accountLabel = fitText(getAccountLabel(provider, accountsConfig, accountsState, codexEmail), ACCOUNT_LABEL_WIDTH);

  // 절약 퍼센트 섹션 (context window 대비 %, 4자리 고정폭)
  const svPct = savingsMultiplier != null ? Math.round(savingsMultiplier * 100) : null;
  const svStr = svPct != null ? `${svPct}%`.padStart(6) : "--%".padStart(6);
  const modelLabelStr = modelLabel ? ` ${markerColor(modelLabel)}` : "";

  // ── 쿼터 섹션 ──
  let quotaSection;
  let extraRightSection = "";

  if (MINIMAL_MODE) {
    const cols = getTerminalColumns() || 80;
    const minPrefix = `${bold(markerColor(`${marker}`))}:`;
    const svCompact = svStr ? ` ${dim("sv:")}${cyan(svStr.trim())}` : "";
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP = isResetPast(main.primary?.resets_at) ? 0 : clampPercent(main.primary?.used_percent ?? 0);
        const weekP = isResetPast(main.secondary?.resets_at) ? 0 : clampPercent(main.secondary?.used_percent ?? 0);
        if (cols < 40) {
          return { prefix: minPrefix, left: `${colorByPercent(fiveP, `${fiveP}%`)}${dim("/")}${colorByPercent(weekP, `${weekP}%`)}${svCompact}`, right: "" };
        }
        return { prefix: minPrefix, left: `${dim("5h")} ${colorByPercent(fiveP, `${fiveP}%`)} ${dim("1w")} ${colorByPercent(weekP, `${weekP}%`)}${svCompact}`, right: "" };
      }
    }
    if (realQuota?.type === "gemini") {
      const bucket = realQuota.quotaBucket;
      if (bucket) {
        const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
        if (cols < 40) {
          return { prefix: minPrefix, left: `${colorByPercent(usedP, `${usedP}%`)}${svCompact}${modelLabelStr}`, right: "" };
        }
        return { prefix: minPrefix, left: `${dim("1d")} ${colorByPercent(usedP, `${usedP}%`)} ${dim("1w")} ${bold("\u221E%")}${svCompact}${modelLabelStr}`, right: "" };
      }
    }
    return { prefix: minPrefix, left: dim("--%"), right: "" };
  }

  if (COMPACT_MODE) {
    // 컴팩트 모드: 바 없이 퍼센트만, right 섹션 생략
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP = isResetPast(main.primary?.resets_at) ? 0 : clampPercent(main.primary?.used_percent ?? 0);
        const weekP = isResetPast(main.secondary?.resets_at) ? 0 : clampPercent(main.secondary?.used_percent ?? 0);
        quotaSection = `${dim("5h:")}${colorByPercent(fiveP, `${fiveP}%`)} ` +
          `${dim("1w:")}${colorByPercent(weekP, `${weekP}%`)}`;
      }
    }
    if (realQuota?.type === "gemini") {
      const bucket = realQuota.quotaBucket;
      if (bucket) {
        const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
        quotaSection = `${dim("1d:")}${colorByPercent(usedP, `${usedP}%`)} ${dim("1w:")}${bold("\u221E%")}`;
      } else {
        quotaSection = `${dim("1d:")}${dim("--%")} ${dim("1w:")}${bold("\u221E%")}`;
      }
    }
    if (!quotaSection) {
      quotaSection = `${dim("5h:")}${green("0%")} ${dim("1w:")}${green("0%")}`;
    }
    const prefix = `${bold(markerColor(`${marker}`))}:`;
    const compactRight = [svStr ? `${dim("sv:")}${svStr}` : "", modelLabel ? markerColor(modelLabel) : ""].filter(Boolean).join(" ");
    return { prefix, left: quotaSection, right: compactRight };
  }

  if (realQuota?.type === "codex") {
    const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
    if (main) {
      const fiveP = isResetPast(main.primary?.resets_at) ? 0 : clampPercent(main.primary?.used_percent ?? 0);
      const weekP = isResetPast(main.secondary?.resets_at) ? 0 : clampPercent(main.secondary?.used_percent ?? 0);
      const fiveReset = formatResetRemaining(main.primary?.resets_at) || "n/a";
      const weekReset = formatResetRemainingDayHour(main.secondary?.resets_at) || "n/a";
      quotaSection = `${dim("5h:")}${colorByPercent(fiveP, formatPercentCell(fiveP))} ` +
        `${dim(formatTimeCell(fiveReset))} ` +
        `${dim("1w:")}${colorByPercent(weekP, formatPercentCell(weekP))} ` +
        `${dim(formatTimeCellDH(weekReset))}`;
    }
  }

  if (realQuota?.type === "gemini") {
    const bucket = realQuota.quotaBucket;
    if (bucket) {
      const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
      const rstRemaining = formatResetRemaining(bucket.resetTime) || "n/a";
      quotaSection = `${dim("1d:")}${colorByPercent(usedP, formatPercentCell(usedP))} ${dim(formatTimeCell(rstRemaining))} ` +
        `${dim("1w:")}${bold("\u221E%".padStart(PERCENT_CELL_WIDTH))} ${dim(formatTimeCellDH("-d--h"))}`;
    } else {
      quotaSection = `${dim("1d:")}${dim(formatPlaceholderPercentCell())} ` +
        `${dim(formatTimeCell("--h--m"))} ${dim("1w:")}${bold("\u221E%".padStart(PERCENT_CELL_WIDTH))} ${dim(formatTimeCellDH("-d--h"))}`;
    }
  }

  // 폴백: 쿼터 데이터 없을 때
  if (!quotaSection) {
    quotaSection = `${dim("5h:")}${dim("--%")} ${dim("1w:")}${dim("--%")}`;
  }

  const prefix = `${bold(markerColor(`${marker}`))}:`;
  const accountSection = `${markerColor(accountLabel)}`;
  const svSection = svStr ? `${dim("sv:")}${svStr}` : "";
  const modelLabelSection = modelLabel ? markerColor(modelLabel) : "";
  const rightParts = [svSection, accountSection, modelLabelSection].filter(Boolean);
  return {
    prefix,
    left: quotaSection,
    right: rightParts.join(` ${dim("|")} `),
  };
}

// ============================================================================
// 메인
// ============================================================================
async function main() {
  // 백그라운드 Claude 사용량 리프레시
  if (process.argv.includes(CLAUDE_REFRESH_FLAG)) {
    await fetchClaudeUsage(true);
    return;
  }

  if (process.argv.includes(CODEX_REFRESH_FLAG)) {
    refreshCodexRateLimitsCache();
    return;
  }

  if (process.argv.includes(GEMINI_SESSION_REFRESH_FLAG)) {
    refreshGeminiSessionCache();
    return;
  }

  // 백그라운드 Gemini 쿼터 리프레시 전용 실행 모드
  if (process.argv.includes(GEMINI_REFRESH_FLAG)) {
    const accountId = getCliArgValue("--account") || "gemini-main";
    const authContext = buildGeminiAuthContext(accountId);
    await fetchGeminiQuota(accountId, { authContext, forceRefresh: true });
    return;
  }

  // 메인 HUD 경로: 즉시 렌더 우선
  const stdinPromise = readStdinJson();

  const qosProfile = readJson(QOS_PATH, { providers: {} });
  const accountsConfig = readJson(ACCOUNTS_CONFIG_PATH, { providers: {} });
  const accountsState = readJson(ACCOUNTS_STATE_PATH, { providers: {} });
  const claudeUsageSnapshot = readClaudeUsageSnapshot();
  if (claudeUsageSnapshot.shouldRefresh) {
    scheduleClaudeUsageRefresh();
  }
  const geminiAccountId = getProviderAccountId("gemini", accountsConfig, accountsState);
  const codexSnapshot = readCodexRateLimitSnapshot();
  const geminiSessionSnapshot = readGeminiSessionSnapshot();
  const geminiAuthContext = buildGeminiAuthContext(geminiAccountId);
  const geminiQuotaSnapshot = readGeminiQuotaSnapshot(geminiAccountId, geminiAuthContext);
  if (codexSnapshot.shouldRefresh) {
    scheduleCodexRateLimitRefresh();
  }
  if (geminiSessionSnapshot.shouldRefresh) {
    scheduleGeminiSessionRefresh();
  }
  if (geminiQuotaSnapshot.shouldRefresh) {
    scheduleGeminiQuotaRefresh(geminiAccountId);
  }

  // 실측 데이터 추출
  const stdin = await stdinPromise;
  const codexEmail = getCodexEmail();
  const geminiEmail = getGeminiEmail();
  const codexBuckets = codexSnapshot.buckets;
  const geminiSession = geminiSessionSnapshot.session;
  const geminiQuota = geminiQuotaSnapshot.quota;

  // 누적 절약 데이터 읽기
  const svSavings = readTokenSavings();
  const svAccumulator = readSvAccumulator();
  const totalCostSaved = svSavings?.totalSaved || svAccumulator?.totalCostSaved || 0;

  // 세션/누적 토큰 → context 대비 절약 배수 (개별 provider sv%)
  const ctxCapacity = stdin?.context_window?.context_window_size || 200000;
  let codexSv = null;
  if (svAccumulator?.codex?.tokens > 0) {
    codexSv = svAccumulator.codex.tokens / ctxCapacity;
  } else if (codexBuckets) {
    const main = codexBuckets.codex || codexBuckets[Object.keys(codexBuckets)[0]];
    if (main?.tokens?.total_tokens) codexSv = main.tokens.total_tokens / ctxCapacity;
  }
  let geminiSv = null;
  if (svAccumulator?.gemini?.tokens > 0) {
    geminiSv = svAccumulator.gemini.tokens / ctxCapacity;
  } else {
    const geminiTokens = geminiSession?.total || null;
    geminiSv = geminiTokens ? geminiTokens / ctxCapacity : null;
  }

  // Gemini: 사용 중인 모델의 쿼터 버킷 찾기
  const geminiModel = geminiSession?.model || "gemini-3-flash-preview";
  const geminiBucket = geminiQuota?.buckets?.find((b) => b.modelId === geminiModel)
    || geminiQuota?.buckets?.find((b) => b.modelId === "gemini-3-flash-preview")
    || null;

  // 합산 절약: 달러 누적 (getClaudeRows에서 $ 포맷)
  const totalSvDollar = totalCostSaved;

  const rows = [
    ...getClaudeRows(stdin, claudeUsageSnapshot.data, totalSvDollar),
    getProviderRow("codex", "x", codexWhite, qosProfile, accountsConfig, accountsState,
      codexBuckets ? { type: "codex", buckets: codexBuckets } : null, codexEmail,
      codexSv, null),
    getProviderRow("gemini", "g", geminiBlue, qosProfile, accountsConfig, accountsState,
      { type: "gemini", quotaBucket: geminiBucket, session: geminiSession }, geminiEmail,
      geminiSv, getGeminiModelLabel(geminiModel)),
  ];
  let outputLines = renderAlignedRows(rows);
  // maxLines 설정: 알림 배너와 공존할 때 라인 수 제한 (hud.json의 lines 값)
  const maxLines = Number(readJson(HUD_CONFIG_PATH, null)?.lines) || 0;
  if (maxLines > 0 && outputLines.length > maxLines) {
    while (outputLines.length > maxLines) {
      const last = outputLines.pop();
      outputLines[outputLines.length - 1] += `  ${last.trim()}`;
    }
  }
  // Context low 메시지 뒤에 HUD가 분리되도록 선행 개행 추가
  const contextPercent = getContextPercent(stdin);
  const contextLowPrefix = contextPercent >= 85 ? "\n" : "";
  // RESET prefix: 이전 렌더 잔여 ANSI 색상 방지
  process.stdout.write(`\x1b[0m${contextLowPrefix}${outputLines.join("\n")}\n`);
}

main().catch(() => {
  process.stdout.write(`\x1b[0m${bold(claudeOrange("c"))}: ${dim("5h:")}${green("0%")} ${dim("(n/a)")} ${dim("1w:")}${green("0%")} ${dim("(n/a)")} ${dim("|")} ${dim("ctx:")}${green("0%")}\n`);
});
