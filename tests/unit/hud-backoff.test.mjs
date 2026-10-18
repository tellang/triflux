import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CLAUDE_USAGE_POLL_BASE_MS,
  computeClaudeUsagePollState,
} from "../../hud/providers/claude.mjs";
import { getClaudeRows } from "../../hud/renderers.mjs";
import { stripAnsi } from "../../hud/utils.mjs";

describe("hud usage backoff", () => {
  it("다른 Claude 계정 캐시는 숨기고 429 backoff 중에만 갱신을 미룬다", () => {
    const home = mkdtempSync(join(tmpdir(), "triflux-claude-account-"));
    try {
      const snapshots = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import { mkdirSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          import { CLAUDE_USAGE_CACHE_PATH, OMC_PLUGIN_USAGE_CACHE_PATH } from ${JSON.stringify(new URL("../../hud/constants.mjs", import.meta.url).href)};
          import { readClaudeUsageSnapshot, writeClaudeUsageCache } from ${JSON.stringify(new URL("../../hud/providers/claude.mjs", import.meta.url).href)};
          import { readJson, writeJsonSafe } from ${JSON.stringify(new URL("../../hud/utils.mjs", import.meta.url).href)};
          mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
          writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "current", emailAddress: "same@example.test" } }));
          const data = { fiveHourPercent: 40, weeklyPercent: 60 };
          writeJsonSafe(OMC_PLUGIN_USAGE_CACHE_PATH, { timestamp: Date.now(), data });
          const snapshots = [];
          for (const errorType of [null, "auth", "network", "rate_limit"]) {
            writeJsonSafe(CLAUDE_USAGE_CACHE_PATH, { timestamp: Date.now(), account: "old", data, error: !!errorType, errorType, nextRefreshAt: Date.now() + 60000 });
            snapshots.push(readClaudeUsageSnapshot());
          }
          writeClaudeUsageCache(null, { type: "auth", status: 401 });
          snapshots.push(readClaudeUsageSnapshot());
          snapshots.push({ account: readJson(CLAUDE_USAGE_CACHE_PATH).account });
          process.stdout.write(JSON.stringify(snapshots));
        `,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              CLAUDE_CONFIG_DIR: join(home, "config"),
            },
          },
        ),
      );
      for (const snapshot of snapshots.slice(0, 3)) {
        assert.equal(snapshot.data, null);
        assert.equal(snapshot.shouldRefresh, true);
      }
      assert.equal(snapshots[3].data, null);
      assert.equal(snapshots[3].shouldRefresh, false);
      assert.equal(snapshots[4].data, null);
      assert.equal(snapshots[4].shouldRefresh, true);
      assert.equal(snapshots[5].account, "old");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

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
    );

    assert.equal(rows.length, 1);
    assert.doesNotMatch(stripAnsi(rows[0].left), /\[stale\]/);
  });
});

describe("Claude unified weekly markers", () => {
  it("does not render Sonnet or Opus weekly markers in any Claude row tier", () => {
    for (const tier of ["nano", "micro", "minimal", "compact", "full"]) {
      const rows = getClaudeRows(
        tier,
        { percent: 42, display: "42%" },
        {
          fiveHourPercent: 11,
          weeklyPercent: 22,
          sonnetWeeklyPercent: 33,
          opusWeeklyPercent: 44,
        },
      );

      const left = stripAnsi(rows[0].left);
      assert.match(
        left,
        tier === "nano" || tier === "micro" ? /11%\/22%/ : /1w:/,
      );
      assert.doesNotMatch(left, /Sn:/);
      assert.doesNotMatch(left, /Op:/);
    }
  });
});
