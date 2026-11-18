import { execSync } from "node:child_process";
import { coloredBar, DIM, GAUGE_WIDTH, RESET } from "./colors.mjs";
import {
  COMPACT_COLS_THRESHOLD,
  HUD_CONFIG_PATH,
  MINIMAL_COLS_THRESHOLD,
} from "./constants.mjs";
import { readJson } from "./utils.mjs";

let _cachedColumns = 0;
export function getTerminalColumns() {
  if (_cachedColumns > 0) return _cachedColumns;
  const envCols = Number(process.env.COLUMNS);
  if (envCols > 0) {
    _cachedColumns = envCols;
    return _cachedColumns;
  }
  if (process.stdout.columns) {
    _cachedColumns = process.stdout.columns;
    return _cachedColumns;
  }
  if (process.stderr.columns) {
    _cachedColumns = process.stderr.columns;
    return _cachedColumns;
  }
  try {
    if (process.platform === "win32") {
      const raw = execSync("mode con", {
        timeout: 2000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }).toString();
      const m =
        raw.match(/Columns[^:]*:\s*(\d+)/i) || raw.match(/열[^:]*:\s*(\d+)/);
      if (m) {
        _cachedColumns = Number(m[1]);
        return _cachedColumns;
      }
    } else {
      const raw = execSync(
        "tput cols 2>/dev/null || stty size 2>/dev/null | awk '{print $2}'",
        {
          timeout: 2000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
        .toString()
        .trim();
      if (raw && !Number.isNaN(Number(raw))) {
        _cachedColumns = Number(raw);
        return _cachedColumns;
      }
    }
  } catch {}
  return 0;
}

export function detectCompactMode() {
  if (process.argv.includes("--compact")) return true;
  if (process.argv.includes("--no-compact")) return false;
  if (process.env.TERMUX_VERSION) return true;
  if (process.env.OMC_HUD_COMPACT === "1") return true;
  if (process.env.OMC_HUD_COMPACT === "0") return false;
  const hudConfig = readJson(HUD_CONFIG_PATH, null);
  if (hudConfig?.compact === true || hudConfig?.compact === "always")
    return true;
  if (hudConfig?.compact === false || hudConfig?.compact === "never")
    return false;
  // 3줄 미만이면 알림 배너와 겹치지 않게 컴팩트로 전환한다.
  if (Number(hudConfig?.lines) > 0 && Number(hudConfig?.lines) < 3) return true;
  const threshold =
    Number(hudConfig?.compactThreshold) || COMPACT_COLS_THRESHOLD;
  const cols = getTerminalColumns();
  if (cols > 0 && cols < threshold) return true;
  return false;
}

export function detectMinimalMode() {
  if (process.argv.includes("--minimal")) return true;
  if (process.env.OMC_HUD_MINIMAL === "1") return true;
  if (process.env.OMC_HUD_MINIMAL === "0") return false;
  const hudConfig = readJson(HUD_CONFIG_PATH, null);
  if (hudConfig?.compact === "minimal") return true;
  const cols = getTerminalColumns();
  if (cols > 0 && cols < MINIMAL_COLS_THRESHOLD) return true;
  return false;
}

export function selectTier() {
  const hudConfig = readJson(HUD_CONFIG_PATH, null);

  const forcedTier = hudConfig?.tier;
  if (["full", "compact", "minimal", "micro", "nano"].includes(forcedTier))
    return forcedTier;

  // 알림 배너나 분할 화면에서는 1줄 모드(nano)로 맞춘다.
  if (Number(hudConfig?.lines) === 1) return "nano";

  const cols = getTerminalColumns() || 120;

  if (cols < 40) return "nano";

  const COMPACT_MODE = detectCompactMode();
  const MINIMAL_MODE = detectMinimalMode();
  if (MINIMAL_MODE) return "micro";
  if (COMPACT_MODE) return "compact";

  if (hudConfig?.autoResize === false) return "full";

  if (cols >= 120) return "full";
  if (cols >= 80) return "compact";
  if (cols >= 60) return "minimal";
  return "micro";
}

export function tierBar(currentTier, percent, baseColor = null, gap = " ") {
  return currentTier === "full"
    ? coloredBar(percent, GAUGE_WIDTH, baseColor) + gap
    : "";
}
export function tierDimBar(currentTier, gap = " ") {
  return currentTier === "full"
    ? DIM + "░".repeat(GAUGE_WIDTH) + RESET + gap
    : "";
}
