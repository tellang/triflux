// ============================================================================
// 터미널 감지 / 4-Tier 적응형 렌더링
// ============================================================================
import { execSync } from "node:child_process";
import { DIM, RESET, GAUGE_WIDTH, coloredBar } from "./colors.mjs";
import { readJson } from "./utils.mjs";
import { HUD_CONFIG_PATH, COMPACT_COLS_THRESHOLD, MINIMAL_COLS_THRESHOLD } from "./constants.mjs";

let _cachedColumns = 0;
export function getTerminalColumns() {
  if (_cachedColumns > 0) return _cachedColumns;
  const envCols = Number(process.env.COLUMNS);
  if (envCols > 0) { _cachedColumns = envCols; return _cachedColumns; }
  if (process.stdout.columns) { _cachedColumns = process.stdout.columns; return _cachedColumns; }
  if (process.stderr.columns) { _cachedColumns = process.stderr.columns; return _cachedColumns; }
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
export function getTerminalRows() {
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

export function detectCompactMode() {
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

export function detectMinimalMode() {
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

/**
 * 인디케이터 인식 + 터미널 크기 기반 tier 자동 선택.
 * main()에서 stdin 수신 후 호출하여 CURRENT_TIER 갱신.
 */
export function selectTier(stdin, claudeUsage = null) {
  const hudConfig = readJson(HUD_CONFIG_PATH, null);

  // 1) 명시적 tier 강제 설정
  const forcedTier = hudConfig?.tier;
  if (["full", "compact", "minimal", "micro", "nano"].includes(forcedTier)) return forcedTier;

  // 1.5) maxLines=1 → nano (1줄 모드: 알림 배너/분할화면 대응)
  if (Number(hudConfig?.lines) === 1) return "nano";

  const cols = getTerminalColumns() || 120;

  // 1.6) 극소 폭(< 40col)인 경우 1줄 모드(nano)로 폴백
  if (cols < 40) return "nano";

  // 2) 기존 모드 플래그 존중
  const COMPACT_MODE = detectCompactMode();
  const MINIMAL_MODE = detectMinimalMode();
  if (MINIMAL_MODE) return "micro";
  if (COMPACT_MODE) return "compact";

  // 3) autoResize 비활성이면 full 유지
  if (hudConfig?.autoResize === false) return "full";

  // 4) 터미널 폭에 따른 점진적 축소 (breakpoint)
  if (cols >= 120) return "full";
  if (cols >= 80) return "compact";
  if (cols >= 60) return "minimal";
  return "micro"; // 40 <= cols < 60
}

// full tier 전용: 게이지 바 접두사 (normal 이하 tier에서는 빈 문자열)
export function tierBar(currentTier, percent, baseColor = null) {
  return currentTier === "full" ? coloredBar(percent, GAUGE_WIDTH, baseColor) + " " : "";
}
export function tierDimBar(currentTier) {
  return currentTier === "full" ? DIM + "░".repeat(GAUGE_WIDTH) + RESET + " " : "";
}
// Gemini ∞% 전용: 무한 쿼터이므로 dim 회색 바
export function tierInfBar(currentTier) {
  return currentTier === "full" ? DIM + "█".repeat(GAUGE_WIDTH) + RESET + " " : "";
}

// 테스트 지원: 캐시 초기화
export function _resetTerminalCache() {
  _cachedColumns = 0;
  _cachedRows = 0;
}
