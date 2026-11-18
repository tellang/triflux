// Claude 는 외부 CLI 가 아니라 Claude Code Agent 도구로 실행되므로 plan() 이 command=null 을 반환한다.
// timeoutSec 은 예상 소요 시간(advisory)이며, hard ceiling 집행은 Bash route 가 맡는다.

export const id = "claude";
export const cliType = "claude-native";
export const command = null;

const AGENT_PROFILES = {
  explore: {
    timeoutSec: 600,
    model: "haiku",
  },
  claude: {
    timeoutSec: 600,
    model: "haiku",
  },
  "test-engineer": {
    timeoutSec: 1200,
    model: "sonnet",
  },
  "qa-tester": {
    timeoutSec: 1200,
    model: "sonnet",
  },
  verifier: {
    timeoutSec: 1200,
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
