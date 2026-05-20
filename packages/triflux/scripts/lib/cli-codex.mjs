// cli-codex.mjs — Codex CLI adapter (Phase 0 PoC).
//
// 책임: agent 이름과 입력 파라미터를 받아 Codex 실행 계획(profile/effort/timeout/runMode)을
// 산출한다. 실제 spawn 은 Phase 1 에서 이관된다 (현재는 tfx-route.sh 가 수행).
//
// 진입점: tfx-route.mjs → selectAdapter("codex") → plan({...}).
// 출처: scripts/tfx-route.sh route_agent() L1001-L1079 case 문 미러.

export const id = "codex";
export const cliType = "codex";
export const command = "codex";

const AGENT_PROFILES = {
  executor: {
    profile: "gpt55_high",
    timeoutSec: 1080,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  codex: {
    profile: "gpt55_high",
    timeoutSec: 1080,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  "build-fixer": {
    profile: "gpt55_low",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  cleanup: {
    profile: "mini54_med",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  deslop: {
    profile: "mini54_med",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  debugger: {
    profile: "gpt55_xhigh",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "implement",
  },
  "deep-executor": {
    profile: "gpt55_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "implement",
  },
  architect: {
    profile: "gpt55_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  critic: {
    profile: "gpt55_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  planner: {
    profile: "gpt55_xhigh",
    timeoutSec: 3600,
    runMode: "fg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  analyst: {
    profile: "gpt55_xhigh",
    timeoutSec: 3600,
    runMode: "fg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  "code-reviewer": {
    profile: "gpt55_high",
    timeoutSec: 1800,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  "quality-reviewer": {
    profile: "gpt55_high",
    timeoutSec: 1800,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  "security-reviewer": {
    profile: "gpt55_xhigh",
    timeoutSec: 1800,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "review",
    subcommand: "review",
  },
  scientist: {
    profile: "gpt55_high",
    timeoutSec: 1440,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
  },
  "document-specialist": {
    profile: "gpt55_high",
    timeoutSec: 1440,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
  },
  "scientist-deep": {
    profile: "gpt55_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
  },
  verifier: {
    profile: "gpt55_high",
    timeoutSec: 1200,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  "test-engineer": {
    profile: "gpt55_high",
    timeoutSec: 1200,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "implement",
  },
  "qa-tester": {
    profile: "gpt55_high",
    timeoutSec: 1200,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  spark: {
    profile: "spark53_low",
    timeoutSec: 180,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
};

const DEFAULT_PROFILE = AGENT_PROFILES.executor;

export function plan({
  agent,
  prompt = "",
  mcpProfile = "auto",
  timeoutSec,
  contextFile,
} = {}) {
  if (!agent) {
    throw new Error("[cli-codex] agent required");
  }
  const cfg = AGENT_PROFILES[agent] ?? DEFAULT_PROFILE;
  const effectiveTimeoutSec =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : cfg.timeoutSec;
  return {
    command,
    subcommand: cfg.subcommand ?? "exec",
    profile: cfg.profile,
    effort: cfg.profile,
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
