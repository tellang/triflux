import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { codexWhite, dim } from "../../hud/colors.mjs";
import {
  classifyBucket,
  expireStaleCodexBuckets,
  getCodexRateLimits,
  normalizeBuckets,
} from "../../hud/providers/codex.mjs";
import { getProviderRow } from "../../hud/renderers.mjs";
import { formatPercentCell } from "../../hud/utils.mjs";

function sessionDirFor(sessionsRoot, date) {
  return join(
    sessionsRoot,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
}

function writeRollout(sessionsRoot, date, filename, events) {
  const dir = sessionDirFor(sessionsRoot, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

function rateLimitEvent({
  timestamp,
  usedPercent,
  resetsAt,
  secondaryUsedPercent = 20,
  secondaryResetsAt = resetsAt + 7 * 24 * 60 * 60,
  credits,
  totalTokenUsage,
  contextWindow,
}) {
  return {
    timestamp,
    payload: {
      rate_limits: {
        limit_id: "codex",
        limit_name: "Codex",
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          resets_at: resetsAt,
        },
        secondary: {
          used_percent: secondaryUsedPercent,
          window_minutes: 10080,
          resets_at: secondaryResetsAt,
        },
        credits,
      },
      info: {
        total_token_usage: totalTokenUsage,
        model_context_window: contextWindow,
      },
    },
  };
}

describe("Codex bucket normalization", () => {
  // --- classifyBucket ---

  it("classifies 300min as five_hour", () => {
    assert.equal(classifyBucket({ window_minutes: 300 }), "five_hour");
  });

  it("classifies 360min as five_hour (upper bound)", () => {
    assert.equal(classifyBucket({ window_minutes: 360 }), "five_hour");
  });

  it("classifies 10080min as weekly", () => {
    assert.equal(classifyBucket({ window_minutes: 10080 }), "weekly");
  });

  it("classifies 7000min as weekly (lower bound)", () => {
    assert.equal(classifyBucket({ window_minutes: 7000 }), "weekly");
  });

  it("returns null for 1440min (24h bucket — not weekly under tightened threshold)", () => {
    assert.equal(classifyBucket({ window_minutes: 1440 }), null);
  });

  it("returns null for 6999min (just below weekly threshold)", () => {
    assert.equal(classifyBucket({ window_minutes: 6999 }), null);
  });

  it("returns null for null bucket", () => {
    assert.equal(classifyBucket(null), null);
  });

  it("returns null for bucket without window_minutes", () => {
    assert.equal(classifyBucket({ used_percent: 50 }), null);
  });

  // --- normalizeBuckets ---

  it("weekly-only: primary(10080m) → secondary, primary=null", () => {
    const rl = {
      primary: {
        used_percent: 14,
        window_minutes: 10080,
        resets_at: 1776069834,
      },
      secondary: null,
    };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary, null, "5h slot should be null");
    assert.equal(secondary.used_percent, 14);
    assert.equal(secondary.window_minutes, 10080);
  });

  it("5h-only: primary(300m) → primary, secondary=null", () => {
    const rl = {
      primary: { used_percent: 30, window_minutes: 300, resets_at: 9999 },
      secondary: null,
    };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary.used_percent, 30);
    assert.equal(secondary, null, "1w slot should be null");
  });

  it("both: primary(300m)+secondary(10080m) → 정상 매핑", () => {
    const rl = {
      primary: { used_percent: 50, window_minutes: 300, resets_at: 1000 },
      secondary: { used_percent: 20, window_minutes: 10080, resets_at: 2000 },
    };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary.used_percent, 50);
    assert.equal(secondary.used_percent, 20);
  });

  it("both reversed: primary(10080m)+secondary(300m) → 슬롯 교정", () => {
    const rl = {
      primary: { used_percent: 20, window_minutes: 10080, resets_at: 2000 },
      secondary: { used_percent: 50, window_minutes: 300, resets_at: 1000 },
    };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary.used_percent, 50, "5h slot should have 300m bucket");
    assert.equal(
      secondary.used_percent,
      20,
      "1w slot should have 10080m bucket",
    );
  });

  it("neither: both null → both null", () => {
    const rl = { primary: null, secondary: null };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary, null);
    assert.equal(secondary, null);
  });
});

describe("Codex multi-window selection", () => {
  it("merges today and yesterday, clusters 90s reset jitter, and selects max-used active window", () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "triflux-codex-quota-"));
    const now = new Date("2026-07-11T06:50:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    const yesterday = new Date(now.getTime() - 86_400_000);
    try {
      writeRollout(sessionsRoot, now, "rollout-low.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:45:15.000Z",
          usedPercent: 6,
          resetsAt: nowSec + 4 * 60 * 60,
        }),
      ]);
      writeRollout(sessionsRoot, yesterday, "rollout-high-old.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:00:00.000Z",
          usedPercent: 65,
          resetsAt: nowSec + 30 * 60,
        }),
      ]);
      writeRollout(sessionsRoot, yesterday, "rollout-high-new.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:12:46.000Z",
          usedPercent: 70,
          resetsAt: nowSec + 30 * 60 + 1,
        }),
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.primary.used_percent, 70);
      assert.equal(buckets.codex.primary.resets_at, nowSec + 30 * 60 + 1);
      assert.equal(buckets.codex.mixedWindows, true);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("ignores an expired high-used window when an active window exists", () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "triflux-codex-expiry-"));
    const now = new Date("2026-07-11T06:50:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    try {
      writeRollout(sessionsRoot, now, "rollout-active.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:40:00.000Z",
          usedPercent: 40,
          resetsAt: nowSec + 10 * 60,
        }),
      ]);
      writeRollout(sessionsRoot, now, "rollout-expired.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:49:00.000Z",
          usedPercent: 95,
          resetsAt: nowSec - 60,
        }),
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.primary.used_percent, 40);
      assert.equal(buckets.codex.primary.expired, undefined);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("selects an active heavy weekly window independently from the active five-hour window", () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "triflux-codex-weekly-"));
    const now = new Date("2026-07-11T06:50:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    try {
      writeRollout(sessionsRoot, now, "rollout-active-primary.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:45:00.000Z",
          usedPercent: 12,
          resetsAt: nowSec + 4 * 60 * 60,
          secondaryUsedPercent: 4,
          secondaryResetsAt: nowSec + 7 * 24 * 60 * 60,
          credits: { balance: 9 },
          totalTokenUsage: { total_tokens: 1234 },
          contextWindow: 200_000,
        }),
      ]);
      writeRollout(sessionsRoot, now, "rollout-heavy-weekly.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-10T08:21:00.000Z",
          usedPercent: 95,
          resetsAt: nowSec - 60,
          secondaryUsedPercent: 43,
          secondaryResetsAt: nowSec + 5 * 24 * 60 * 60,
          credits: { balance: 1 },
          totalTokenUsage: { total_tokens: 9999 },
          contextWindow: 99_999,
        }),
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.primary.used_percent, 12);
      assert.equal(buckets.codex.secondary.used_percent, 43);
      assert.equal(buckets.codex.timestamp, "2026-07-11T06:45:00.000Z");
      assert.equal(
        buckets.codex.secondaryTimestamp,
        "2026-07-10T08:21:00.000Z",
      );
      assert.deepEqual(buckets.codex.credits, { balance: 9 });
      assert.deepEqual(buckets.codex.tokens, { total_tokens: 1234 });
      assert.equal(buckets.codex.contextWindow, 200_000);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("marks mixed windows when only weekly windows form multiple active groups", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-weekly-mixed-"),
    );
    const now = new Date("2026-07-11T06:50:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    try {
      writeRollout(sessionsRoot, now, "rollout-weekly-a.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:40:00.000Z",
          usedPercent: 10,
          resetsAt: nowSec + 4 * 60 * 60,
          secondaryUsedPercent: 21,
          secondaryResetsAt: nowSec + 3 * 24 * 60 * 60,
        }),
      ]);
      writeRollout(sessionsRoot, now, "rollout-weekly-b.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T06:45:00.000Z",
          usedPercent: 11,
          resetsAt: nowSec + 4 * 60 * 60 + 30,
          secondaryUsedPercent: 22,
          secondaryResetsAt: nowSec + 5 * 24 * 60 * 60,
        }),
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.primary.used_percent, 11);
      assert.equal(buckets.codex.secondary.used_percent, 22);
      assert.equal(buckets.codex.mixedWindows, true);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("marks stale cached windows expired and zeroes their usage", () => {
    const nowSec = 1_800_000_000;
    const buckets = expireStaleCodexBuckets(
      {
        codex: {
          primary: { used_percent: 88, resets_at: nowSec - 1 },
          secondary: { used_percent: 45, resets_at: nowSec + 1 },
        },
      },
      nowSec,
    );

    assert.deepEqual(buckets.codex.primary, {
      used_percent: 0,
      resets_at: nowSec - 1,
      expired: true,
    });
    assert.deepEqual(buckets.codex.secondary, {
      used_percent: 45,
      resets_at: nowSec + 1,
    });
  });
});

describe("Codex window freshness rendering", () => {
  function renderCodexFullRow(snapshot) {
    return getProviderRow(
      "full",
      "codex",
      "x",
      codexWhite,
      {},
      {},
      {},
      { type: "codex", buckets: { codex: snapshot } },
      null,
      null,
      null,
    );
  }

  it("falls back to the primary timestamp for legacy snapshots without secondaryTimestamp", () => {
    const staleTimestamp = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const row = renderCodexFullRow({
      timestamp: staleTimestamp,
      primary: { used_percent: 12 },
      secondary: { used_percent: 43 },
    });

    assert.ok(row.left.includes(dim(formatPercentCell(12))));
    assert.ok(row.left.includes(dim(formatPercentCell(43))));
  });

  it("dims only the stale weekly percentage and gauge when five-hour data is fresh", () => {
    const row = renderCodexFullRow({
      timestamp: new Date().toISOString(),
      secondaryTimestamp: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      primary: { used_percent: 12 },
      secondary: { used_percent: 43 },
    });

    assert.ok(row.left.includes(codexWhite(formatPercentCell(12))));
    assert.ok(row.left.includes(dim(formatPercentCell(43))));
    assert.ok(
      row.left.includes(`${dim("░".repeat(5))} ${dim(formatPercentCell(43))}`),
    );
  });
});
