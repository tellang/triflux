// tests/unit/dynamic-router-factory.test.mjs
//
// PRD: .omx/plans/prd-dynamic-routing-engine.md  (Phase 1 — caller facade)
//
// Verifies `createDynamicRouter()` / `routeRequest()` opt-in env gating,
// snapshot provider injection, and policy loading without disturbing the
// pure-fn Phase 0 contract.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  __internal__,
  createDynamicRouter,
  isDynamicRoutingEnabled,
  routeRequest,
} from "../../hub/dynamic-routing-engine.mjs";

const NOW = 1778832000000; // 2026-05-15T08:00:00.000Z
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const ENABLED_ENV = { TRIFLUX_DYNAMIC_ROUTING: "1" };

function mkClaude({ weekly = 30, resetIn = 5 * DAY } = {}) {
  return {
    fiveHourPercent: 10,
    weeklyPercent: weekly,
    fiveHourResetsAt: NOW + 4 * HOUR,
    weeklyResetsAt: NOW + resetIn,
    observedAt: NOW - 60_000,
    isStale: false,
    source: "test",
  };
}

function mkCodex({ primaryPct = 30, resetIn = 5 * DAY } = {}) {
  return {
    buckets: {
      codex: {
        primary: { usedPercent: primaryPct, resetsAt: NOW + resetIn },
        secondary: { usedPercent: primaryPct, resetsAt: NOW + resetIn },
      },
    },
    observedAt: NOW - 60_000,
    isStale: false,
    source: "test",
  };
}

function mkBroker() {
  return {
    claude: [],
    codex: [
      {
        id: "codex-1",
        tier: "pro",
        busy: false,
        cooldownUntil: null,
        lastUsedAt: NOW - HOUR,
        remainingMs: null,
        circuitState: "closed",
        failureCount: 0,
        expiresAt: null,
        drainAfter: null,
        provider: "codex",
      },
    ],
    gemini: [],
  };
}

function mkSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    observedAt: NOW,
    claude: mkClaude(),
    codex: mkCodex(),
    broker: mkBroker(),
    ...overrides,
  };
}

describe("isDynamicRoutingEnabled", () => {
  it("returns false when env flag is absent", () => {
    assert.equal(isDynamicRoutingEnabled({}), false);
  });

  it("returns true when env=1", () => {
    assert.equal(
      isDynamicRoutingEnabled({ TRIFLUX_DYNAMIC_ROUTING: "1" }),
      true,
    );
  });

  it("returns true when env=true", () => {
    assert.equal(
      isDynamicRoutingEnabled({ TRIFLUX_DYNAMIC_ROUTING: "true" }),
      true,
    );
  });

  it("returns false when env=0", () => {
    assert.equal(
      isDynamicRoutingEnabled({ TRIFLUX_DYNAMIC_ROUTING: "0" }),
      false,
    );
  });

  it("returns false when env=false", () => {
    assert.equal(
      isDynamicRoutingEnabled({ TRIFLUX_DYNAMIC_ROUTING: "false" }),
      false,
    );
  });

  it("returns false when env=arbitrary", () => {
    assert.equal(
      isDynamicRoutingEnabled({ TRIFLUX_DYNAMIC_ROUTING: "yes" }),
      false,
    );
  });
});

describe("createDynamicRouter — null-router (env absent)", () => {
  it("reports enabled=false", () => {
    const router = createDynamicRouter({ env: {} });
    assert.equal(router.enabled, false);
  });

  it("returns fallback decision regardless of snapshot or policy", async () => {
    const router = createDynamicRouter({
      env: {},
      // Even with an injected snapshot/policy, opt-in env absent → null-router.
      policy: { scenarios: [] },
      snapshotProvider: async () => mkSnapshot(),
      nowFn: () => NOW,
    });
    const decision = await router.routeRequest({ team_size: 1 });
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.lane, "single");
    assert.equal(decision.shards.length, 1);
    assert.equal(decision.shards[0].cli, "codex");
    assert.ok(decision.fallback);
    assert.equal(decision.fallback.action, "codex-default");
  });

  it("getPolicy() returns null when env is absent", () => {
    const router = createDynamicRouter({ env: {} });
    assert.equal(router.getPolicy(), null);
  });

  it("does NOT invoke snapshotProvider when env is absent", async () => {
    let calls = 0;
    const router = createDynamicRouter({
      env: {},
      snapshotProvider: async () => {
        calls += 1;
        return mkSnapshot();
      },
      nowFn: () => NOW,
    });
    await router.routeRequest({});
    assert.equal(calls, 0);
  });
});

describe("createDynamicRouter — enabled router", () => {
  it("reports enabled=true and loads default policy", () => {
    const router = createDynamicRouter({ env: ENABLED_ENV });
    assert.equal(router.enabled, true);
    const policy = router.getPolicy();
    assert.ok(policy, "policy should load from disk");
    assert.ok(Array.isArray(policy.scenarios));
    assert.ok(policy.scenarios.length >= 6);
  });

  it("evaluates S3 scenario (claude-burned-codex-fresh) with injected snapshot", async () => {
    const router = createDynamicRouter({
      env: ENABLED_ENV,
      nowFn: () => NOW,
    });
    const snapshot = mkSnapshot({
      claude: mkClaude({ weekly: 90, resetIn: 5 * DAY }),
      codex: mkCodex({ primaryPct: 10, resetIn: 5 * DAY }),
    });
    const decision = await router.routeRequest({}, { snapshot });
    assert.equal(decision.mode, "dynamic-overlay");
    assert.equal(decision.scenario, "S3");
    assert.equal(decision.lane, "single");
    assert.equal(decision.shards[0].cli, "codex");
  });

  it("falls back when policy is explicitly null", async () => {
    const router = createDynamicRouter({
      env: ENABLED_ENV,
      policy: null,
      nowFn: () => NOW,
    });
    const decision = await router.routeRequest({}, { snapshot: mkSnapshot() });
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "policy_missing");
  });

  it("calls snapshotProvider with forceRefresh + now when no snapshot is given", async () => {
    const captured = [];
    const router = createDynamicRouter({
      env: ENABLED_ENV,
      policy: { scenarios: [], freshness: {}, fallback: {} },
      snapshotProvider: async (args) => {
        captured.push(args);
        return mkSnapshot();
      },
      nowFn: () => NOW,
    });
    await router.routeRequest({}, { forceRefresh: true });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].forceRefresh, true);
    assert.equal(captured[0].now, NOW);
  });

  it("skips snapshotProvider when caller supplies snapshot directly", async () => {
    let calls = 0;
    const router = createDynamicRouter({
      env: ENABLED_ENV,
      policy: { scenarios: [], freshness: {}, fallback: {} },
      snapshotProvider: async () => {
        calls += 1;
        return mkSnapshot();
      },
      nowFn: () => NOW,
    });
    await router.routeRequest({}, { snapshot: mkSnapshot() });
    assert.equal(calls, 0);
  });

  it("returns fallback when policy load fails (bad path)", async () => {
    const router = createDynamicRouter({
      env: ENABLED_ENV,
      policyPath: "/nonexistent/policy-does-not-exist.json",
      nowFn: () => NOW,
    });
    assert.equal(router.getPolicy(), null);
    const decision = await router.routeRequest({}, { snapshot: mkSnapshot() });
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "policy_missing");
  });

  it("uses caller-supplied now over nowFn", async () => {
    const router = createDynamicRouter({
      env: ENABLED_ENV,
      policy: { scenarios: [], freshness: {}, fallback: {} },
      snapshotProvider: async ({ now }) => mkSnapshot({ observedAt: now }),
      nowFn: () => 0,
    });
    const captured = [];
    const router2 = createDynamicRouter({
      env: ENABLED_ENV,
      policy: { scenarios: [], freshness: {}, fallback: {} },
      snapshotProvider: async (args) => {
        captured.push(args);
        return mkSnapshot();
      },
      nowFn: () => 0,
    });
    await router2.routeRequest({}, { now: NOW });
    assert.equal(captured[0].now, NOW);
    // smoke-check that router still works with default now path
    const decision = await router.routeRequest({});
    assert.ok(decision);
  });
});

describe("routeRequest top-level convenience", () => {
  it("works with zero opts (defaults to null-router on bare env)", async () => {
    const decision = await routeRequest({}, { env: {}, nowFn: () => NOW });
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.scenario, "fallback");
  });

  it("delegates to createDynamicRouter with provided opts", async () => {
    const decision = await routeRequest(
      {},
      {
        env: ENABLED_ENV,
        policy: { scenarios: [], freshness: {}, fallback: {} },
        snapshotProvider: async () => mkSnapshot(),
        nowFn: () => NOW,
      },
    );
    // No scenario matched in empty scenarios array → fallback.
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.fallback.trigger, "no_scenario_matched");
  });
});

describe("__internal__ exports", () => {
  it("exposes loadPolicy + isDynamicRoutingEnabled for callers", () => {
    assert.equal(typeof __internal__.loadPolicy, "function");
    assert.equal(typeof __internal__.isDynamicRoutingEnabled, "function");
    assert.equal(typeof __internal__.DEFAULT_POLICY_PATH, "string");
  });

  it("loadPolicy returns null for bad path", () => {
    const policy = __internal__.loadPolicy("/nonexistent/bad-path.json");
    assert.equal(policy, null);
  });

  it("loadPolicy returns parsed policy for the production file", () => {
    const policy = __internal__.loadPolicy();
    assert.ok(policy);
    assert.ok(Array.isArray(policy.scenarios));
  });
});
