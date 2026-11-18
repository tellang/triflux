// Canonical Codex role policy. Concrete model IDs stay in profile config files.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  resolveAgyModel,
  resolveAgyProfileForPurpose,
} from "./agy-profiles.mjs";
import {
  normalizeCodexProfileName,
  resolveCodexProfileConfigValues,
} from "./codex-profile-config.mjs";
import {
  modelEffortFromProfile,
  profileFromModelEffort,
  resolveAgyModelEffort,
  resolveCodexModelEffort,
} from "./model-effort.mjs";
import { QUOTA_DEMOTE_OVER_PERCENT } from "./quota-snapshot.mjs";
import { resolveRoleCandidates } from "./vendor-priority-policy.mjs";

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
    codex: { family: "sol", effort: "medium" },
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
    codex: { family: "sol", effort: "high" },
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
  lead: {
    codex: { family: "astra", effort: "xhigh" },
    timeoutSec: 3600,
    mcpHint: "analyze",
    subcommand: "exec",
  },
  communication: {
    codex: { family: "terra", effort: "high" },
    timeoutSec: 900,
    mcpHint: "writer",
    subcommand: "exec",
  },
  "communication-report": {
    codex: { family: "terra", effort: "high" },
    timeoutSec: 900,
    mcpHint: "writer",
    subcommand: "exec",
  },
  "communication-relay": {
    codex: { family: "luna", effort: "low" },
    timeoutSec: 180,
    mcpHint: "none",
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
// 비용 순서다. Jev 는 방향만 답하고 등급은 여기서 한 단계만 옮긴다.
const CODEX_TIER_LADDER = Object.freeze([
  "luna_low",
  "luna_high",
  "sol_med",
  "sol_high",
  "astra_xhigh",
]);
const NO_LOWER_CODEX_AGENTS = Object.freeze(new Set(["security-reviewer"]));
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
export function shiftCodexAgentProfile(agent, tierShift) {
  const { profile } = resolveDirectCodexRoutePolicy(agent);
  const index = CODEX_TIER_LADDER.indexOf(profile);
  if (index === -1) return profile;
  if (tierShift === "raise") return CODEX_TIER_LADDER[index + 1] ?? profile;
  if (tierShift === "lower" && !NO_LOWER_CODEX_AGENTS.has(agent))
    return CODEX_TIER_LADDER[index - 1] ?? profile;
  return profile;
}

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
  "communication-relay": 30,
  spark: 60,
  writer: 90,
  communication: 90,
  "communication-report": 90,
  verifier: 90,
  "qa-tester": 90,
  "build-fixer": 180,
  executor: 300,
  designer: 300,
  debugger: 300,
  "test-engineer": 300,
  "code-reviewer": 600,
  "quality-reviewer": 600,
  "security-reviewer": 600,
  architect: 600,
  planner: 600,
  critic: 600,
  analyst: 600,
  lead: 900,
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
const CLAUDE_REVIEW_USAGE_THRESHOLD = QUOTA_DEMOTE_OVER_PERCENT;

function resolveDirectCodexRoutePolicy(agent) {
  if (agent === "explore") {
    return { ...CODEX_AGENT_POLICY.spark, timeoutSec: 600, mcpHint: "analyze" };
  }
  if (agent === "antigravity" || agent === "agy" || agent === "gemini") {
    return {
      ...CODEX_AGENT_POLICY.executor,
      timeoutSec: 900,
      mcpHint: "implement",
    };
  }
  if (agent === "claude") {
    return {
      ...CODEX_AGENT_POLICY.executor,
      timeoutSec: 900,
      mcpHint: "analyze",
    };
  }
  return resolveCodexAgentPolicy(agent);
}

export function resolveClaudeWorkerDefaults(agent, options = {}) {
  const planReviewGate =
    options.planReviewGate !== undefined
      ? Boolean(options.planReviewGate)
      : process.env.TFX_PLAN_REVIEW_GATE === "1";

  if (agent === "security-reviewer") {
    return { model: "fable", effort: "high" };
  }
  if (
    planReviewGate &&
    [
      "planner",
      "architect",
      "critic",
      "code-reviewer",
      "quality-reviewer",
    ].includes(agent)
  ) {
    return { model: "fable", effort: "high" };
  }
  if (
    [
      "explore",
      "spark",
      "communication-relay",
      "summarizer",
      "classifier",
      "triage",
      "translator",
      "formatter",
    ].includes(agent)
  ) {
    return { model: "haiku", effort: "low" };
  }
  if (
    [
      "architect",
      "planner",
      "critic",
      "analyst",
      "debugger",
      "deep-executor",
      "scientist-deep",
      "designer",
      "document-specialist",
      "code-reviewer",
      "quality-reviewer",
      "lead",
    ].includes(agent)
  ) {
    return { model: "opus", effort: "high" };
  }
  if (
    ["writer", "researcher", "communication-report", "communication"].includes(
      agent,
    )
  ) {
    return { model: "opus", effort: "medium" };
  }
  if (["verifier", "qa-tester", "scientist"].includes(agent)) {
    return { model: "sonnet", effort: "high" };
  }
  if (["build-fixer", "cleanup", "deslop"].includes(agent)) {
    return { model: "sonnet", effort: "low" };
  }
  return { model: "sonnet", effort: "medium" };
}

export function resolveWorkerEffort(cli, agent, effort, nested) {
  if (
    effort === "ultra" &&
    (cli === "claude" ||
      nested ||
      (cli === "codex" && !ULTRA_ELIGIBLE_CODEX_AGENTS.has(agent)))
  )
    return "max";
  return effort || null;
}

// 조회와 실행은 같은 역할 정책과 read-only resolver를 사용한다.
// routing을 전달하면 이미 끝난 pre-route 판단을 재사용한다.
export async function resolveWorkerModel(
  {
    task = "",
    agent = "executor",
    cli = "codex",
    model,
    effort,
    profile = "auto",
    nested = true,
    protectedPolicy = null,
  } = {},
  options = {},
) {
  cli = cli === "antigravity" ? "agy" : cli;
  if (!["codex", "claude", "agy"].includes(cli))
    throw new Error(`알 수 없는 CLI: ${cli}`);
  const env = options.env || process.env;
  const readOnly = { ...options, env, allowCommand: false, persist: false };
  const { isJevEnabled, judgeTaskRouting } = await import(
    "../../hub/lib/jev-addon.mjs"
  );
  const enabled = isJevEnabled({ ...options, env });
  let routing = options.routing;
  let failure =
    options.fallbackReason || (enabled ? "jev_unavailable" : "jev_disabled");
  const explicitPair = Boolean(model || effort);
  const explicitProfile = profile && profile !== "auto";
  if (!protectedPolicy && ["code-reviewer", "quality-reviewer"].includes(agent))
    protectedPolicy = "review";
  if (
    routing === undefined &&
    enabled &&
    !explicitPair &&
    !explicitProfile &&
    !protectedPolicy
  ) {
    try {
      routing = await judgeTaskRouting(
        { prompt: task, agentType: agent, cliType: cli },
        {
          ...options,
          includeDiagnostics: true,
          onDiagnostic: (reason) => {
            failure = reason;
          },
        },
      );
    } catch {
      failure = "jev_error";
    }
  }
  const confidence = routing?.modelDecision?.confidence ?? null;
  let source = "rule";
  let reason = routing?.modelDecision?.reason || failure;
  let selectedProfile =
    cli === "codex"
      ? resolveDirectCodexRoutePolicy(agent).profile
      : cli === "agy"
        ? resolveAgyProfileForPurpose(agent)
        : null;
  if (explicitPair && protectedPolicy !== "retry") {
    return {
      cli,
      agent,
      family: null,
      model: model || null,
      effort: resolveWorkerEffort(cli, agent, effort, nested),
      profile: null,
      confidence: null,
      enabled,
      source: "explicit",
      reason: "explicit_model_effort_preserved",
      fallbackReason: null,
    };
  }
  if (explicitProfile || protectedPolicy) {
    source = protectedPolicy || "explicit";
    reason = protectedPolicy
      ? `${protectedPolicy}_policy_preserved`
      : "explicit_profile_preserved";
    if (explicitProfile) selectedProfile = profile;
  } else if (routing) {
    const decomposable =
      routing.vendorAdjustment?.decomposable ?? routing.decomposable ?? null;
    const effectiveTierShift =
      routing.tierShift === "lower" && decomposable === false
        ? null
        : routing.tierShift;
    const recommended =
      cli === "codex"
        ? routing.codexProfile
        : cli === "agy"
          ? routing.agyProfile
          : routing.claudeModel;
    if (recommended) {
      if (cli !== "claude") selectedProfile = recommended;
      source = "jev";
      reason = "jev_applied";
    } else if (routing.tierShift === "lower" && decomposable === false) {
      reason = "non_decomposable_floor_preserved";
    } else if (cli === "codex" && effectiveTierShift) {
      const shifted = shiftCodexAgentProfile(agent, effectiveTierShift);
      if (effectiveTierShift === "lower" && NO_LOWER_CODEX_AGENTS.has(agent))
        reason = "role_floor_preserved";
      else {
        selectedProfile = shifted;
        source = "jev";
        reason = `jev_tier_${effectiveTierShift}`;
      }
    } else if (routing.modelDecision?.reason === "accepted") {
      reason = "role_default_preserved";
    }
  }
  let selected;
  if (cli === "codex") {
    selectedProfile = nested
      ? resolveNestedCodexAgentProfile(agent, {
          profileOverride: selectedProfile,
          codexHome: options.codexHome || env.CODEX_HOME,
        })
      : resolveCodexAgentProfile(agent, {
          profileOverride: selectedProfile,
          allowCustom: true,
        });
    const spec =
      modelEffortFromProfile("codex", selectedProfile) ||
      resolveCodexProfileConfigValues(selectedProfile, readOnly);
    selected = spec.family
      ? resolveCodexModelEffort(spec, readOnly)
      : { family: null, ...spec };
  } else if (cli === "agy") {
    const spec = modelEffortFromProfile("agy", selectedProfile);
    selected = spec
      ? resolveAgyModelEffort(spec, readOnly)
      : {
          family: null,
          model: resolveAgyModel(selectedProfile, readOnly),
          effort: null,
        };
  } else {
    selected = {
      family: null,
      ...resolveClaudeWorkerDefaults(agent, {
        planReviewGate: env?.TFX_PLAN_REVIEW_GATE === "1",
      }),
    };
    if (source === "jev")
      selected = {
        family: null,
        model:
          agent === "lead" && routing.claudeModel === "fable"
            ? "opus"
            : routing.claudeModel,
        effort: routing.claudeEffort,
      };
    // 작성 벤더별 리뷰 effort는 자동 추천보다 우선한다.
    if (
      ["code-reviewer", "quality-reviewer", "security-reviewer"].includes(agent)
    )
      selected.effort = "high";
  }
  return {
    cli,
    agent,
    ...selected,
    profile: selectedProfile,
    confidence,
    enabled,
    source,
    reason,
    fallbackReason: source === "rule" ? reason : null,
  };
}

export function resolveAgentRoute(
  agent,
  map,
  profileOverride = "auto",
  nested = false,
  agyProfileResolver = resolveAgyProfileForPurpose,
  {
    reviewAuthor = "codex",
    weeklyPercent = 0,
    includeCandidates = false,
    env,
    quotaSnapshot,
  } = {},
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
  let candidateResult = null;

  if (includeCandidates) {
    candidateResult = resolveRoleCandidates({
      agent,
      env: env || process.env,
      quotaSnapshot,
      reviewAuthor:
        byAuthor ||
        (agent === "security-reviewer" &&
          env != null &&
          Object.hasOwn(env, "TFX_REVIEW_AUTHOR") &&
          env.TFX_REVIEW_AUTHOR !== undefined)
          ? reviewAuthor
          : undefined,
      nested,
    });
    if (candidateResult.candidates.length > 0) {
      provider = candidateResult.candidates[0].cli;
    } else {
      provider = "";
    }
    usageSwitch = candidateResult.usageSwitch;
  } else if (byAuthor) {
    if (!["codex", "claude", "antigravity"].includes(reviewAuthor)) {
      throw new Error(
        `TFX_REVIEW_AUTHOR 값이 유효하지 않습니다: ${reviewAuthor}`,
      );
    }
    usageSwitch =
      reviewAuthor === "codex" &&
      Number.isFinite(weeklyPercent) &&
      weeklyPercent > CLAUDE_REVIEW_USAGE_THRESHOLD;
    if (reviewAuthor === "claude") provider = "codex";
    else if (reviewAuthor === "antigravity") provider = "codex";
    else if (usageSwitch) provider = "antigravity";
    else provider = "claude";
  }

  const policy = resolveDirectCodexRoutePolicy(agent);
  const normalizedOverride = normalizeCodexProfileName(profileOverride);
  const selectedCandidate = candidateResult?.candidates[0] || null;
  let resolvedOverride =
    (selectedCandidate?.cli === "codex"
      ? selectedCandidate.profile
      : candidateResult?.candidates.find((c) => c.cli === "codex")?.profile) ||
    policy.profile;
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
  const geminiProfile =
    (selectedCandidate?.cli === "antigravity"
      ? selectedCandidate.profile
      : candidateResult?.candidates.find((c) => c.cli === "antigravity")
          ?.profile) || agyProfileResolver(agent);

  const baseRoute = [
    provider,
    policy.profile,
    policy.timeoutSec,
    policy.mcpHint,
    policy.subcommand,
    normalizedOverride,
    resolvedOverride,
    geminiProfile,
    EXPECTED_DURATION_BY_AGENT[agent] ?? 30,
    NATIVE_CODEX_AGENTS.has(agent),
    candidateResult
      ? candidateResult.reviewAuthor
      : byAuthor
        ? reviewAuthor
        : "",
    usageSwitch,
    effort,
    family,
  ];
  if (includeCandidates) {
    baseRoute.push(
      JSON.stringify(candidateResult.candidates),
      JSON.stringify(candidateResult.excluded),
    );
  }
  return baseRoute;
}

function parseCliArgs(argv) {
  const args = [...argv];
  let format = "json";
  let agent = DEFAULT_CODEX_AGENT;
  let mapFile = "";
  let profileOverride = "auto";
  let agyProfilesModule = "";
  let nested = false;
  let tierShift = "";
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--format") format = args.shift() || "";
    else if (flag === "--agent") agent = args.shift() || "";
    else if (flag === "--map-file") mapFile = args.shift() || "";
    else if (flag === "--profile-override")
      profileOverride = args.shift() || "";
    else if (flag === "--agy-profiles-module")
      agyProfilesModule = args.shift() || "";
    else if (flag === "--nested") nested = true;
    else if (flag === "--tier-shift") tierShift = args.shift() || "";
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!new Set(["json", "tsv", "route", "candidates"]).has(format)) {
    throw new Error(`unsupported format: ${format}`);
  }
  return {
    format,
    agent,
    mapFile,
    profileOverride,
    agyProfilesModule,
    nested,
    tierShift,
  };
}

async function runCli() {
  const {
    format,
    agent,
    mapFile,
    profileOverride,
    agyProfilesModule,
    nested,
    tierShift,
  } = parseCliArgs(process.argv.slice(2));
  if (format === "candidates") {
    const result = resolveRoleCandidates({
      agent,
      env: process.env,
      nested,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "route") {
    if (!mapFile) throw new Error("--map-file is required for route format");
    const routedProfile =
      tierShift && normalizeCodexProfileName(profileOverride) === "auto"
        ? shiftCodexAgentProfile(agent, tierShift)
        : profileOverride;
    const map = JSON.parse(readFileSync(mapFile, "utf8"));
    let resolver = resolveAgyProfileForPurpose;
    if (agyProfilesModule) {
      try {
        const module = await import(pathToFileURL(agyProfilesModule).href);
        resolver = (agentName) => {
          try {
            return module.resolveAgyProfileForPurpose(agentName) || "hydrogen";
          } catch {
            return "hydrogen";
          }
        };
      } catch {
        resolver = () => "hydrogen";
      }
    }
    process.stdout.write(
      resolveAgentRoute(agent, map, routedProfile, nested, resolver, {
        reviewAuthor: process.env.TFX_REVIEW_AUTHOR ?? "codex",
        includeCandidates: true,
        env: process.env,
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

const _isEvalInvocation = process.execArgv.some(
  (arg) => arg === "-e" || arg === "--eval" || arg.startsWith("--eval="),
);
if (
  !_isEvalInvocation &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`[agent-route-policy] ${error.message}\n`);
    process.exitCode = 1;
  }
}
