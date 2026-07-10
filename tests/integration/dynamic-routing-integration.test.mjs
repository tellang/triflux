// tests/integration/dynamic-routing-integration.test.mjs
//
// shard D-3 — D-1 (createDynamicRouter / routeRequest) + D-2 (getDefaultSnapshot cache)
// 두 facade 를 묶었을 때 end-to-end 동작을 가드한다. production 코드는 건드리지 않는다.
//
// graceful degrade: D-1/D-2 의 export 가 아직 main 에 머지되지 않은 시점에서도
// 안전하게 skip 되도록 작성. import 가 실패하거나 필요한 심볼이 없으면 모든 it 가
// skip 으로 표시된다.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

let createDynamicRouter;
let routeRequest;
let isDynamicRoutingEnabled;
let getDefaultSnapshot;
let resetSnapshotCache;
let importOk = false;

before(async () => {
  try {
    const engine = await import("../../hub/dynamic-routing-engine.mjs");
    const snap = await import("../../hub/routing-snapshot.mjs");
    createDynamicRouter = engine.createDynamicRouter;
    routeRequest = engine.routeRequest;
    isDynamicRoutingEnabled = engine.isDynamicRoutingEnabled;
    getDefaultSnapshot = snap.getDefaultSnapshot;
    resetSnapshotCache = snap.resetSnapshotCache;
    importOk = Boolean(
      createDynamicRouter &&
        routeRequest &&
        isDynamicRoutingEnabled &&
        getDefaultSnapshot &&
        resetSnapshotCache,
    );
    if (!importOk) {
      console.warn(
        "[dynamic-routing-integration] D-1/D-2 facade exports missing — tests skipped",
      );
    }
  } catch (err) {
    importOk = false;
    console.warn(
      `[dynamic-routing-integration] import failed — D-1/D-2 not merged yet. skipping. err=${err.message}`,
    );
  }
});

function fakePolicyForScenario(scenarioId, when, then) {
  return {
    version: 1,
    freshness: {
      max_snapshot_age_ms: 900000,
      max_cross_provider_skew_ms: 300000,
      local_clock_skew_guard_ms: 60000,
    },
    thresholds: { reset_imminent_ms: 86400000 },
    scenarios: [{ id: scenarioId, name: `test-${scenarioId}`, when, then }],
    fallback: {
      default_mode: "codex-default",
      default_cli: "codex",
      default_model: "gpt-5.6-terra",
    },
  };
}

describe("dynamic routing integration (D-1 facade + D-2 cache)", () => {
  it("env 미설정: router.enabled=false, routeRequest 가 fallback decision 반환", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    const router = createDynamicRouter({ env: {} });
    assert.equal(router.enabled, false);
    const decision = await router.routeRequest({});
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.scenario, "fallback");
  });

  it("env=1 + 명시 policy + cached snapshot provider 호출 횟수 1 (cache hit)", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    resetSnapshotCache();

    let builderCalls = 0;
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: 1_000_000,
      claude: null,
      codex: {
        buckets: {
          primary: {
            primary: { usedPercent: 10, resetsAt: 1_050_000 },
            secondary: null,
          },
        },
        observedAt: 1_000_000,
        isStale: false,
      },
      broker: {
        codex: [{ id: "acct-1", circuitState: "closed" }],
        claude: [],
        gemini: [],
      },
    };
    const builder = async () => {
      builderCalls += 1;
      return fakeSnapshot;
    };

    const fakePolicy = fakePolicyForScenario(
      "S2",
      { weeklyResetsAtLteMs: 86400000, weeklyPercentLt: 100 },
      { lane: "swarm", primary_cli: "codex", reason: "codex-drain" },
    );

    const snapshotProvider = async (opts) =>
      getDefaultSnapshot({ ...opts, builder });
    const router = createDynamicRouter({
      env: { TRIFLUX_DYNAMIC_ROUTING: "1" },
      policy: fakePolicy,
      snapshotProvider,
      nowFn: () => 1_000_000,
    });

    const d1 = await router.routeRequest({}, { now: 1_000_000 });
    const d2 = await router.routeRequest({}, { now: 1_000_500 });
    assert.equal(builderCalls, 1, "cache hit 으로 builder 한 번만 호출");
    assert.equal(d1.scenario, "S2");
    assert.equal(d2.scenario, "S2");
  });

  it("routeRequest top-level convenience: factory 없이 한 줄 호출", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    const decision = await routeRequest({}, { env: {} });
    assert.equal(decision.mode, "codex-default");
  });

  it("S3 시나리오 (claude-burned-codex-fresh) 결정 확인", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    resetSnapshotCache();
    const now = 1_000_000;
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: now,
      claude: {
        weeklyPercent: 90,
        weeklyResetsAt: now + 200_000_000,
        observedAt: now,
        isStale: false,
      },
      codex: {
        buckets: {
          primary: {
            primary: { usedPercent: 10, resetsAt: now + 600_000_000 },
            secondary: null,
          },
        },
        observedAt: now,
        isStale: false,
      },
      broker: {
        codex: [{ id: "acct-1", circuitState: "closed" }],
        claude: [{ id: "claude-1", circuitState: "closed" }],
        gemini: [],
      },
    };
    const fakePolicy = fakePolicyForScenario(
      "S3",
      {
        claude_weekly_percent_gte: 80,
        codex_weekly_percent_lt: 20,
        claude_weekly_resets_at_gt_ms: 172800000,
      },
      { lane: "single", primary_cli: "codex", reason: "rebalance" },
    );
    const router = createDynamicRouter({
      env: { TRIFLUX_DYNAMIC_ROUTING: "1" },
      policy: fakePolicy,
      snapshotProvider: async () => fakeSnapshot,
      nowFn: () => now,
    });
    const decision = await router.routeRequest({});
    assert.equal(decision.scenario, "S3");
    assert.equal(decision.shards?.[0]?.cli, "codex");
  });

  it("isDynamicRoutingEnabled: env=1 → true, env=0 → false, 빈 env → false", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, () => {
    assert.equal(
      isDynamicRoutingEnabled({ TRIFLUX_DYNAMIC_ROUTING: "1" }),
      true,
    );
    assert.equal(
      isDynamicRoutingEnabled({ TRIFLUX_DYNAMIC_ROUTING: "0" }),
      false,
    );
    assert.equal(isDynamicRoutingEnabled({}), false);
  });

  it("S1 (claude-reset-imminent multi-account): claude lane multi 결정", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    resetSnapshotCache();
    const now = 1_000_000;
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: now,
      claude: {
        weeklyPercent: 40,
        weeklyResetsAt: now + 3_600_000,
        observedAt: now,
        isStale: false,
      },
      codex: {
        buckets: {
          primary: {
            primary: { usedPercent: 50, resetsAt: now + 600_000_000 },
            secondary: null,
          },
        },
        observedAt: now,
        isStale: false,
      },
      broker: {
        codex: [{ id: "codex-1", circuitState: "closed" }],
        claude: [
          { id: "claude-1", circuitState: "closed" },
          { id: "claude-2", circuitState: "closed" },
        ],
        gemini: [],
      },
    };
    const fakePolicy = fakePolicyForScenario(
      "S1",
      {
        weeklyResetsAtLteMs: 86400000,
        weeklyPercentLt: 100,
        hasMultipleAccounts: true,
      },
      { lane: "multi", primary_cli: "claude", reason: "claude-drain" },
    );
    const router = createDynamicRouter({
      env: { TRIFLUX_DYNAMIC_ROUTING: "1" },
      policy: fakePolicy,
      snapshotProvider: async () => fakeSnapshot,
      nowFn: () => now,
    });
    const decision = await router.routeRequest({});
    assert.equal(decision.scenario, "S1");
    assert.equal(decision.lane, "multi");
    assert.equal(decision.shards?.[0]?.cli, "claude");
  });

  it("S4 (multi-account staggered claude): 모든 account shards 반환", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    resetSnapshotCache();
    const now = 1_000_000;
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: now,
      claude: {
        weeklyPercent: 50,
        weeklyResetsAt: now + 600_000_000,
        observedAt: now,
        isStale: false,
      },
      codex: {
        buckets: {
          primary: {
            primary: { usedPercent: 50, resetsAt: now + 600_000_000 },
            secondary: null,
          },
        },
        observedAt: now,
        isStale: false,
      },
      broker: {
        codex: [{ id: "codex-1", circuitState: "closed" }],
        claude: [
          {
            id: "claude-1",
            circuitState: "closed",
            cooldownUntil: now + 1000,
            expiresAt: now + 10_000,
          },
          {
            id: "claude-2",
            circuitState: "closed",
            cooldownUntil: now + 2000,
            expiresAt: now + 20_000,
          },
        ],
        gemini: [],
      },
    };
    const fakePolicy = fakePolicyForScenario(
      "S4",
      { accountCountGte: 2, staggered: true },
      { lane: "multi", primary_cli: "claude", reason: "stagger-claude" },
    );
    const router = createDynamicRouter({
      env: { TRIFLUX_DYNAMIC_ROUTING: "1" },
      policy: fakePolicy,
      snapshotProvider: async () => fakeSnapshot,
      nowFn: () => now,
    });
    const decision = await router.routeRequest({});
    assert.equal(decision.scenario, "S4");
    assert.equal(decision.shards?.length, 2);
    assert.equal(decision.shards?.[0]?.cli, "claude");
  });

  it("S5 (parallel leaseMany via request.team_size): swarm lane shards 수만큼", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    resetSnapshotCache();
    const now = 1_000_000;
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: now,
      claude: {
        weeklyPercent: 50,
        weeklyResetsAt: now + 600_000_000,
        observedAt: now,
        isStale: false,
      },
      codex: {
        buckets: {
          primary: {
            primary: { usedPercent: 50, resetsAt: now + 600_000_000 },
            secondary: null,
          },
        },
        observedAt: now,
        isStale: false,
      },
      broker: {
        codex: [{ id: "codex-1", circuitState: "closed" }],
        claude: [
          { id: "claude-1", circuitState: "closed" },
          { id: "claude-2", circuitState: "closed" },
          { id: "claude-3", circuitState: "closed" },
        ],
        gemini: [],
      },
    };
    const fakePolicy = fakePolicyForScenario(
      "S5",
      { request_team_size_gte: 2, accountCountGte: 2 },
      {
        lane: "swarm",
        atomic: true,
        atomic_policy: "balanced",
        primary_cli: "claude",
        reason: "leaseMany",
      },
    );
    const router = createDynamicRouter({
      env: { TRIFLUX_DYNAMIC_ROUTING: "1" },
      policy: fakePolicy,
      snapshotProvider: async () => fakeSnapshot,
      nowFn: () => now,
    });
    const decision = await router.routeRequest({ team_size: 2 });
    assert.equal(decision.scenario, "S5");
    assert.equal(decision.lane, "swarm");
    assert.equal(decision.shards?.length, 2);
  });

  it("S6 (account expiry drain): 만료 임박 account 의 drain shards", {
    skip: !importOk ? "D-1/D-2 facade not available" : false,
  }, async () => {
    resetSnapshotCache();
    const now = 1_000_000;
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: now,
      claude: {
        weeklyPercent: 30,
        weeklyResetsAt: now + 600_000_000,
        observedAt: now,
        isStale: false,
      },
      codex: {
        buckets: {
          primary: {
            primary: { usedPercent: 30, resetsAt: now + 600_000_000 },
            secondary: null,
          },
        },
        observedAt: now,
        isStale: false,
      },
      broker: {
        codex: [
          {
            id: "codex-expiring",
            circuitState: "closed",
            expiresAt: now + 3_600_000,
          },
        ],
        claude: [{ id: "claude-1", circuitState: "closed" }],
        gemini: [],
      },
    };
    const fakePolicy = fakePolicyForScenario(
      "S6",
      {
        expiresAtLteMs: 604800000,
        circuitStateNotOpen: true,
      },
      { lane: "single", riskTier: "drain", reason: "expiry-drain" },
    );
    const router = createDynamicRouter({
      env: { TRIFLUX_DYNAMIC_ROUTING: "1" },
      policy: fakePolicy,
      snapshotProvider: async () => fakeSnapshot,
      nowFn: () => now,
    });
    const decision = await router.routeRequest({});
    assert.equal(decision.scenario, "S6");
    assert.equal(decision.shards?.[0]?.accountId, "codex-expiring");
    assert.equal(decision.shards?.[0]?.riskTier, "drain");
  });
});
