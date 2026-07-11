import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAppServerRateLimits } from "../../hud/providers/codex-probe.mjs";

const FIXTURE = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 45,
      windowDurationMins: 300,
      resetsAt: 1783767909,
    },
    secondary: {
      usedPercent: 7,
      windowDurationMins: 10080,
      resetsAt: 1784354709,
    },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 45,
        windowDurationMins: 300,
        resetsAt: 1783767909,
      },
      secondary: {
        usedPercent: 7,
        windowDurationMins: 10080,
        resetsAt: 1784354709,
      },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: {
        usedPercent: 3,
        windowDurationMins: 300,
        resetsAt: 1783776279,
      },
      secondary: {
        usedPercent: 1,
        windowDurationMins: 10080,
        resetsAt: 1784363079,
      },
      credits: null,
      individualLimit: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
  },
};

test("normalizeAppServerRateLimits: byLimitId 전체를 snake_case 스냅샷으로 변환", () => {
  const out = normalizeAppServerRateLimits(
    FIXTURE,
    "2026-07-11T09:00:00.000Z",
  );
  const codex = out.find((s) => s.limitId === "codex");
  assert.equal(codex.primary.used_percent, 45);
  assert.equal(codex.primary.window_minutes, 300);
  assert.equal(codex.primary.resets_at, 1783767909);
  assert.equal(codex.secondary.window_minutes, 10080);
  assert.equal(codex.timestamp, "2026-07-11T09:00:00.000Z");
  assert.equal(codex.probe, true);
  assert.equal(codex.tokens, null);
  const spark = out.find((s) => s.limitId === "codex_bengalfox");
  assert.equal(spark.primary.used_percent, 3);
});

test("normalizeAppServerRateLimits: byLimitId 없으면 top-level rateLimits 폴백", () => {
  const out = normalizeAppServerRateLimits(
    { rateLimits: FIXTURE.rateLimits },
    "2026-07-11T09:00:00.000Z",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].limitId, "codex");
});

test("normalizeAppServerRateLimits: null/빈 응답은 빈 배열", () => {
  assert.deepEqual(normalizeAppServerRateLimits(null, "t"), []);
  assert.deepEqual(normalizeAppServerRateLimits({}, "t"), []);
});
