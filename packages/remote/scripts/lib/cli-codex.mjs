// cli-codex.mjs — Codex CLI adapter (Phase 0 PoC).
//
// 책임: agent 이름과 입력 파라미터를 받아 Codex 실행 계획(profile/effort/timeout/runMode)을
// 산출한다. 실제 spawn 은 Phase 1 에서 이관된다 (현재는 tfx-route.sh 가 수행).
//
// 진입점: tfx-route.mjs → selectAdapter("codex") → plan({...}).
// 출처: scripts/tfx-route.sh route_agent() L1001-L1079 case 문 미러.
// timeoutSec은 lane 예상 소요 시간(advisory)이다. hard ceiling 집행은 Bash route가 소유한다.

import { resolveCodexProfileConfigValues } from "./codex-profile-config.mjs";

export const id = "codex";
export const cliType = "codex";
export const command = "codex";

const AGENT_PROFILES = {
  executor: {
    profile: "gpt56_terra_high",
    timeoutSec: 1080,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  codex: {
    profile: "gpt56_terra_high",
    timeoutSec: 1080,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  "build-fixer": {
    profile: "gpt56_luna_low",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  cleanup: {
    profile: "gpt56_terra_med",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  deslop: {
    profile: "gpt56_terra_med",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
  debugger: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "implement",
  },
  "deep-executor": {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "implement",
  },
  architect: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  critic: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  planner: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "fg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  analyst: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "fg",
    opusOversight: true,
    mcpHint: "analyze",
  },
  "code-reviewer": {
    profile: "gpt56_terra_high",
    timeoutSec: 1800,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  "quality-reviewer": {
    profile: "gpt56_terra_high",
    timeoutSec: 1800,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  "security-reviewer": {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 1800,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "review",
    subcommand: "review",
  },
  scientist: {
    profile: "gpt56_terra_high",
    timeoutSec: 1440,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
  },
  "document-specialist": {
    profile: "gpt56_terra_high",
    timeoutSec: 1440,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
  },
  "scientist-deep": {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
  },
  verifier: {
    profile: "gpt56_terra_high",
    timeoutSec: 1200,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  "test-engineer": {
    profile: "gpt56_terra_high",
    timeoutSec: 1200,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "implement",
  },
  "qa-tester": {
    profile: "gpt56_terra_high",
    timeoutSec: 1200,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "review",
    subcommand: "review",
  },
  spark: {
    profile: "gpt56_luna_low",
    timeoutSec: 180,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
  },
};

const DEFAULT_PROFILE = AGENT_PROFILES.executor;
const CANONICAL_PROFILE_OVERRIDES = new Set([
  "gpt56_luna_low",
  "gpt56_terra_med",
  "gpt56_terra_high",
  "gpt56_sol_xhigh",
  "gpt56_sol_max",
  "gpt56_sol_ultra",
]);
const ULTRA_ELIGIBLE_AGENTS = new Set(["deep-executor", "scientist-deep"]);

export function resolveCodexAgentProfile(
  agent,
  { profileOverride = "auto", nested = false, allowCustom = false } = {},
) {
  const defaultProfile = (AGENT_PROFILES[agent] ?? DEFAULT_PROFILE).profile;
  const requested = String(profileOverride || "auto").trim();
  if (!requested || requested === "auto") return defaultProfile;

  const canonical =
    requested === "max"
      ? "gpt56_sol_max"
      : requested === "ultra"
        ? "gpt56_sol_ultra"
        : requested;
  if (!CANONICAL_PROFILE_OVERRIDES.has(canonical)) {
    if (allowCustom) return requested;
    throw new Error(`[cli-codex] unsupported profile override: ${requested}`);
  }
  if (canonical !== "gpt56_sol_ultra") return canonical;
  return nested || !ULTRA_ELIGIBLE_AGENTS.has(agent)
    ? "gpt56_sol_max"
    : canonical;
}

export function resolveNestedCodexAgentProfile(
  agent,
  { profileOverride = "auto", codexHome } = {},
) {
  const fallback = resolveCodexAgentProfile(agent);
  const candidate = resolveCodexAgentProfile(agent, {
    profileOverride,
    nested: true,
    allowCustom: true,
  });
  const { effort } = resolveCodexProfileConfigValues(candidate, { codexHome });
  if (!effort) return fallback;
  return effort.toLowerCase() === "ultra" ? "gpt56_sol_max" : candidate;
}

export function plan({
  agent,
  prompt = "",
  mcpProfile = "auto",
  timeoutSec,
  contextFile,
  profileOverride = "auto",
  nested = false,
} = {}) {
  if (!agent) {
    throw new Error("[cli-codex] agent required");
  }
  const cfg = AGENT_PROFILES[agent] ?? DEFAULT_PROFILE;
  const profile = resolveCodexAgentProfile(agent, {
    profileOverride,
    nested,
  });
  const effectiveTimeoutSec =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : cfg.timeoutSec;
  return {
    command,
    subcommand: cfg.subcommand ?? "exec",
    profile,
    effort: profile,
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
