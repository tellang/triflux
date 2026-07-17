// Canonical Codex role policy. Concrete model IDs stay in profile config files.

import { resolveCodexProfileConfigValues } from "./codex-profile-config.mjs";

const policy = {
  executor: {
    profile: "gpt56_terra_high",
    timeoutSec: 1080,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
  codex: {
    profile: "gpt56_terra_high",
    timeoutSec: 1080,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
  "build-fixer": {
    profile: "gpt56_luna_low",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
  cleanup: {
    profile: "gpt56_terra_med",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
  deslop: {
    profile: "gpt56_terra_med",
    timeoutSec: 540,
    runMode: "fg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
  debugger: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
  "deep-executor": {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "implement",
    subcommand: "exec",
  },
  architect: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  critic: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: true,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  planner: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "fg",
    opusOversight: true,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  analyst: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "fg",
    opusOversight: true,
    mcpHint: "analyze",
    subcommand: "exec",
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
    subcommand: "exec",
  },
  "document-specialist": {
    profile: "gpt56_terra_high",
    timeoutSec: 1440,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  "scientist-deep": {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 3600,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "analyze",
    subcommand: "exec",
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
    subcommand: "exec",
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
    subcommand: "exec",
  },
  // These entries are only for explicit direct-Codex overrides. agent-map.json
  // remains the provider-selection authority for their normal execution.
  designer: {
    profile: "gpt56_sol_xhigh",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
  writer: {
    profile: "gpt56_luna_low",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "implement",
    subcommand: "exec",
  },
};

function freezePolicy(entry) {
  return Object.freeze({ ...entry });
}

export const CODEX_AGENT_POLICY = Object.freeze(
  Object.fromEntries(
    Object.entries(policy).map(([agent, entry]) => [
      agent,
      freezePolicy(entry),
    ]),
  ),
);
export const DEFAULT_CODEX_AGENT = "executor";

export const CANONICAL_CODEX_PROFILE_OVERRIDES = Object.freeze(
  new Set([
    "gpt56_luna_low", "gpt56_terra_med", "gpt56_terra_high", "gpt56_sol_xhigh",
    "gpt56_sol_max", "gpt56_sol_ultra",
  ]),
);
export const ULTRA_ELIGIBLE_CODEX_AGENTS = Object.freeze(
  new Set(["deep-executor", "scientist-deep"]),
);
const NESTED_GLOBAL_PROFILE_OVERRIDES = new Set([
  "max", "ultra", "gpt56_sol_max", "gpt56_sol_ultra",
]);

export function resolveCodexAgentPolicy(agent) {
  return freezePolicy(
    CODEX_AGENT_POLICY[agent] ?? CODEX_AGENT_POLICY[DEFAULT_CODEX_AGENT],
  );
}

export function resolveCodexAgentProfile(
  agent,
  { profileOverride = "auto", retryProfile = null, nested = false, allowCustom = false } = {},
) {
  const defaultProfile = resolveCodexAgentPolicy(agent).profile;
  const retryRequested = String(retryProfile ?? "").trim();
  const requested = retryRequested || String(profileOverride || "auto").trim();
  if (!requested || requested === "auto") return defaultProfile;
  const canonical = requested === "max" ? "gpt56_sol_max" : requested === "ultra" ? "gpt56_sol_ultra" : requested;
  if (!CANONICAL_CODEX_PROFILE_OVERRIDES.has(canonical)) {
    if (allowCustom) return requested;
    throw new Error(`[agent-route-policy] unsupported profile override: ${requested}`);
  }
  if (canonical !== "gpt56_sol_ultra") return canonical;
  return nested || !ULTRA_ELIGIBLE_CODEX_AGENTS.has(agent) ? "gpt56_sol_max" : canonical;
}

export function resolveNestedCodexAgentProfile(
  agent,
  { profileOverride = "auto", globalProfile = "auto", retryProfile = null, codexHome } = {},
) {
  const explicitProfile = String(profileOverride || "auto").trim();
  const globalOverride = String(globalProfile || "auto").trim();
  const effectiveOverride = explicitProfile !== "auto" ? explicitProfile : NESTED_GLOBAL_PROFILE_OVERRIDES.has(globalOverride) ? globalOverride : "auto";
  const fallback = resolveCodexAgentProfile(agent);
  const candidate = resolveCodexAgentProfile(agent, { profileOverride: effectiveOverride, retryProfile, nested: true, allowCustom: true });
  const { effort } = resolveCodexProfileConfigValues(candidate, { codexHome });
  if (!effort) return fallback;
  return effort.toLowerCase() === "ultra" ? "gpt56_sol_max" : candidate;
}

export function describeCodexAgentPolicy() {
  return {
    defaultAgent: DEFAULT_CODEX_AGENT,
    agents: Object.keys(CODEX_AGENT_POLICY),
  };
}

function parseCliArgs(argv) {
  const args = [...argv];
  let format = "json";
  let agent = DEFAULT_CODEX_AGENT;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--format") format = args.shift() || "";
    else if (flag === "--agent") agent = args.shift() || "";
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!new Set(["json", "tsv"]).has(format)) {
    throw new Error(`unsupported format: ${format}`);
  }
  return { format, agent };
}

function runCli() {
  const { format, agent } = parseCliArgs(process.argv.slice(2));
  const resolved = resolveCodexAgentPolicy(agent);
  if (format === "tsv") {
    process.stdout.write(
      [
        resolved.profile,
        resolved.timeoutSec,
        resolved.runMode,
        resolved.opusOversight,
        resolved.mcpHint,
        resolved.subcommand,
      ].join("\t"),
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(resolved)}\n`);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`[agent-route-policy] ${error.message}\n`);
    process.exitCode = 1;
  }
}
