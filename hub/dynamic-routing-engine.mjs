// hub/dynamic-routing-engine.mjs
//
// PRD: .omx/plans/prd-dynamic-routing-engine.md
//
// Phase 0 — pure deterministic classifier. Takes a `request`, a `snapshot`
// (from `hub/routing-snapshot.mjs`), and a `policy` (loaded from
// `config/routing-policy.json`), then emits a single `RouteDecision`.
//
// Phase 0 contract:
//   - no callers yet (dormant). conductor/swarm/tfx-route.sh integration is Phase 1+.
//   - pure function: same (request, snapshot, policy) → same RouteDecision.
//   - no network, no disk reads, no clock reads outside the explicit `now` arg.
//   - fallback policy = codex-default. fails closed.
//   - scenario evaluators are first-match-wins in policy.scenarios order.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRoutingSnapshot } from "./routing-snapshot.mjs";

function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function hashInputs(request, snapshot) {
  return createHash("sha256")
    .update(stableStringify({ request, snapshot }))
    .digest("hex")
    .slice(0, 16);
}

function makeFallback(policy, trigger, inputsHash, now) {
  const fb = policy?.fallback ?? {};
  return {
    decisionId: inputsHash,
    mode: fb.default_mode ?? "codex-default",
    scenario: "fallback",
    lane: "single",
    shards: [
      {
        cli: fb.default_cli ?? "codex",
        accountId: null,
        model: fb.default_model ?? "gpt-5.6-terra",
        riskTier: "safe",
        reason: trigger,
      },
    ],
    rationale: {
      inputsHash,
      biasScore: null,
      alternatives: [],
    },
    fallback: { trigger, action: "codex-default" },
    snapshotAgeMs: snapshotAge(undefined, now),
    confidence: 50,
  };
}

function snapshotAge(snapshot, now) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const observed = Number(snapshot.observedAt);
  if (!Number.isFinite(observed)) return null;
  return Math.max(0, now - observed);
}

function checkFreshness(snapshot, freshness, now) {
  if (!snapshot) return "hud_null";
  const max = freshness?.max_snapshot_age_ms ?? 900_000;
  const skewMax = freshness?.max_cross_provider_skew_ms ?? 300_000;

  const claude = snapshot.claude;
  const codex = snapshot.codex;
  if (!claude && !codex) return "hud_null";
  if (claude && (claude.isStale || claude.error))
    return "claude_stale_or_error";
  if (codex && (codex.isStale || codex.error)) return "codex_stale_or_error";

  const claudeAge = claude?.observedAt ? now - claude.observedAt : null;
  const codexAge = codex?.observedAt ? now - codex.observedAt : null;
  if (claudeAge !== null && claudeAge > max) return "claude_age_exceeded";
  if (codexAge !== null && codexAge > max) return "codex_age_exceeded";
  if (claudeAge !== null && codexAge !== null) {
    if (Math.abs(claudeAge - codexAge) > skewMax)
      return "cross_provider_skew_exceeded";
  }

  if (claude?.weeklyResetsAt !== null && claude?.weeklyResetsAt !== undefined) {
    if (
      claude.weeklyResetsAt <
      now - (freshness?.local_clock_skew_guard_ms ?? 60_000)
    ) {
      return "claude_weekly_reset_in_past";
    }
  }

  return null;
}

function brokerAvailableCount(snapshot, provider) {
  const accounts = snapshot?.broker?.[provider] ?? [];
  return accounts.filter((a) => a.circuitState !== "open").length;
}

function brokerAllCircuitsOpen(snapshot) {
  const groups = snapshot?.broker;
  if (!groups) return false;
  const all = [];
  for (const provider of Object.keys(groups)) {
    for (const acct of groups[provider] ?? []) all.push(acct);
  }
  if (all.length === 0) return true;
  return all.every((a) => a.circuitState === "open");
}

// ─── Scenario evaluators ──────────────────────────────────────────────
// Each returns either null (no match) or a partial RouteDecision payload
// `{ scenario, lane, shards, riskTier?, reasonCodes }` to be wrapped by
// `makeScenarioDecision()` below.

function evalS1(ctx) {
  const { snapshot, scenario, policy, now } = ctx;
  const claude = snapshot.claude;
  if (!claude) return null;
  const resetIn = (claude.weeklyResetsAt ?? Number.POSITIVE_INFINITY) - now;
  if (
    resetIn >
    (scenario.when.weeklyResetsAtLteMs ?? policy.thresholds.reset_imminent_ms)
  )
    return null;
  if ((claude.weeklyPercent ?? 100) >= (scenario.when.weeklyPercentLt ?? 100))
    return null;
  if (
    scenario.when.hasMultipleAccounts &&
    brokerAvailableCount(snapshot, "claude") < 2
  )
    return null;
  return {
    lane: scenario.then.lane ?? "multi",
    shards: [
      { cli: "claude", riskTier: "stretch", reason: scenario.then.reason },
    ],
  };
}

function evalS2(ctx) {
  const { snapshot, scenario, policy, now } = ctx;
  const codex = snapshot.codex;
  if (!codex) return null;
  const buckets = codex.buckets ?? {};
  const window =
    scenario.when.weeklyResetsAtLteMs ?? policy.thresholds.reset_imminent_ms;
  const usageCeiling = scenario.when.weeklyPercentLt ?? 100;
  // Inspect both primary and secondary legs so a fresh secondary tier with
  // imminent reset is not silently ignored when primary is exhausted.
  const anyLegMatches = Object.values(buckets).some((b) =>
    [b?.primary, b?.secondary].some((leg) => {
      if (!leg) return false;
      if (!leg.resetsAt) return false;
      if (leg.resetsAt - now > window) return false;
      return (leg.usedPercent ?? 100) < usageCeiling;
    }),
  );
  if (!anyLegMatches) return null;
  return {
    lane: scenario.then.lane ?? "swarm",
    shards: [
      { cli: "codex", riskTier: "stretch", reason: scenario.then.reason },
    ],
  };
}

function evalS3(ctx) {
  const { snapshot, scenario, now } = ctx;
  const claude = snapshot.claude;
  const codex = snapshot.codex;
  if (!claude || !codex) return null;
  if ((claude.weeklyPercent ?? 0) < scenario.when.claude_weekly_percent_gte)
    return null;
  const codexAnyBucket = Object.values(codex.buckets ?? {}).some(
    (b) =>
      (b?.primary?.usedPercent ?? 100) < scenario.when.codex_weekly_percent_lt,
  );
  if (!codexAnyBucket) return null;
  const resetIn = (claude.weeklyResetsAt ?? 0) - now;
  if (resetIn <= scenario.when.claude_weekly_resets_at_gt_ms) return null;
  return {
    lane: scenario.then.lane ?? "single",
    shards: [{ cli: "codex", riskTier: "safe", reason: scenario.then.reason }],
  };
}

function evalS4(ctx) {
  const { snapshot, scenario } = ctx;
  const claude = snapshot.broker?.claude ?? [];
  if (claude.length < (scenario.when.accountCountGte ?? 2)) return null;
  // Staggered = at least 2 distinct cooldown/expiresAt anchors.
  const anchors = new Set(
    claude.map((a) => `${a.cooldownUntil ?? 0}-${a.expiresAt ?? 0}`),
  );
  if (scenario.when.staggered && anchors.size < 2) return null;
  return {
    lane: scenario.then.lane ?? "multi",
    shards: claude.map((a) => ({
      cli: "claude",
      accountId: a.id,
      riskTier: "stretch",
      reason: scenario.then.reason,
    })),
  };
}

function evalS5(ctx) {
  const { request, snapshot, scenario } = ctx;
  if ((request?.team_size ?? 1) < (scenario.when.request_team_size_gte ?? 2))
    return null;
  const claude = snapshot.broker?.claude ?? [];
  if (claude.length < (scenario.when.accountCountGte ?? 2)) return null;
  const wanted = Math.min(request.team_size, claude.length);
  return {
    lane: scenario.then.lane ?? "swarm",
    atomic: scenario.then.atomic,
    atomicPolicy: scenario.then.atomic_policy ?? "balanced",
    shards: claude.slice(0, wanted).map((a) => ({
      cli: "claude",
      accountId: a.id,
      riskTier: "stretch",
      reason: scenario.then.reason,
    })),
  };
}

function evalS6(ctx) {
  const { snapshot, scenario, now } = ctx;
  const all = [];
  for (const p of Object.keys(snapshot.broker ?? {})) {
    const accounts = snapshot.broker[p];
    if (!Array.isArray(accounts)) continue;
    for (const a of accounts) all.push({ ...a, provider: p });
  }
  const window = scenario.when.expiresAtLteMs ?? 604_800_000;
  const usageCeiling = scenario.when.weeklyPercentLt ?? null;
  const expiring = all.filter((a) => {
    if (!a.expiresAt) return false;
    // Past-dated expirations are dead accounts, not drain targets.
    if (a.expiresAt - now <= 0) return false;
    if (a.expiresAt - now > window) return false;
    if (scenario.when.circuitStateNotOpen && a.circuitState === "open")
      return false;
    if (usageCeiling !== null) {
      const usage = providerUsagePercent(snapshot, a.provider);
      if (usage !== null && usage >= usageCeiling) return false;
    }
    return true;
  });
  if (expiring.length === 0) return null;
  return {
    lane: scenario.then.lane ?? "single",
    riskTier: scenario.then.riskTier ?? "drain",
    shards: expiring.map((a) => ({
      cli: a.provider === "claude" ? "claude" : "codex",
      accountId: a.id,
      riskTier: "drain",
      reason: scenario.then.reason,
    })),
  };
}

function providerUsagePercent(snapshot, provider) {
  if (provider === "claude") {
    return typeof snapshot.claude?.weeklyPercent === "number"
      ? snapshot.claude.weeklyPercent
      : null;
  }
  if (provider === "codex") {
    const buckets = Object.values(snapshot.codex?.buckets ?? {});
    if (buckets.length === 0) return null;
    let max = 0;
    for (const b of buckets) {
      for (const leg of [b?.primary, b?.secondary]) {
        if (typeof leg?.usedPercent === "number" && leg.usedPercent > max) {
          max = leg.usedPercent;
        }
      }
    }
    return max;
  }
  return null;
}

const SCENARIO_EVALUATORS = {
  S1: evalS1,
  S2: evalS2,
  S3: evalS3,
  S4: evalS4,
  S5: evalS5,
  S6: evalS6,
};

function makeScenarioDecision({ match, scenario, inputsHash, snapshot, now }) {
  return {
    decisionId: inputsHash,
    mode: "dynamic-overlay",
    scenario: scenario.id,
    lane: match.lane,
    shards: match.shards,
    atomic: match.atomic ?? null,
    atomicPolicy: match.atomicPolicy ?? null,
    rationale: {
      inputsHash,
      biasScore: null,
      alternatives: [],
      scenarioName: scenario.name,
    },
    fallback: { trigger: null, action: "codex-default" },
    snapshotAgeMs: snapshotAge(snapshot, now),
    confidence: 72,
  };
}

function brokerIsEmpty(snapshot) {
  const groups = snapshot?.broker;
  if (!groups || typeof groups !== "object") return true;
  for (const p of Object.keys(groups)) {
    const accounts = groups[p];
    if (Array.isArray(accounts) && accounts.length > 0) return false;
  }
  return true;
}

/**
 * @param {object} request
 * @param {object} snapshot
 * @param {object} policy
 * @param {object} options
 * @param {number} options.now — REQUIRED. Pure-fn contract: callers must
 *   supply the current epoch; the engine itself never reads the clock.
 */
export function evaluateDynamicRoute(request, snapshot, policy, options) {
  if (!options || typeof options.now !== "number") {
    throw new TypeError(
      "evaluateDynamicRoute: options.now (epoch ms) is required for pure-fn contract",
    );
  }
  const { now } = options;
  const inputsHash = hashInputs(request, snapshot);

  if (!policy || !Array.isArray(policy.scenarios)) {
    return makeFallback(
      { fallback: { default_mode: "codex-default" } },
      "policy_missing",
      inputsHash,
      now,
    );
  }

  const freshnessVeto = checkFreshness(snapshot, policy.freshness, now);
  if (freshnessVeto)
    return makeFallback(policy, freshnessVeto, inputsHash, now);

  if (brokerIsEmpty(snapshot)) {
    return makeFallback(policy, "broker_empty", inputsHash, now);
  }

  if (brokerAllCircuitsOpen(snapshot)) {
    return makeFallback(policy, "all_circuits_open", inputsHash, now);
  }

  for (const scenario of policy.scenarios) {
    const evaluator = SCENARIO_EVALUATORS[scenario.id];
    if (!evaluator) continue;
    const match = evaluator({
      request: request ?? {},
      snapshot,
      scenario,
      policy,
      now,
    });
    if (match)
      return makeScenarioDecision({
        match,
        scenario,
        inputsHash,
        snapshot,
        now,
      });
  }

  return makeFallback(policy, "no_scenario_matched", inputsHash, now);
}

// ─── Phase 1 — caller-friendly facade ─────────────────────────────────
//
// Phase 0 keeps `evaluateDynamicRoute()` pure. Callers (conductor,
// swarm-hypervisor, tfx-route.sh) would otherwise duplicate the same
// plumbing: snapshot build + policy load + clock read. The facade below
// folds that plumbing into a single factory with opt-in env gating.
//
// Contract:
//   - `evaluateDynamicRoute()` pure-fn signature is preserved unchanged.
//   - `createDynamicRouter()` returns a router whose `routeRequest()` is
//     a `null-router` (always emits the fallback decision) unless the
//     opt-in `TRIFLUX_DYNAMIC_ROUTING` env flag is set.
//   - Callers can inject `policy`, `snapshot`, `snapshotProvider`, `nowFn`
//     for deterministic testing without touching disk or HUD providers.

const DEFAULT_POLICY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "routing-policy.json",
);

export function isDynamicRoutingEnabled(env = process.env) {
  const flag = env.TRIFLUX_DYNAMIC_ROUTING;
  return flag === "1" || flag === "true";
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  // Missing/invalid policy → null. evaluateDynamicRoute() will then fall
  // back to codex-default, which is the documented fail-closed behaviour.
  try {
    const raw = readFileSync(policyPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Caller-friendly factory. Works with zero arguments — defaults to
 * `process.env`, the production `routing-policy.json`, and a snapshot
 * provider that calls `buildRoutingSnapshot()`. Opt-in env-gated:
 * `TRIFLUX_DYNAMIC_ROUTING=1|true` enables scenario evaluation; anything
 * else returns a null-router that always emits the fallback decision.
 *
 * @param {object} [opts]
 * @param {string} [opts.policyPath] — override the policy file path.
 * @param {object} [opts.policy] — inject a policy object directly (testing).
 * @param {(args:{forceRefresh:boolean, now:number}) => Promise<object>} [opts.snapshotProvider]
 * @param {NodeJS.ProcessEnv} [opts.env] — override env (testing).
 * @param {() => number} [opts.nowFn] — override clock (testing).
 */
export function createDynamicRouter(opts = {}) {
  const env = opts.env || process.env;
  const enabled = isDynamicRoutingEnabled(env);
  const policy =
    opts.policy !== undefined
      ? opts.policy
      : enabled
        ? loadPolicy(opts.policyPath)
        : null;
  const snapshotProvider =
    opts.snapshotProvider ||
    (async ({ forceRefresh, now }) =>
      buildRoutingSnapshot({ forceRefresh, now }));
  const nowFn = opts.nowFn || (() => Date.now());

  return {
    enabled,
    /**
     * @param {object} request
     * @param {{ snapshot?: object, now?: number, forceRefresh?: boolean }} [callOpts]
     * @returns {Promise<object>} RouteDecision
     */
    async routeRequest(request, callOpts = {}) {
      const now = typeof callOpts.now === "number" ? callOpts.now : nowFn();
      if (!enabled) {
        // null-router: opt-in env absent → always fallback decision.
        return evaluateDynamicRoute(request, {}, null, { now });
      }
      const snapshot =
        callOpts.snapshot !== undefined
          ? callOpts.snapshot
          : await snapshotProvider({
              forceRefresh: Boolean(callOpts.forceRefresh),
              now,
            });
      return evaluateDynamicRoute(request, snapshot, policy, { now });
    },
    getPolicy() {
      return policy;
    },
  };
}

/**
 * Top-level convenience. Equivalent to
 * `createDynamicRouter(opts).routeRequest(request, opts)`.
 */
export async function routeRequest(request, opts = {}) {
  const router = createDynamicRouter(opts);
  return router.routeRequest(request, opts);
}

export const __internal__ = {
  hashInputs,
  checkFreshness,
  brokerAvailableCount,
  brokerAllCircuitsOpen,
  brokerIsEmpty,
  providerUsagePercent,
  SCENARIO_EVALUATORS,
  loadPolicy,
  isDynamicRoutingEnabled,
  DEFAULT_POLICY_PATH,
};
