#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import { spawn, execSync } from "node:child_process";

const VERSION = "2.0";

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
const CLAUDE_ORANGE = "\x1b[38;5;173m"; // #D87656 (Claude 테라코타)
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

const GAUGE_WIDTH = 5;
const GAUGE_BLOCKS = ["░", "▒", "▓", "█"]; // 밝기 0~3

function coloredBar(percent, width = GAUGE_WIDTH, baseColor = null) {
  const safePercent = Math.min(100, Math.max(0, percent));
  const perBlock = 100 / width;

  // 상태별 색상
  let barColor;
  if (safePercent >= 85) barColor = RED;
  else if (safePercent >= 70) barColor = YELLOW;
  else barColor = baseColor || GREEN;

  let bar = "";
  for (let i = 0; i < width; i++) {
    const blockStart = i * perBlock;
    const blockEnd = (i + 1) * perBlock;

    if (safePercent >= blockEnd) {
      bar += "█"; // 완전 채움
    } else if (safePercent > blockStart) {
      // 프론티어: 구간 내 진행률
      const progress = (safePercent - blockStart) / perBlock;
      if (progress >= 0.75) bar += "▓";
      else if (progress >= 0.33) bar += "▒";
      else bar += "░";
    } else {
      bar += "░"; // 미도달
    }
  }

  // 채워진 부분 = barColor, 빈 부분 = DIM
  const filledEnd = Math.ceil(safePercent / perBlock);
  const coloredPart = barColor + bar.slice(0, filledEnd) + RESET;
  const dimPart = filledEnd < width ? DIM + bar.slice(filledEnd) + RESET : "";

  return coloredPart + dimPart;
}

// 프로바이더별 색상 % (< 70%: 프로바이더 색, ≥ 70%: 경고색)
function colorByProvider(value, text, providerColorFn) {
  if (value >= 85) return red(text);
  if (value >= 70) return yellow(text);
  return providerColorFn(text);
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
const CLAUDE_USAGE_STALE_MS_SOLO = 5 * 60 * 1000; // OMC 없을 때: 5분 캐시
const CLAUDE_USAGE_STALE_MS_WITH_OMC = 15 * 60 * 1000; // OMC 있을 때: 15분 (OMC가 30초마다 갱신)

// OMC 활성 여부에 따라 캐시 TTL 동적 결정
function getClaudeUsageStaleMs() {
  return existsSync(OMC_PLUGIN_USAGE_CACHE_PATH)
    ? CLAUDE_USAGE_STALE_MS_WITH_OMC
    : CLAUDE_USAGE_STALE_MS_SOLO;
}
const CLAUDE_USAGE_429_BACKOFF_MS = 10 * 60 * 1000; // 429 에러 시 10분 backoff
const CLAUDE_USAGE_ERROR_BACKOFF_MS = 3 * 60 * 1000; // 기타 에러 시 3분 backoff
const CLAUDE_API_TIMEOUT_MS = 10_000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
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
// rows 임계값 상수 (selectTier 에서 tier 결정에 사용)
const ROWS_BUDGET_FULL = 40;
const ROWS_BUDGET_LARGE = 35;
const ROWS_BUDGET_MEDIUM = 28;
const ROWS_BUDGET_SMALL = 22;
// Codex rate_limits에서 최소 수집할 버킷 수
const CODEX_MIN_BUCKETS = 2;

const GEMINI_RPM_WINDOW_MS = 60 * 1000; // 60초 슬라이딩 윈도우
const GEMINI_QUOTA_STALE_MS = 5 * 60 * 1000; // 5분
const GEMINI_SESSION_STALE_MS = 15 * 1000; // 15초
const GEMINI_API_TIMEOUT_MS = 3000; // 3초
const ACCOUNT_LABEL_WIDTH = 10;
const PROVIDER_PREFIX_WIDTH = 2;
const PERCENT_CELL_WIDTH = 3;
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

let _cachedRows = 0;
function getTerminalRows() {
  if (_cachedRows > 0) return _cachedRows;
  if (process.stdout.rows) { _cachedRows = process.stdout.rows; return _cachedRows; }
  if (process.stderr.rows) { _cachedRows = process.stderr.rows; return _cachedRows; }
  const envLines = Number(process.env.LINES);
  if (envLines > 0) { _cachedRows = envLines; return _cachedRows; }
  try {
    if (process.platform === "win32") {
      const raw = execSync("mode con", { timeout: 2000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }).toString();
      const m = raw.match(/Lines[^:]*:\s*(\d+)/i) || raw.match(/줄[^:]*:\s*(\d+)/);
      if (m) { _cachedRows = Number(m[1]); return _cachedRows; }
    } else {
      const raw = execSync("tput lines 2>/dev/null || stty size 2>/dev/null | awk '{print $1}'", {
        timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      }).toString().trim();
      if (raw && !isNaN(Number(raw))) { _cachedRows = Number(raw); return _cachedRows; }
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
// 4-Tier 적응형 렌더링: full > normal > compact > nano
// ============================================================================
// 초기 tier (stdin 없이 결정 가능한 수준)
let CURRENT_TIER = MINIMAL_MODE ? "nano" : COMPACT_MODE ? "compact" : "normal";

/**
 * 인디케이터 인식 + 터미널 크기 기반 tier 자동 선택.
 * main()에서 stdin 수신 후 호출하여 CURRENT_TIER 갱신.
 */
function selectTier(stdin, claudeUsage = null) {
  const hudConfig = readJson(HUD_CONFIG_PATH, null);

  // 1) 명시적 tier 강제 설정
  const forcedTier = hudConfig?.tier;
  if (["full", "normal", "compact", "nano", "micro"].includes(forcedTier)) return forcedTier;

  // 1.5) maxLines=1 → micro (1줄 모드: 알림 배너/분할화면 대응)
  if (Number(hudConfig?.lines) === 1) return "micro";

  // 1.6) 분할화면 감지: 열 < 80이면 micro (COMPACT_MODE보다 우선)
  if ((getTerminalColumns() || 120) < 80) return "micro";

  // 2) 기존 모드 플래그 존중
  if (MINIMAL_MODE) return "nano";
  if (COMPACT_MODE) return "compact";

  // 3) autoResize 비활성이면 normal 유지
  if (hudConfig?.autoResize === false) return "normal";

  // 4) 터미널 행/열에서 상태영역 예산 추정
  const rows = getTerminalRows();
  const cols = getTerminalColumns() || 120;

  let budget;
  if (rows >= ROWS_BUDGET_FULL) budget = 6;
  else if (rows >= ROWS_BUDGET_LARGE) budget = 5;
  else if (rows >= ROWS_BUDGET_MEDIUM) budget = 4;
  else if (rows >= ROWS_BUDGET_SMALL) budget = 3;
  else if (rows > 0) budget = 2;
  else budget = 5; // rows 감지 불가 → 넉넉하게

  // 5) 인디케이터 줄 추정
  let indicatorRows = 1; // bypass permissions (거의 항상 표시)
  indicatorRows += 1; // 선행 개행 가드 (알림 배너 우회용 빈 줄)
  const contextPercent = getContextPercent(stdin);
  // "Context low" 배너 공간은 출력부(leadingBreaks)에서 \n\n으로 처리 — 티어 선택에서 예약 불필요
  // Claude Code 사용량 경고 (노란색 배너: "You've used X% of your ... limit")
  const weeklyPct = claudeUsage?.weeklyPercent ?? 0;
  const fiveHourPct = claudeUsage?.fiveHourPercent ?? 0;
  if (weeklyPct >= 80) indicatorRows += 1;
  if (fiveHourPct >= 80) indicatorRows += 1;

  // 6) 각 tier에서 줄바꿈 없이 3줄 가용한지 확인
  const tierWidths = { full: 70, normal: 60, compact: 40, nano: 34 };
  for (const tier of ["full", "normal", "compact", "nano"]) {
    const lineWidth = tierWidths[tier];
    const visualRowsPerLine = Math.ceil(lineWidth / Math.max(cols, 1));
    const totalVisualRows = (3 * visualRowsPerLine) + indicatorRows;
    if (totalVisualRows <= budget) return tier;
  }
  // 어떤 tier도 budget에 안 맞으면 micro (1줄 모드)
  return "micro";
}

// full tier 전용: 게이지 바 접두사 (normal 이하 tier에서는 빈 문자열)
function tierBar(percent, baseColor = null) {
  return CURRENT_TIER === "full" ? coloredBar(percent, GAUGE_WIDTH, baseColor) + " " : "";
}
function tierDimBar() {
  return CURRENT_TIER === "full" ? DIM + "░".repeat(GAUGE_WIDTH) + RESET + " " : "";
}
// Gemini ∞% 전용: 무한 쿼터이므로 dim 회색 바
function tierInfBar() {
  return CURRENT_TIER === "full" ? DIM + "█".repeat(GAUGE_WIDTH) + RESET + " " : "";
}

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

// micro tier: 모든 프로바이더를 1줄로 압축 (알림 배너/분할화면 대응)
// 형식: c:16/3 x:5/2 g:∞ sv:143% ctx:53%
function getMicroLine(stdin, claudeUsage, codexBuckets, geminiSession, geminiBucket, combinedSvPct) {
  const ctx = getContextPercent(stdin);

  // Claude 5h/1w (캐시된 값 그대로 표시, 시간은 advanceToNextCycle이 처리)
  const cF = claudeUsage?.fiveHourPercent != null ? clampPercent(claudeUsage.fiveHourPercent) : null;
  const cW = claudeUsage?.weeklyPercent != null ? clampPercent(claudeUsage.weeklyPercent) : null;
  const cVal = claudeUsage != null
    ? `${cF != null ? colorByProvider(cF, `${cF}`, claudeOrange) : dim("--")}${dim("/")}${cW != null ? colorByProvider(cW, `${cW}`, claudeOrange) : dim("--")}`
    : dim("--/--");

  // Codex 5h/1w (캐시된 값 그대로 표시)
  let xVal = dim("--/--");
  if (codexBuckets) {
    const mb = codexBuckets.codex || codexBuckets[Object.keys(codexBuckets)[0]];
    if (mb) {
      const xF = mb.primary?.used_percent != null ? clampPercent(mb.primary.used_percent) : null;
      const xW = mb.secondary?.used_percent != null ? clampPercent(mb.secondary.used_percent) : null;
      xVal = `${xF != null ? colorByProvider(xF, `${xF}`, codexWhite) : dim("--")}${dim("/")}${xW != null ? colorByProvider(xW, `${xW}`, codexWhite) : dim("--")}`;
    }
  }

  // Gemini
  let gVal;
  if (geminiBucket) {
    const gU = clampPercent(geminiBucket.usedPercent ?? 0);
    gVal = colorByProvider(gU, `${gU}`, geminiBlue);
  } else if ((geminiSession?.total || 0) > 0) {
    gVal = geminiBlue("\u221E");
  } else {
    gVal = dim("--");
  }

  // sv (trimmed)
  const sv = formatSvPct(combinedSvPct || 0).trim();

  return `${bold(claudeOrange("c"))}${dim(":")}${cVal} ` +
    `${bold(codexWhite("x"))}${dim(":")}${xVal} ` +
    `${bold(geminiBlue("g"))}${dim(":")}${gVal} ` +
    `${dim("sv:")}${sv} ` +
    `${dim("ctx:")}${colorByPercent(ctx, `${ctx}%`)}`;
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
    return `${Number(hourMinute[1])}h${String(Number(hourMinute[2])).padStart(2, "0")}m`;
  }
  const dayHour = text.match(/^(\d+)d(\d+)h$/);
  if (dayHour) {
    return `${Number(dayHour[1])}d${String(Number(dayHour[2])).padStart(2, "0")}h`;
  }
  return text;
}

function formatTimeCell(value) {
  const text = normalizeTimeToken(value);
  // 시간값(숫자 포함)은 0패딩, 비시간값(n/a 등)은 공백패딩
  const padChar = /\d/.test(text) ? "0" : " ";
  return `(${text.padStart(TIME_CELL_INNER_WIDTH, padChar)})`;
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
  const copy = { ...data };
  if (copy.fiveHourResetsAt) {
    const t = new Date(copy.fiveHourResetsAt).getTime();
    if (!isNaN(t)) copy.fiveHourResetsAt = new Date(advanceToNextCycle(t, FIVE_HOUR_MS)).toISOString();
  }
  if (copy.weeklyResetsAt) {
    const t = new Date(copy.weeklyResetsAt).getTime();
    if (!isNaN(t)) copy.weeklyResetsAt = new Date(advanceToNextCycle(t, SEVEN_DAY_MS)).toISOString();
  }
  return copy;
}

function readClaudeUsageSnapshot() {
  const cache = readJson(CLAUDE_USAGE_CACHE_PATH, null);
  const ts = Number(cache?.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;

  // 1차: 자체 캐시에 유효 데이터가 있는 경우
  if (cache?.data) {
    const isFresh = ageMs < getClaudeUsageStaleMs();
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
      // stale OMC fallback 또는 null (--% 플레이스홀더 표시, 가짜 0% 방지)
      const staleData = omcCache?.data?.fiveHourPercent != null ? stripStaleResets(omcCache.data) : null;
      return { data: staleData, shouldRefresh: false };
    }
  }

  // 3차: OMC 플러그인 캐시 (같은 API 데이터, 중복 호출 방지)
  const OMC_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
  const omcCache = readJson(OMC_PLUGIN_USAGE_CACHE_PATH, null);
  if (omcCache?.data?.fiveHourPercent != null) {
    const omcAge = Number.isFinite(omcCache.timestamp) ? Date.now() - omcCache.timestamp : Number.MAX_SAFE_INTEGER;
    if (omcAge < OMC_CACHE_MAX_AGE_MS) {
      writeClaudeUsageCache(omcCache.data);
      return { data: omcCache.data, shouldRefresh: omcAge > getClaudeUsageStaleMs() };
    }
    // stale이어도 data: null보다는 오래된 데이터를 fallback으로 표시
    return { data: stripStaleResets(omcCache.data), shouldRefresh: true };
  }

  // 캐시/fallback 모두 없음: null 반환 → --% 플레이스홀더 + 리프레시 시도
  return { data: null, shouldRefresh: true };
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
      if (omcAge < getClaudeUsageStaleMs()) {
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
  } catch (spawnErr) {
    // spawn 실패 시 에러 유형을 캐시에 기록 (HUD에서 원인 힌트 표시 가능)
    writeClaudeUsageCache(null, { type: "network", status: 0, hint: String(spawnErr?.message || spawnErr) });
  }
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

// 과거 리셋 시간 → 다음 주기로 순환하여 미래 시점 반환
function advanceToNextCycle(epochMs, cycleMs) {
  const now = Date.now();
  if (epochMs >= now || !cycleMs) return epochMs;
  const elapsed = now - epochMs;
  return epochMs + Math.ceil(elapsed / cycleMs) * cycleMs;
}

function formatResetRemaining(isoOrUnix, cycleMs = 0) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const targetMs = advanceToNextCycle(d.getTime(), cycleMs);
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${totalHours}h${String(minutes).padStart(2, "0")}m`;
}

function isResetPast(isoOrUnix) {
  if (!isoOrUnix) return false;
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  return !isNaN(d.getTime()) && d.getTime() <= Date.now();
}

function formatResetRemainingDayHour(isoOrUnix, cycleMs = 0) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const targetMs = advanceToNextCycle(d.getTime(), cycleMs);
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  return `${days}d${hours}h`;
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
// JWT base64 디코딩 공통 헬퍼
// ============================================================================
/**
 * JWT 파일에서 이메일을 추출하는 공통 헬퍼.
 * @param {string|null} idToken - JWT 문자열
 * @returns {string|null} 이메일 또는 null
 */
function decodeJwtEmail(idToken) {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4) payload += "=";
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded.email || null;
  } catch { return null; }
}

// ============================================================================
// Codex JWT에서 이메일 추출
// ============================================================================
function getCodexEmail() {
  try {
    const auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8"));
    return decodeJwtEmail(auth?.tokens?.id_token);
  } catch { return null; }
}

// ============================================================================
// Gemini JWT에서 이메일 추출
// ============================================================================
function getGeminiEmail() {
  try {
    const oauth = readJson(GEMINI_OAUTH_PATH, null);
    return decodeJwtEmail(oauth?.id_token);
  } catch { return null; }
}

// ============================================================================
// Codex 세션 JSONL에서 실제 rate limits 추출
// 한계: rate_limits는 세션별 스냅샷이므로 여러 세션 간 토큰 합산은 불가.
// 오늘 날짜의 모든 세션 파일을 스캔해 가장 최신 rate_limits 버킷을 수집한다.
// (단일 파일 즉시 return 방식에서 → 당일 전체 스캔 후 최신 데이터 우선 병합으로 변경)
// ============================================================================
function getCodexRateLimits() {
  const now = new Date();
  let syntheticBucket = null; // 오늘 token_count에서 합성 (행 활성화 + 토큰 데이터용)

  // 2일간 스캔: 실제 rate_limits 우선, 합성 버킷은 폴백
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
            } else if (dayOffset === 0 && !rl && evt?.payload?.info?.total_token_usage && !syntheticBucket) {
              // 오늘 token_count: 합성 버킷 (rate_limits가 null일 때 행 활성화용)
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
    // 실제 rate_limits 발견 → 오늘 토큰 데이터 병합 후 즉시 반환
    if (Object.keys(mergedBuckets).length > 0) {
      if (syntheticBucket) {
        const main = mergedBuckets.codex || mergedBuckets[Object.keys(mergedBuckets)[0]];
        if (main && !main.tokens) main.tokens = syntheticBucket.tokens;
      }
      return mergedBuckets;
    }
  }
  // 실제 rate_limits 없음 → 합성 버킷이라도 반환 (행 활성화)
  return syntheticBucket ? { codex: syntheticBucket } : null;
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

  if (!quotaRes?.buckets) {
    // API 응답에 buckets 없음: 에러 코드 또는 응답 내용을 캐시에 기록
    const apiError = quotaRes?.error?.message || quotaRes?.error?.code || quotaRes?.error || "no buckets in response";
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
  } catch (spawnErr) {
    // spawn 실패 시 캐시에 에러 힌트 기록 (다음 HUD 렌더에서 원인 확인 가능)
    writeJsonSafe(GEMINI_QUOTA_CACHE_PATH, {
      timestamp: Date.now(),
      error: true,
      errorHint: String(spawnErr?.message || spawnErr),
    });
  }
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
  // buckets가 null이어도 캐시 갱신 (stale 데이터 제거)
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

// sv 퍼센트 포맷 (1000+ → k 표기, 5자 고정폭)
const SV_CELL_WIDTH = 5;
function formatSvPct(value) {
  if (value == null) return "--%".padStart(SV_CELL_WIDTH);
  if (value >= 10000) return `${Math.round(value / 1000)}k%`.padStart(SV_CELL_WIDTH);
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k%`.padStart(SV_CELL_WIDTH);
  return `${value}%`.padStart(SV_CELL_WIDTH);
}

function getClaudeRows(stdin, claudeUsage, combinedSvPct) {
  const contextPercent = getContextPercent(stdin);
  const prefix = `${bold(claudeOrange("c"))}:`;

  // 절약 퍼센트 (Codex+Gemini sv% 합산, x/g와 동일 형식)
  const svStr = formatSvPct(combinedSvPct || 0);
  const svSuffix = `${dim("sv:")}${svStr}`;

  // API 실측 데이터 사용 (없으면 플레이스홀더)
  // 캐시된 percent 그대로 사용 (시간 표시는 advanceToNextCycle이 처리)
  const fiveHourPercent = claudeUsage?.fiveHourPercent ?? null;
  const weeklyPercent = claudeUsage?.weeklyPercent ?? null;
  const fiveHourReset = claudeUsage?.fiveHourResetsAt
    ? formatResetRemaining(claudeUsage.fiveHourResetsAt, FIVE_HOUR_MS)
    : "n/a";
  const weeklyReset = claudeUsage?.weeklyResetsAt
    ? formatResetRemainingDayHour(claudeUsage.weeklyResetsAt, SEVEN_DAY_MS)
    : "n/a";

  const hasData = claudeUsage != null;

  if (CURRENT_TIER === "nano") {
    const cols = getTerminalColumns() || 80;
    if (!hasData) {
      const quotaSection = cols < 40
        ? `${dim("--%/--%")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`
        : `${dim("5h --% 1w --% sv:--% ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
      return [{ prefix, left: quotaSection, right: "" }];
    }
    if (cols < 40) {
      // null이면 '--' 플레이스홀더, 아니면 실제 값
      const fStr = fiveHourPercent != null ? `${colorByProvider(fiveHourPercent, `${fiveHourPercent}%`, claudeOrange)}` : dim("--");
      const wStr = weeklyPercent != null ? `${colorByProvider(weeklyPercent, `${weeklyPercent}%`, claudeOrange)}` : dim("--");
      const quotaSection = `${fStr}${dim("/")}${wStr} ` +
        `${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
      return [{ prefix, left: quotaSection, right: "" }];
    }
    // nano: c: 5h  12% 1w  95% sv:  191% ctx:90%
    // null이면 '--%' 플레이스홀더 표시
    const fCellNano = fiveHourPercent != null
      ? colorByProvider(fiveHourPercent, formatPercentCell(fiveHourPercent), claudeOrange)
      : dim(formatPlaceholderPercentCell());
    const wCellNano = weeklyPercent != null
      ? colorByProvider(weeklyPercent, formatPercentCell(weeklyPercent), claudeOrange)
      : dim(formatPlaceholderPercentCell());
    const quotaSection = `${dim("5h")} ${fCellNano} ` +
      `${dim("1w")} ${wCellNano} ` +
      `${dim("sv:")}${svStr} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  if (CURRENT_TIER === "compact") {
    if (!hasData) {
      const quotaSection = `${dim("5h:")}${dim(formatPlaceholderPercentCell())} ` +
        `${dim("1w:")}${dim(formatPlaceholderPercentCell())} ` +
        `${dim("|")} ${svSuffix} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
      return [{ prefix, left: quotaSection, right: "" }];
    }
    // compact: c: 5h: 14% 1w: 96% | sv:  191% ctx:43%
    // null이면 '--%' 플레이스홀더 표시
    const fCellCmp = fiveHourPercent != null
      ? colorByProvider(fiveHourPercent, formatPercentCell(fiveHourPercent), claudeOrange)
      : dim(formatPlaceholderPercentCell());
    const wCellCmp = weeklyPercent != null
      ? colorByProvider(weeklyPercent, formatPercentCell(weeklyPercent), claudeOrange)
      : dim(formatPlaceholderPercentCell());
    const quotaSection = `${dim("5h:")}${fCellCmp} ` +
      `${dim("1w:")}${wCellCmp} ` +
      `${dim("|")} ${svSuffix} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  // 데이터 없을 때: 퍼센트+시간 모두 dim 처리 (green 0% 대신)
  if (!hasData) {
    const quotaSection = `${dim("5h:")}${tierDimBar()}${dim(formatPlaceholderPercentCell())} ` +
      `${dim(formatTimeCell(fiveHourReset))} ` +
      `${dim("1w:")}${tierDimBar()}${dim(formatPlaceholderPercentCell())} ` +
      `${dim(formatTimeCellDH(weeklyReset))}`;
    const contextSection = `${svSuffix} ${dim("|")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: contextSection }];
  }

  // null이면 dim 바 + '--%' 플레이스홀더, 아니면 실제 값 표시
  const fiveHourPercentCell = fiveHourPercent != null
    ? colorByProvider(fiveHourPercent, formatPercentCell(fiveHourPercent), claudeOrange)
    : dim(formatPlaceholderPercentCell());
  const weeklyPercentCell = weeklyPercent != null
    ? colorByProvider(weeklyPercent, formatPercentCell(weeklyPercent), claudeOrange)
    : dim(formatPlaceholderPercentCell());
  const fiveHourBar = fiveHourPercent != null ? tierBar(fiveHourPercent, CLAUDE_ORANGE) : tierDimBar();
  const weeklyBar = weeklyPercent != null ? tierBar(weeklyPercent, CLAUDE_ORANGE) : tierDimBar();
  const fiveHourTimeCell = formatTimeCell(fiveHourReset);
  const weeklyTimeCell = formatTimeCellDH(weeklyReset);
  const quotaSection = `${dim("5h:")}${fiveHourBar}${fiveHourPercentCell} ` +
    `${dim(fiveHourTimeCell)} ` +
    `${dim("1w:")}${weeklyBar}${weeklyPercentCell} ` +
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
  const svStr = formatSvPct(svPct);
  const modelLabelStr = modelLabel ? ` ${markerColor(modelLabel)}` : "";

  // ── 프로바이더별 색상 프로필 ──
  const provAnsi = provider === "codex" ? CODEX_WHITE : provider === "gemini" ? GEMINI_BLUE : GREEN;
  const provFn = provider === "codex" ? codexWhite : provider === "gemini" ? geminiBlue : green;

  // ── 쿼터 섹션 ──
  let quotaSection;
  let extraRightSection = "";

  if (CURRENT_TIER === "nano") {
    const cols = getTerminalColumns() || 80;
    const minPrefix = `${bold(markerColor(`${marker}`))}:`;
    const svCompact = svStr ? ` ${dim("sv:")}${cyan(svStr)}` : "";
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        // 캐시된 값 그대로 표시 (시간은 advanceToNextCycle이 처리)
        const fiveP = main.primary?.used_percent != null ? clampPercent(main.primary.used_percent) : null;
        const weekP = main.secondary?.used_percent != null ? clampPercent(main.secondary.used_percent) : null;
        const fCellN = fiveP != null ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn) : dim(formatPlaceholderPercentCell());
        const wCellN = weekP != null ? colorByProvider(weekP, formatPercentCell(weekP), provFn) : dim(formatPlaceholderPercentCell());
        if (cols < 40) {
          return { prefix: minPrefix, left: `${fCellN}${dim("/")}${wCellN}${svCompact}`, right: "" };
        }
        return { prefix: minPrefix, left: `${dim("5h")} ${fCellN} ${dim("1w")} ${wCellN}${svCompact}`, right: "" };
      }
    }
    if (realQuota?.type === "gemini") {
      const bucket = realQuota.quotaBucket;
      if (bucket) {
        const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
        if (cols < 40) {
          return { prefix: minPrefix, left: `${colorByProvider(usedP, formatPercentCell(usedP), provFn)}${svCompact}`, right: "" };
        }
        return { prefix: minPrefix, left: `${dim("1d")} ${colorByProvider(usedP, formatPercentCell(usedP), provFn)} ${dim("1w")} ${dim("\u221E%".padStart(PERCENT_CELL_WIDTH))}${svCompact}`, right: "" };
      }
    }
    return { prefix: minPrefix, left: dim("--%".padStart(PERCENT_CELL_WIDTH)), right: "" };
  }

  if (CURRENT_TIER === "compact") {
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        // 캐시된 값 그대로 표시 (시간은 advanceToNextCycle이 처리)
        const fiveP = main.primary?.used_percent != null ? clampPercent(main.primary.used_percent) : null;
        const weekP = main.secondary?.used_percent != null ? clampPercent(main.secondary.used_percent) : null;
        const fCell = fiveP != null ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn) : dim(formatPlaceholderPercentCell());
        const wCell = weekP != null ? colorByProvider(weekP, formatPercentCell(weekP), provFn) : dim(formatPlaceholderPercentCell());
        quotaSection = `${dim("5h:")}${fCell} ` +
          `${dim("1w:")}${wCell}`;
      }
    }
    if (realQuota?.type === "gemini") {
      const bucket = realQuota.quotaBucket;
      if (bucket) {
        const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
        quotaSection = `${dim("1d:")}${colorByProvider(usedP, formatPercentCell(usedP), provFn)} ${dim("1w:")}${dim("\u221E%".padStart(PERCENT_CELL_WIDTH))}`;
      } else {
        quotaSection = `${dim("1d:")}${dim("--%".padStart(PERCENT_CELL_WIDTH))} ${dim("1w:")}${dim("\u221E%".padStart(PERCENT_CELL_WIDTH))}`;
      }
    }
    if (!quotaSection) {
      quotaSection = `${dim("5h:")}${dim(formatPlaceholderPercentCell())} ${dim("1w:")}${dim(formatPlaceholderPercentCell())}`;
    }
    const prefix = `${bold(markerColor(`${marker}`))}:`;
    // compact: sv + 계정 (모델 라벨 제거)
    const compactRight = [svStr ? `${dim("sv:")}${svStr}` : "", accountLabel ? markerColor(accountLabel) : ""].filter(Boolean).join(" ");
    return { prefix, left: quotaSection, right: compactRight };
  }

  if (realQuota?.type === "codex") {
    const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
    if (main) {
      // 캐시된 값 그대로 표시 (시간은 advanceToNextCycle이 처리)
      const fiveP = main.primary?.used_percent != null ? clampPercent(main.primary.used_percent) : null;
      const weekP = main.secondary?.used_percent != null ? clampPercent(main.secondary.used_percent) : null;
      const fiveReset = formatResetRemaining(main.primary?.resets_at, FIVE_HOUR_MS) || "n/a";
      const weekReset = formatResetRemainingDayHour(main.secondary?.resets_at, SEVEN_DAY_MS) || "n/a";
      const fCell = fiveP != null ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn) : dim(formatPlaceholderPercentCell());
      const wCell = weekP != null ? colorByProvider(weekP, formatPercentCell(weekP), provFn) : dim(formatPlaceholderPercentCell());
      const fBar = fiveP != null ? tierBar(fiveP, provAnsi) : tierDimBar();
      const wBar = weekP != null ? tierBar(weekP, provAnsi) : tierDimBar();
      quotaSection = `${dim("5h:")}${fBar}${fCell} ` +
        `${dim(formatTimeCell(fiveReset))} ` +
        `${dim("1w:")}${wBar}${wCell} ` +
        `${dim(formatTimeCellDH(weekReset))}`;
    }
  }

  if (realQuota?.type === "gemini") {
    const bucket = realQuota.quotaBucket;
    if (bucket) {
      const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
      const rstRemaining = formatResetRemaining(bucket.resetTime, ONE_DAY_MS) || "n/a";
      quotaSection = `${dim("1d:")}${tierBar(usedP, provAnsi)}${colorByProvider(usedP, formatPercentCell(usedP), provFn)} ${dim(formatTimeCell(rstRemaining))} ` +
        `${dim("1w:")}${tierInfBar()}${dim("\u221E%".padStart(PERCENT_CELL_WIDTH))} ${dim(formatTimeCellDH("-d--h"))}`;
    } else {
      quotaSection = `${dim("1d:")}${tierDimBar()}${dim(formatPlaceholderPercentCell())} ` +
        `${dim(formatTimeCell("n/a"))} ${dim("1w:")}${tierInfBar()}${dim("\u221E%".padStart(PERCENT_CELL_WIDTH))} ${dim(formatTimeCellDH("-d--h"))}`;
    }
  }

  // 폴백: 쿼터 데이터 없을 때
  if (!quotaSection) {
    quotaSection = `${dim("5h:")}${tierDimBar()}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))} ${dim("1w:")}${tierDimBar()}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCellDH("-d--h"))}`;
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

  // 합산 절약: Codex+Gemini sv% 합산 (컨텍스트 대비 위임 토큰 비율)
  const combinedSvPct = Math.round(((codexSv ?? 0) + (geminiSv ?? 0)) * 100);

  // 인디케이터 인식 tier 선택 (stdin + Claude 사용량 기반)
  CURRENT_TIER = selectTier(stdin, claudeUsageSnapshot.data);

  // micro tier: 1줄 모드 (알림 배너/분할화면 대응)
  if (CURRENT_TIER === "micro") {
    const microLine = getMicroLine(stdin, claudeUsageSnapshot.data, codexBuckets,
      geminiSession, geminiBucket, combinedSvPct);
    process.stdout.write(`\x1b[0m${microLine}\n`);
    return;
  }

  const codexQuotaData = codexBuckets ? { type: "codex", buckets: codexBuckets } : null;
  const geminiQuotaData = { type: "gemini", quotaBucket: geminiBucket, session: geminiSession };

  const rows = [
    ...getClaudeRows(stdin, claudeUsageSnapshot.data, combinedSvPct),
    getProviderRow("codex", "x", codexWhite, qosProfile, accountsConfig, accountsState,
      codexQuotaData, codexEmail, codexSv, null),
    getProviderRow("gemini", "g", geminiBlue, qosProfile, accountsConfig, accountsState,
      geminiQuotaData, geminiEmail, geminiSv, null),
  ];

  // 비활성 프로바이더 dim 처리: 데이터 없으면 전체 줄 dim
  const codexActive = codexBuckets != null;
  const geminiActive = (geminiSession?.total || 0) > 0 || geminiBucket != null;

  let outputLines = renderAlignedRows(rows);

  // 비활성 줄 dim 래핑 (rows 순서: [claude, codex, gemini])
  if (outputLines.length >= 3) {
    if (!codexActive) outputLines[1] = `${DIM}${outputLines[1]}${RESET}`;
    if (!geminiActive) outputLines[2] = `${DIM}${outputLines[2]}${RESET}`;
  }

  // 선행 개행: 알림 배너(노란 글씨)가 빈 첫 줄에 오도록 → HUD 내용 보호
  // Context low(≥85%) 시 추가 개행으로 배너 분리
  const contextPercent = getContextPercent(stdin);
  const leadingBreaks = contextPercent >= 85 ? "\n\n" : "\n";
  // 줄별 RESET: Claude Code TUI 스타일 간섭 방지 (색상 밝기 버그 수정)
  const resetedLines = outputLines.map(line => `\x1b[0m${line}`);
  process.stdout.write(`${leadingBreaks}${resetedLines.join("\n")}\n`);
}

main().catch(() => {
  process.stdout.write(`\x1b[0m${bold(claudeOrange("c"))}: ${dim("5h:")}${green("0%")} ${dim("(n/a)")} ${dim("1w:")}${green("0%")} ${dim("(n/a)")} ${dim("|")} ${dim("ctx:")}${green("0%")}\n`);
});
