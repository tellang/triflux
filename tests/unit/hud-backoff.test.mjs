import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeClaudeUsagePollState,
  CLAUDE_USAGE_POLL_BASE_MS,
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
      computeClaudeUsagePollState({ consecutive429s: 0, outcome: "rate_limit", random: () => 0.5 }).baseDelayMs,
      10_000,
    );
    assert.equal(
      computeClaudeUsagePollState({ consecutive429s: 1, outcome: "rate_limit", random: () => 0.5 }).baseDelayMs,
      30_000,
    );
    assert.equal(
      computeClaudeUsagePollState({ consecutive429s: 2, outcome: "rate_limit", random: () => 0.5 }).baseDelayMs,
      60_000,
    );
    assert.equal(
      computeClaudeUsagePollState({ consecutive429s: 3, outcome: "rate_limit", random: () => 0.5 }).baseDelayMs,
      120_000,
    );
    assert.equal(
      computeClaudeUsagePollState({ consecutive429s: 99, outcome: "rate_limit", random: () => 0.5 }).baseDelayMs,
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
  it("adds a [stale] marker to the Claude row while backoff is active", () => {
    const rows = getClaudeRows(
      "minimal",
      { percent: 42, display: "42%" },
      { fiveHourPercent: 11, weeklyPercent: 22, stale: true },
      0,
    );

    assert.equal(rows.length, 1);
    assert.match(stripAnsi(rows[0].left), /\[stale\]/);
  });
});
