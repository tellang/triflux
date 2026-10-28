// Canonical Codex role policy. Concrete model IDs stay in profile config files.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizeCodexProfileName,
  resolveCodexProfileConfigValues,
} from "./codex-profile-config.mjs";
import { resolveGeminiProfileForPurpose } from "./gemini-profiles.mjs";
import {
  modelEffortFromProfile,
  profileFromModelEffort,
} from "@triflux/core/scripts/lib/model-effort.mjs";

const policy = {
  executor: {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1080,
    mcpHint: "implement",
    subcommand: "exec",
  },
  codex: {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1080,
    mcpHint: "implement",
    subcommand: "exec",
  },
  "build-fixer": {
    codex: { family: "luna", effort: "high" },
    timeoutSec: 540,
    mcpHint: "implement",
    subcommand: "exec",
  },
  cleanup: {
    codex: { family: "sol", effort: "medium" },
    timeoutSec: 540,
    mcpHint: "implement",
    subcommand: "exec",
  },
  deslop: {
    codex: { family: "sol", effort: "medium" },
    timeoutSec: 540,
    mcpHint: "implement",
    subcommand: "exec",
  },
  debugger: {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 900,
    mcpHint: "implement",
    subcommand: "exec",
  },
  "deep-executor": {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 3600,
    mcpHint: "implement",
    subcommand: "exec",
  },
  architect: {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 3600,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  critic: {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 3600,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  planner: {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 3600,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  analyst: {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 3600,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  "code-reviewer": {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1800,
    mcpHint: "review",
    subcommand: "review",
  },
  "quality-reviewer": {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1800,
    mcpHint: "review",
    subcommand: "review",
  },
  "security-reviewer": {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 1800,
    mcpHint: "review",
    subcommand: "review",
  },
  scientist: {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1440,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  "document-specialist": {
    codex: { family: "terra", effort: "high" },
    timeoutSec: 1440,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  "scientist-deep": {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 3600,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  verifier: {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1200,
    mcpHint: "review",
    subcommand: "review",
  },
  "test-engineer": {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1200,
    mcpHint: "implement",
    subcommand: "exec",
  },
  "qa-tester": {
    codex: { family: "sol", effort: "high" },
    timeoutSec: 1200,
    mcpHint: "review",
    subcommand: "review",
  },
  spark: {
    codex: { family: "luna", effort: "low" },
    timeoutSec: 180,
    mcpHint: "implement",
    subcommand: "exec",
  },
  // These entries are only for explicit direct-Codex overrides. agent-map.json
  // remains the provider-selection authority for their normal execution.
  designer: {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 900,
    mcpHint: "implement",
    subcommand: "exec",
  },
  writer: {
    codex: { family: "terra", effort: "high" },
    timeoutSec: 900,
    mcpHint: "implement",
    subcommand: "exec",
  },
};

function freezePolicy(entry) {
  return Object.freeze({
    ...entry,
    codex: Object.freeze({ ...entry.codex }),
    profile: profileFromModelEffort("codex", entry.codex),
  });
}

const CODEX_AGENT_POLICY = Object.freeze(
  Object.fromEntries(
    Object.entries(policy).map(([agent, entry]) => [
      agent,
      freezePolicy(entry),
    ]),
  ),
);
const DEFAULT_CODEX_AGENT = "executor";

const CANONICAL_CODEX_PROFILE_OVERRIDES = Object.freeze(
  new Set([
    "luna_low",
    "luna_high",
    "terra_high",
    "sol_med",
    "sol_high",
    "astra_xhigh",
    "astra_max",
    "astra_ultra",
  ]),
);
const ULTRA_ELIGIBLE_CODEX_AGENTS = Object.freeze(
  new Set(["deep-executor", "scientist-deep"]),
);

const NESTED_GLOBAL_PROFILE_OVERRIDES = new Set([
  "max",
  "ultra",
  "astra_max",
  "astra_ultra",
]);

export function resolveCodexAgentPolicy(agent) {
  return freezePolicy(
    CODEX_AGENT_POLICY[agent] ?? CODEX_AGENT_POLICY[DEFAULT_CODEX_AGENT],
  );
}

/**
 * Resolves a requested Codex profile against the canonical role policy.
 *
 * `retryProfile` intentionally wins over `profileOverride`: retry snapshots
 * represent an already-selected escalation step and must not be replaced by a
 * later process-level `TFX_CODEX_PROFILE`. Ultra is reserved for an eligible
 * top-level role; every nested/sandboxed or ineligible request is max.
 */
export function resolveCodexAgentProfile(
  agent,
  {
    profileOverride = "auto",
    retryProfile = null,
    nested = false,
    allowCustom = false,
  } = {},
) {
  const defaultProfile = resolveCodexAgentPolicy(agent).profile;
  const retryRequested = String(retryProfile ?? "").trim();
  const requested = normalizeCodexProfileName(
    retryRequested || String(profileOverride || "auto").trim(),
  );
  if (!requested || requested === "auto") return defaultProfile;

  const canonical =
    requested === "max"
      ? "astra_max"
      : requested === "ultra"
        ? "astra_ultra"
        : requested;
  if (!CANONICAL_CODEX_PROFILE_OVERRIDES.has(canonical)) {
    if (allowCustom) return requested;
    throw new Error(
      `[agent-route-policy] unsupported profile override: ${requested}`,
    );
  }
  if (canonical !== "astra_ultra") return canonical;
  return nested || !ULTRA_ELIGIBLE_CODEX_AGENTS.has(agent)
    ? "astra_max"
    : canonical;
}

/**
 * Nested headless, team, worker, and delegator launches always select an
 * explicit role profile rather than inheriting the global Codex config. A
 * custom profile that resolves to ultra is also downgraded to max.
 */
export function resolveNestedCodexAgentProfile(
  agent,
  {
    profileOverride = "auto",
    globalProfile = "auto",
    retryProfile = null,
    codexHome,
  } = {},
) {
  const explicitProfile = String(profileOverride || "auto").trim();
  const globalOverride = normalizeCodexProfileName(
    String(globalProfile || "auto").trim(),
  );
  // Headless lanes must select their role policy explicitly. Only the max and
  // ultra exception lanes may cross the process environment boundary.
  const effectiveOverride =
    explicitProfile !== "auto"
      ? explicitProfile
      : NESTED_GLOBAL_PROFILE_OVERRIDES.has(globalOverride)
        ? globalOverride
        : "auto";
  const candidate = resolveCodexAgentProfile(agent, {
    profileOverride: effectiveOverride,
    retryProfile,
    nested: true,
    allowCustom: true,
  });
  const { effort } =
    modelEffortFromProfile("codex", candidate) ||
    resolveCodexProfileConfigValues(candidate, { codexHome });
  return effort?.toLowerCase() === "ultra" ? "astra_max" : candidate;
}

const EXPECTED_DURATION_BY_AGENT = Object.freeze({
  writer: 90,
  verifier: 90,
  "qa-tester": 90,
  executor: 300,
  debugger: 300,
  "test-engineer": 300,
  "code-reviewer": 600,
  "security-reviewer": 600,
  architect: 600,
  planner: 600,
  critic: 600,
  analyst: 600,
  scientist: 900,
  "scientist-deep": 900,
  "deep-executor": 900,
  "document-specialist": 900,
});

const NATIVE_CODEX_AGENTS = new Set([
  "explore",
  "verifier",
  "test-engineer",
  "qa-tester",
]);
const CLAUDE_REVIEW_USAGE_THRESHOLD = 80;

function resolveDirectCodexRoutePolicy(agent) {
  if (agent === "explore") {
    return { ...CODEX_AGENT_POLICY.spark, timeoutSec: 600, mcpHint: "analyze" };
  }
  if (agent === "antigravity" || agent === "agy") {
    return CODEX_AGENT_POLICY.designer;
  }
  return resolveCodexAgentPolicy(agent);
}

export function resolveAgentRoute(
  agent,
  map,
  profileOverride = "auto",
  nested = false,
  geminiProfileResolver = resolveGeminiProfileForPurpose,
  { reviewAuthor = "codex", weeklyPercent = 0 } = {},
) {
  if (!/^[A-Za-z0-9_.-]+$/.test(agent)) {
    throw new Error(`invalid agent: ${agent}`);
  }
  if (!Object.hasOwn(map, agent)) {
    throw new Error(
      `알 수 없는 에이전트 타입: ${agent}; available: ${Object.keys(map).join(", ")}`,
    );
  }
  let provider = map[agent];
  if (!["codex", "antigravity", "claude"].includes(provider)) {
    throw new Error(`invalid provider for ${agent}: ${provider}`);
  }
  const byAuthor = agent === "code-reviewer" || agent === "quality-reviewer";
  let usageSwitch = false;
  if (byAuthor) {
    if (!["codex", "claude", "antigravity"].includes(reviewAuthor)) {
      throw new Error(
        `TFX_REVIEW_AUTHOR 값이 유효하지 않습니다: ${reviewAuthor}`,
      );
    }
    usageSwitch =
      reviewAuthor !== "claude" &&
      Number.isFinite(weeklyPercent) &&
      weeklyPercent >= CLAUDE_REVIEW_USAGE_THRESHOLD;
    if (reviewAuthor === "claude") provider = "codex";
    else if (usageSwitch)
      provider = reviewAuthor === "codex" ? "antigravity" : "codex";
    else provider = "claude";
  }
  const policy = resolveDirectCodexRoutePolicy(agent);
  const normalizedOverride = normalizeCodexProfileName(profileOverride);
  let resolvedOverride = policy.profile;
  if (normalizedOverride !== "auto") {
    try {
      resolvedOverride = resolveCodexAgentProfile(agent, {
        profileOverride: normalizedOverride,
        nested,
      });
    } catch {
      throw new Error(
        `TFX_CODEX_PROFILE 값이 유효하지 않습니다: ${profileOverride}`,
      );
    }
  }
  const { family, effort } = modelEffortFromProfile("codex", resolvedOverride);
  return [
    provider,
    policy.profile,
    policy.timeoutSec,
    policy.mcpHint,
    policy.subcommand,
    normalizedOverride,
    resolvedOverride,
    geminiProfileResolver(agent),
    EXPECTED_DURATION_BY_AGENT[agent] ?? 30,
    NATIVE_CODEX_AGENTS.has(agent),
    byAuthor ? reviewAuthor : "",
    usageSwitch,
    effort,
    family,
  ];
}

function parseCliArgs(argv) {
  const args = [...argv];
  let format = "json";
  let agent = DEFAULT_CODEX_AGENT;
  let mapFile = "";
  let profileOverride = "auto";
  let geminiProfilesModule = "";
  let nested = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--format") format = args.shift() || "";
    else if (flag === "--agent") agent = args.shift() || "";
    else if (flag === "--map-file") mapFile = args.shift() || "";
    else if (flag === "--profile-override")
      profileOverride = args.shift() || "";
    else if (flag === "--gemini-profiles-module")
      geminiProfilesModule = args.shift() || "";
    else if (flag === "--nested") nested = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!new Set(["json", "tsv", "route"]).has(format)) {
    throw new Error(`unsupported format: ${format}`);
  }
  return {
    format,
    agent,
    mapFile,
    profileOverride,
    geminiProfilesModule,
    nested,
  };
}

async function runCli() {
  const {
    format,
    agent,
    mapFile,
    profileOverride,
    geminiProfilesModule,
    nested,
  } = parseCliArgs(process.argv.slice(2));
  if (format === "route") {
    if (!mapFile) throw new Error("--map-file is required for route format");
    const map = JSON.parse(readFileSync(mapFile, "utf8"));
    let weeklyPercent = 0;
    if (agent === "code-reviewer" || agent === "quality-reviewer") {
      try {
        const data = JSON.parse(
          readFileSync(
            join(homedir(), ".claude/cache/claude-usage-cache.json"),
            "utf8",
          ),
        ).data;
        weeklyPercent =
          Date.parse(data?.weeklyResetsAt) <= Date.now()
            ? 0
            : data?.weeklyPercent;
      } catch {
        // 사용량을 읽지 못하면 한도 미만으로 취급한다.
      }
    }
    let resolver = resolveGeminiProfileForPurpose;
    if (geminiProfilesModule) {
      try {
        const module = await import(pathToFileURL(geminiProfilesModule).href);
        resolver = (agent) => {
          try {
            return module.resolveGeminiProfileForPurpose(agent) || "argon";
          } catch {
            return "argon";
          }
        };
      } catch {
        resolver = () => "argon";
      }
    }
    process.stdout.write(
      resolveAgentRoute(agent, map, profileOverride, nested, resolver, {
        reviewAuthor: process.env.TFX_REVIEW_AUTHOR ?? "codex",
        weeklyPercent,
      }).join("\x1e"),
    );
    return;
  }
  const resolved = resolveCodexAgentPolicy(agent);
  if (format === "tsv") {
    process.stdout.write(
      [
        resolved.profile,
        resolved.timeoutSec,
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
    await runCli();
  } catch (error) {
    process.stderr.write(`[agent-route-policy] ${error.message}\n`);
    process.exitCode = 1;
  }
}
