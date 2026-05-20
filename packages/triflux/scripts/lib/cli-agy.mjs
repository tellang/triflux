// cli-agy.mjs — Antigravity (agy) CLI adapter (Phase 0 PoC).
//
// 책임: agy --print 는 stdin-only 이므로 plan() 에서 stdinMode="pipe" 시그널을 반환한다.
// positional prompt 패턴은 환영 메시지 폴백을 유발하므로 사용 금지.
//
// 출처: scripts/tfx-route.sh route_agent() L1052-L1059, run_codex_exec() L2036-L2046.
//        .claude/rules/tfx-update-logic.md Antigravity CLI 1.0.0 정밀 sanity matrix.

export const id = "agy";
export const cliType = "antigravity";
export const command = "agy";

const AGENT_PROFILES = {
  antigravity: {
    profile: "agy_v1",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "docs",
  },
  agy: {
    profile: "agy_v1",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "docs",
  },
};

const DEFAULT_PROFILE = AGENT_PROFILES.antigravity;

export function plan({
  agent,
  prompt = "",
  mcpProfile = "auto",
  timeoutSec,
  contextFile,
} = {}) {
  if (!agent) {
    throw new Error("[cli-agy] agent required");
  }
  const cfg = AGENT_PROFILES[agent] ?? DEFAULT_PROFILE;
  const effectiveTimeoutSec =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : cfg.timeoutSec;
  return {
    command,
    profile: cfg.profile,
    effort: cfg.profile,
    args: ["--print", "--dangerously-skip-permissions"],
    stdinMode: "pipe",
    timeoutMs: effectiveTimeoutSec * 1000,
    runMode: cfg.runMode,
    opusOversight: cfg.opusOversight,
    mcpProfile: mcpProfile === "auto" ? cfg.mcpHint : mcpProfile,
    promptLength: prompt.length,
    contextFile: contextFile || null,
  };
}

export function describe() {
  return { id, cliType, command, agents: Object.keys(AGENT_PROFILES) };
}
