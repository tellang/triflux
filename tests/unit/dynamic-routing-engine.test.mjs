// tests/unit/dynamic-routing-engine.test.mjs
//
// PRD: .omx/plans/prd-dynamic-routing-engine.md
//
// Phase 0 acceptance suite. Pure-fn classifier — given a mock snapshot and
// the production routing policy JSON, the engine emits a deterministic
// RouteDecision. Six scenarios (S1..S6) + freshness/edge fallbacks.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { evaluateDynamicRoute } from "../../hub/dynamic-routing-engine.mjs";

const POLICY = JSON.parse(
  readFileSync(
    new URL("../../config/routing-policy.json", import.meta.url),
    "utf8",
  ),
);
// 2026-05-15T08:00:00Z — fixed epoch for deterministic tests.
// Verified via `new Date(NOW).toISOString()` → "2026-05-15T08:00:00.000Z".
const NOW = 1778832000000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function mkClaude({
  weekly = 30,
  fiveHour = 10,
  resetIn = 5 * DAY,
  stale = false,
} = {}) {
  return {
    fiveHourPercent: fiveHour,
    weeklyPercent: weekly,
    fiveHourResetsAt: NOW + 4 * HOUR,
    weeklyResetsAt: NOW + resetIn,
    observedAt: NOW - 60_000,
    isStale: stale,
    source: "test",
  };
}

function mkCodex({
  primaryPct = 30,
  secondaryPct = 30,
  resetIn = 5 * DAY,
  stale = false,
} = {}) {
  return {
    buckets: {
      codex: {
        primary: { usedPercent: primaryPct, resetsAt: NOW + resetIn },
        secondary: { usedPercent: secondaryPct, resetsAt: NOW + resetIn },
      },
    },
    observedAt: NOW - 60_000,
    isStale: stale,
    source: "test",
  };
}

function mkBroker({
  claudeCount = 0,
  codexCount = 1,
  codexExpiresIn = null,
  allCircuitsOpen = false,
} = {}) {
  const baseAcct = (id, provider, overrides = {}) => ({
    id,
    tier: "pro",
    busy: false,
    cooldownUntil: null,
    lastUsedAt: NOW - HOUR,
    remainingMs: null,
    circuitState: allCircuitsOpen ? "open" : "closed",
    failureCount: 0,
    expiresAt: null,
    drainAfter: null,
    provider,
    ...overrides,
  });
  return {
    claude: Array.from({ length: claudeCount }, (_, i) =>
      baseAcct(`claude-${i + 1}`, "claude"),
    ),
    codex: Array.from({ length: codexCount }, (_, i) =>
      baseAcct(`codex-${i + 1}`, "codex", {
        expiresAt: codexExpiresIn ? NOW + codexExpiresIn : null,
      }),
    ),
    gemini: [],
  };
}

function mkSnapshot(parts = {}) {
  return {
    schemaVersion: 1,
    observedAt: NOW,
    claude: parts.claude !== undefined ? parts.claude : mkClaude(),
    codex: parts.codex !== undefined ? parts.codex : mkCodex(),
    broker: parts.broker !== undefined ? parts.broker : mkBroker(),
  };
}

describe("dynamic-routing-engine — Phase 0", () => {
  it("S1: Claude weekly reset 임박 + 다계정 → claude multi lane", () => {
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 35, resetIn: 12 * HOUR }),
      broker: mkBroker({ claudeCount: 2 }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "S1");
    assert.equal(decision.lane, "multi");
    assert.equal(decision.shards[0].cli, "claude");
    assert.match(decision.rationale.scenarioName, /claude-reset-imminent/);
  });

  it("S2: Codex weekly reset 임박 → codex swarm lane", () => {
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 50, resetIn: 5 * DAY }),
      codex: mkCodex({ primaryPct: 40, resetIn: 12 * HOUR }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "S2");
    assert.equal(decision.lane, "swarm");
    assert.equal(decision.shards[0].cli, "codex");
  });

  it("S3: Claude >80% + Codex <20% + Claude reset >48h → codex single", () => {
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 85, resetIn: 5 * DAY }),
      codex: mkCodex({ primaryPct: 10, resetIn: 5 * DAY }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "S3");
    assert.equal(decision.lane, "single");
    assert.equal(decision.shards[0].cli, "codex");
  });

  it("S4: Claude multi-account staggered → claude multi with all accounts as shards", () => {
    const broker = mkBroker({ claudeCount: 2 });
    // make staggered: distinct expiresAt
    broker.claude[0].expiresAt = NOW + 7 * DAY;
    broker.claude[1].expiresAt = NOW + 14 * DAY;
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 50, resetIn: 5 * DAY }),
      broker,
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    // S1 also can match (reset 5d < 24h? No, 5d > 24h). So S4 should win when reset is far.
    assert.equal(decision.scenario, "S4");
    assert.equal(decision.lane, "multi");
    assert.equal(decision.shards.length, 2);
  });

  it("S5: team_size>=2 + multi-account → claude swarm with leaseMany atomic", () => {
    const broker = mkBroker({ claudeCount: 2 });
    broker.claude[0].expiresAt = NOW + 7 * DAY;
    broker.claude[1].expiresAt = NOW + 14 * DAY;
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 40, resetIn: 5 * DAY }),
      broker,
    });
    const decision = evaluateDynamicRoute({ team_size: 3 }, snap, POLICY, {
      now: NOW,
    });
    // S4 will likely match first (both have accountCountGte:2 and staggered). For
    // explicit S5 testing we need a snapshot where S4 doesn't match. S4 requires
    // staggered: distinct cooldown/expiresAt. Use identical anchors to skip S4.
    const broker2 = mkBroker({ claudeCount: 2 });
    broker2.claude[0].expiresAt = NOW + 7 * DAY;
    broker2.claude[1].expiresAt = NOW + 7 * DAY;
    const snap2 = mkSnapshot({
      claude: mkClaude({ weekly: 40, resetIn: 5 * DAY }),
      broker: broker2,
    });
    const decision2 = evaluateDynamicRoute({ team_size: 3 }, snap2, POLICY, {
      now: NOW,
    });
    assert.equal(decision2.scenario, "S5");
    assert.equal(decision2.atomic, "leaseMany");
    // sanity: first call also resolves to a valid scenario
    assert.ok(["S4", "S5"].includes(decision.scenario));
  });

  it("S6: account expires within 7d + low usage → drain mode", () => {
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 30, resetIn: 5 * DAY }),
      codex: mkCodex({ primaryPct: 30, resetIn: 5 * DAY }),
      broker: mkBroker({
        claudeCount: 0,
        codexCount: 1,
        codexExpiresIn: 3 * DAY,
      }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "S6");
    assert.equal(decision.shards[0].riskTier, "drain");
  });

  it("freshness veto: claude isStale → codex-default fallback", () => {
    const snap = mkSnapshot({ claude: mkClaude({ stale: true }) });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.fallback.trigger, "claude_stale_or_error");
    assert.equal(decision.shards[0].cli, "codex");
  });

  it("freshness veto: both HUD providers null → codex-default fallback", () => {
    const snap = mkSnapshot({ claude: null, codex: null });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "hud_null");
  });

  it("freshness veto: claude weeklyResetsAt in past → codex-default fallback", () => {
    const snap = mkSnapshot({
      claude: { ...mkClaude(), weeklyResetsAt: NOW - 2 * HOUR },
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "claude_weekly_reset_in_past");
  });

  it("freshness veto: snapshot older than 15min → codex-default fallback", () => {
    const snap = mkSnapshot({
      claude: { ...mkClaude(), observedAt: NOW - 20 * 60_000 },
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "claude_age_exceeded");
  });

  it("all circuits open → codex-default fallback", () => {
    const snap = mkSnapshot({
      broker: mkBroker({
        claudeCount: 1,
        codexCount: 1,
        allCircuitsOpen: true,
      }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "all_circuits_open");
  });

  it("no scenario matches (default healthy state) → codex-default fallback", () => {
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 30, resetIn: 5 * DAY }),
      codex: mkCodex({ primaryPct: 30, resetIn: 5 * DAY }),
      broker: mkBroker({ claudeCount: 0, codexCount: 1 }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "no_scenario_matched");
    assert.equal(decision.shards[0].cli, "codex");
  });

  it("deterministic: same (request, snapshot) → same decisionId", () => {
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 35, resetIn: 12 * HOUR }),
      broker: mkBroker({ claudeCount: 2 }),
    });
    const d1 = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    const d2 = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(d1.decisionId, d2.decisionId);
    assert.equal(d1.scenario, d2.scenario);
  });

  it("policy missing → policy_missing fallback (no throw)", () => {
    const snap = mkSnapshot();
    const decision = evaluateDynamicRoute({}, snap, null, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "policy_missing");
  });

  // ─── Negative fixtures (verifier audit follow-up) ───────────────

  it("S1 negative: claudeCount=1 (단일 account) → S1 skip → fallback", () => {
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 35, resetIn: 12 * HOUR }),
      broker: mkBroker({ claudeCount: 1, codexCount: 1 }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.notEqual(decision.scenario, "S1");
  });

  it("S2 secondary leg: primary exhausted + secondary reset 임박 → S2 trigger", () => {
    const codex = {
      buckets: {
        codex: {
          primary: { usedPercent: 100, resetsAt: NOW + 30 * DAY },
          secondary: { usedPercent: 20, resetsAt: NOW + 12 * HOUR },
        },
      },
      observedAt: NOW - 60_000,
      isStale: false,
      source: "test",
    };
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 50, resetIn: 5 * DAY }),
      codex,
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "S2");
    assert.equal(decision.shards[0].cli, "codex");
  });

  it("S5 negative: team_size=1 → S5 skip", () => {
    const broker = mkBroker({ claudeCount: 2 });
    broker.claude[0].expiresAt = NOW + 7 * DAY;
    broker.claude[1].expiresAt = NOW + 7 * DAY;
    const snap = mkSnapshot({
      claude: mkClaude({ weekly: 40, resetIn: 5 * DAY }),
      broker,
    });
    const decision = evaluateDynamicRoute({ team_size: 1 }, snap, POLICY, {
      now: NOW,
    });
    assert.notEqual(decision.scenario, "S5");
  });

  it("S6 negative: expiresAt 이미 과거 → 죽은 계정 filter 후 fallback", () => {
    const broker = mkBroker({ claudeCount: 0, codexCount: 1 });
    broker.codex[0].expiresAt = NOW - 24 * HOUR; // already expired
    const snap = mkSnapshot({
      claude: mkClaude(),
      codex: mkCodex(),
      broker,
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.notEqual(decision.scenario, "S6");
  });

  it("S6 weeklyPercentLt cross-check: codex 80% used → drain skip", () => {
    const broker = mkBroker({ claudeCount: 0, codexCount: 1 });
    broker.codex[0].expiresAt = NOW + 3 * DAY;
    const snap = mkSnapshot({
      claude: mkClaude(),
      codex: mkCodex({ primaryPct: 80, resetIn: 5 * DAY }),
      broker,
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.notEqual(decision.scenario, "S6");
  });

  it("freshness veto: codex isStale → codex-default fallback", () => {
    const snap = mkSnapshot({
      codex: mkCodex({ stale: true }),
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "codex_stale_or_error");
  });

  it("freshness veto: codex snapshot older than 15min → codex_age_exceeded", () => {
    const snap = mkSnapshot({
      codex: { ...mkCodex(), observedAt: NOW - 20 * 60_000 },
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "codex_age_exceeded");
  });

  it("freshness veto: cross-provider snapshot skew > 5min → fallback", () => {
    const snap = mkSnapshot({
      claude: { ...mkClaude(), observedAt: NOW - 60_000 },
      codex: { ...mkCodex(), observedAt: NOW - 7 * 60_000 },
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "cross_provider_skew_exceeded");
  });

  it("broker_empty: 모든 provider 계정 0개 → broker_empty fallback", () => {
    const snap = mkSnapshot({
      broker: { claude: [], codex: [], gemini: [] },
    });
    const decision = evaluateDynamicRoute({}, snap, POLICY, { now: NOW });
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.fallback.trigger, "broker_empty");
  });

  it("pure-fn contract: options.now 미지정 시 TypeError", () => {
    const snap = mkSnapshot();
    assert.throws(() => evaluateDynamicRoute({}, snap, POLICY), TypeError);
    assert.throws(() => evaluateDynamicRoute({}, snap, POLICY, {}), TypeError);
  });
});
