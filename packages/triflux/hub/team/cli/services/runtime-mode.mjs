import { detectMultiplexer, sessionExists } from "../../session.mjs";

export function normalizeTeammateMode(mode = "auto", deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const detectMux = deps.detectMultiplexer || detectMultiplexer;
  const raw = String(mode).toLowerCase();
  if (raw === "headless" || raw === "hl") return "headless";
  if (raw === "tmux") return raw;
  if (raw === "psmux" && platform === "win32") return raw;
  if (raw !== "auto") {
    throw new Error(
      `지원하지 않는 teammate mode: ${mode}; auto, headless, tmux${platform === "win32" ? ", psmux" : ""}를 사용하세요.`,
    );
  }
  if (env.TMUX) return "tmux";
  const mux = detectMux();
  if (mux === "tmux") return "tmux";
  if (platform === "win32" && mux === "psmux") return "psmux";
  if (platform === "win32" && mux === "git-bash-tmux") return "tmux";
  if (!(deps.isTTY ?? Boolean(process.stdout.isTTY))) return "headless";
  return ensureTmuxOrExit(deps);
}

export function normalizeLayout(layout = "2x2") {
  const raw = String(layout).toLowerCase();
  if (raw === "2x2" || raw === "grid") return "2x2";
  if (raw === "1xn" || raw === "1x3" || raw === "vertical" || raw === "columns")
    return "1xN";
  if (raw === "nx1" || raw === "horizontal" || raw === "rows") return "Nx1";
  return "2x2";
}

export function isTeamAlive(state) {
  if (!state) return false;
  if (state.teammateMode === "headless" && state.ownerPid) {
    try {
      process.kill(state.ownerPid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return sessionExists(state.sessionName);
}

export function ensureTmuxOrExit(deps = {}) {
  const platform = deps.platform || process.platform;
  const mux = (deps.detectMultiplexer || detectMultiplexer)();
  if (
    mux === "tmux" ||
    (platform === "win32" && ["psmux", "git-bash-tmux"].includes(mux))
  )
    return mux;
  const error = new Error(
    platform === "win32"
      ? "멀티플렉서 미발견. psmux를 설치하세요: winget install psmux"
      : `멀티플렉서 미발견. tmux를 설치하세요: ${platform === "darwin" ? "brew install tmux" : "apt install tmux"}`,
  );
  error.code = "TMUX_REQUIRED";
  throw error;
}
