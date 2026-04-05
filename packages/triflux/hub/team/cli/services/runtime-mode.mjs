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
  if (raw === "1xn" || raw === "1x3" || raw === "vertical" || raw === "columns") return "1xN";
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
