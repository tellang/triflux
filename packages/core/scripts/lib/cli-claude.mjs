// cli-claude.mjs — Claude native adapter (Phase 0 PoC).
//
// 책임: Claude 는 외부 CLI 가 아닌 Claude Code Agent 도구로 dispatch 된다. plan() 은
// command=null 을 반환하고 호출자가 Agent() 로 라우팅하도록 신호한다.
//
// 출처: scripts/tfx-route.sh route_agent() L1062-L1063 (explore|claude),
//        L1196-L1203 (TFX_CLI_MODE=gemini fallback), TFX_VERIFIER_OVERRIDE=claude.

export const id = "claude";
export const cliType = "claude-native";
export const command = null;

const AGENT_PROFILES = {
  explore: {
    timeoutSec: 600,
    runMode: "fg",
    opusOversight: false,
    model: "haiku",
  },
  claude: {
    timeoutSec: 600,
    runMode: "fg",
    opusOversight: false,
    model: "haiku",
  },
  "test-engineer": {
    timeoutSec: 1200,
    runMode: "bg",
    opusOversight: false,
    model: "sonnet",
  },
  "qa-tester": {
    timeoutSec: 1200,
    runMode: "bg",
    opusOversight: false,
    model: "sonnet",
  },
  verifier: {
    timeoutSec: 1200,
    runMode: "fg",
    opusOversight: false,
    model: "sonnet",
  },
};

const DEFAULT_PROFILE = AGENT_PROFILES.explore;

export function plan({
  agent,
  prompt = "",
  mcpProfile = "auto",
  timeoutSec,
  contextFile,
} = {}) {
  if (!agent) {
    throw new Error("[cli-claude] agent required");
  }
  const cfg = AGENT_PROFILES[agent] ?? DEFAULT_PROFILE;
  const effectiveTimeoutSec =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : cfg.timeoutSec;
  return {
    command,
    profile: "claude-native",
    effort: "n/a",
    timeoutMs: effectiveTimeoutSec * 1000,
    runMode: cfg.runMode,
    opusOversight: cfg.opusOversight,
    model: cfg.model,
    mcpProfile: mcpProfile === "auto" ? null : mcpProfile,
    promptLength: prompt.length,
    contextFile: contextFile || null,
    note: "Claude native — dispatched via Claude Code Agent tool, not CLI",
  };
}

export function describe() {
  return { id, cliType, command, agents: Object.keys(AGENT_PROFILES) };
}
