import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLAUDE_USAGE_POLL_BASE_MS,
  computeClaudeUsagePollState,
} from "../../hud/providers/claude.mjs";
import { getClaudeRows } from "../../hud/renderers.mjs";
import { stripAnsi } from "../../hud/utils.mjs";

describe("hud usage backoff", () => {
  it("uses the 5s base interval after a successful poll", () => {
    const state = computeClaudeUsagePollState({
      consecutive429s: 3,
      outcome: "success",
      random: () => 0.5,
    });

    assert.equal(state.consecutive429s, 0);
    assert.equal(state.baseDelayMs, CLAUDE_USAGE_POLL_BASE_MS);
    assert.equal(state.delayMs, CLAUDE_USAGE_POLL_BASE_MS);
  });

  it("escalates 429 backoff through 10s, 30s, 60s, then caps at 120s", () => {
    assert.equal(
      computeClaudeUsagePollState({
        consecutive429s: 0,
        outcome: "rate_limit",
        random: () => 0.5,
      }).baseDelayMs,
      10_000,
    );
    assert.equal(
      computeClaudeUsagePollState({
        consecutive429s: 1,
        outcome: "rate_limit",
        random: () => 0.5,
      }).baseDelayMs,
      30_000,
    );
    assert.equal(
      computeClaudeUsagePollState({
        consecutive429s: 2,
        outcome: "rate_limit",
        random: () => 0.5,
      }).baseDelayMs,
      60_000,
    );
    assert.equal(
      computeClaudeUsagePollState({
        consecutive429s: 3,
        outcome: "rate_limit",
        random: () => 0.5,
      }).baseDelayMs,
      120_000,
    );
    assert.equal(
      computeClaudeUsagePollState({
        consecutive429s: 99,
        outcome: "rate_limit",
        random: () => 0.5,
      }).baseDelayMs,
      120_000,
    );
  });

  it("applies +/-20% jitter to the chosen polling interval", () => {
    const low = computeClaudeUsagePollState({
      consecutive429s: 1,
      outcome: "rate_limit",
      random: () => 0,
    });
    const high = computeClaudeUsagePollState({
      consecutive429s: 1,
      outcome: "rate_limit",
      random: () => 1,
    });

    assert.equal(low.baseDelayMs, 30_000);
    assert.equal(low.delayMs, 24_000);
    assert.equal(high.delayMs, 36_000);
  });
});

describe("hud stale marker", () => {
  for (const tier of ["minimal", "compact", "full"]) {
    it(`adds a [stale] marker to the ${tier} Claude row while backoff is active`, () => {
      const rows = getClaudeRows(
        tier,
        { percent: 42, display: "42%" },
        { fiveHourPercent: 11, weeklyPercent: 22, stale: true },
        0,
      );

      assert.equal(rows.length, 1);
      assert.match(stripAnsi(rows[0].left), /\[stale\]/);
    });
  }

  it("omits the [stale] marker when the Claude usage snapshot has no data", () => {
    const rows = getClaudeRows(
      "minimal",
      { percent: 42, display: "42%" },
      null,
      0,
    );

    assert.equal(rows.length, 1);
    assert.doesNotMatch(stripAnsi(rows[0].left), /\[stale\]/);
  });
});

describe("Claude model-specific weekly markers", () => {
  it("shows positive Sonnet and Opus weekly usage as secondary compact markers", () => {
    const rows = getClaudeRows(
      "compact",
      { percent: 42, display: "42%" },
      {
        fiveHourPercent: 11,
        weeklyPercent: 22,
        sonnetWeeklyPercent: 33,
        opusWeeklyPercent: 44,
      },
      0,
    );

    const left = stripAnsi(rows[0].left);
    assert.match(left, /1w:/);
    assert.match(left, /Sn:33%/);
    assert.match(left, /Op:44%/);
  });

  it("hides zero or absent model-specific weekly usage", () => {
    const rows = getClaudeRows(
      "minimal",
      { percent: 42, display: "42%" },
      {
        fiveHourPercent: 11,
        weeklyPercent: 22,
        sonnetWeeklyPercent: 0,
      },
      0,
    );

    const left = stripAnsi(rows[0].left);
    assert.doesNotMatch(left, /Sn:/);
    assert.doesNotMatch(left, /Op:/);
  });

  it("does not show model-specific weekly usage in nano or micro tiers", () => {
    for (const tier of ["nano", "micro"]) {
      const rows = getClaudeRows(
        tier,
        { percent: 42, display: "42%" },
        {
          fiveHourPercent: 11,
          weeklyPercent: 22,
          sonnetWeeklyPercent: 33,
          opusWeeklyPercent: 44,
        },
        0,
      );

      const left = stripAnsi(rows[0].left);
      assert.doesNotMatch(left, /Sn:/);
      assert.doesNotMatch(left, /Op:/);
    }
  });
});
