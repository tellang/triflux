import {
  detectMultiplexer,
  hasWindowsTerminal,
  hasWindowsTerminalSession,
  sessionExists,
} from "../../session.mjs";

export function normalizeTeammateMode(mode = "auto") {
  const raw = String(mode).toLowerCase();
  if (raw === "inline" || raw === "native") return "in-process";
  if (raw === "headless" || raw === "hl") return "headless";
  if (raw === "psmux") return "headless";
  if (raw === "in-process" || raw === "tmux" || raw === "wt") return raw;
  if (raw === "windows-terminal" || raw === "windows_terminal") return "wt";
  if (raw === "auto") {
    if (process.env.TMUX) return "tmux";
    return detectMultiplexer() === "psmux" ? "headless" : "in-process";
  }
  return "in-process";
}

export function normalizeLayout(layout = "2x2") {
  const raw = String(layout).toLowerCase();
  if (raw === "2x2" || raw === "grid") return "2x2";
  if (raw === "1xn" || raw === "1x3" || raw === "vertical" || raw === "columns")
    return "1xN";
  if (raw === "nx1" || raw === "horizontal" || raw === "rows") return "Nx1";
  return "2x2";
}

export function isNativeMode(state) {
  return state?.teammateMode === "in-process" && !!state?.native?.controlUrl;
}

export function isWtMode(state) {
  return state?.teammateMode === "wt";
}

export function isTeamAlive(state) {
  if (!state) return false;
  if (isNativeMode(state)) {
    try {
      process.kill(state.native.supervisorPid, 0);
      return true;
    } catch {
      return false;
    }
  }
  if (isWtMode(state)) {
    if (!hasWindowsTerminal()) return false;
    if (hasWindowsTerminalSession()) return true;
    return Array.isArray(state.members) && state.members.length > 0;
  }
  return sessionExists(state.sessionName);
}

export function ensureTmuxOrExit() {
  const mux = detectMultiplexer();
  if (mux) return mux;
  const error = new Error("tmux 미발견");
  error.code = "TMUX_REQUIRED";
  throw error;
}

/**
 * teammateMode + 환경 기반 effective mode 결정 (pure function).
 *
 * - wt → wt.exe 없으면 in-process
 * - wt → WT_SESSION 없으면 in-process
 * - in-process → non-TTY 감지 시 headless (#114: run_in_background 부모 종료 시 자식 SIGTERM 방지)
 * - override: TFX_FORCE_IN_PROCESS=1 로 in-process 유지
 *
 * @param {string} teammateMode
 * @param {{
 *   hasWt?: () => boolean,
 *   hasWtSession?: () => boolean,
 *   isTTY?: boolean,
 *   env?: Record<string,string|undefined>,
 * }} [deps]
 * @returns {{ mode: string, warnings: string[] }}
 */
export function resolveEffectiveMode(teammateMode, deps = {}) {
  const hasWt = deps.hasWt || hasWindowsTerminal;
  const hasWtSession = deps.hasWtSession || hasWindowsTerminalSession;
  const isTTY =
    typeof deps.isTTY === "boolean" ? deps.isTTY : Boolean(process.stdout.isTTY);
  const env = deps.env || process.env;

  const warnings = [];
  let effective = teammateMode;

  if (effective === "wt" && !hasWt()) {
    warnings.push("wt.exe 미발견 — in-process 모드로 자동 fallback");
    effective = "in-process";
  }
  if (effective === "wt" && !hasWtSession()) {
    warnings.push(
      "WT_SESSION 미감지(Windows Terminal 외부) — in-process 모드로 자동 fallback",
    );
    effective = "in-process";
  }
  if (
    effective === "in-process" &&
    !isTTY &&
    env.TFX_FORCE_IN_PROCESS !== "1"
  ) {
    warnings.push(
      "non-TTY 환경 감지 (run_in_background 등) — headless 모드로 자동 fallback (#114). 강제 유지: TFX_FORCE_IN_PROCESS=1",
    );
    effective = "headless";
  }

  return { mode: effective, warnings };
}
