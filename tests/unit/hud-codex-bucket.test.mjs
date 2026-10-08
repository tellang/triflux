import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyBucket,
  createReverseLineReader,
  expireStaleCodexBuckets,
  getCodexRateLimits,
  normalizeBuckets,
} from "../../hud/providers/codex.mjs";

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

// 2026-09-21 이후 Codex 는 5h 창 없이 주간 창 하나만 primary 로 보낸다.
function weeklyOnlyEvent({ timestamp, usedPercent, resetsAt }) {
  return {
    timestamp,
    payload: {
      rate_limits: {
        limit_id: "codex",
        primary: {
          used_percent: usedPercent,
          window_minutes: 10080,
          resets_at: resetsAt,
        },
        secondary: null,
      },
    },
  };
}

describe("Codex bucket normalization", () => {
  it("classifies supported window lengths", () => {
    for (const [bucket, expected] of [
      [{ window_minutes: 300 }, "five_hour"],
      [{ window_minutes: 360 }, "five_hour"],
      [{ window_minutes: 10080 }, "weekly"],
      [{ window_minutes: 7000 }, "weekly"],
      [{ window_minutes: 1440 }, null],
      [{ window_minutes: 6999 }, null],
      [null, null],
      [{ used_percent: 50 }, null],
    ]) {
      assert.equal(classifyBucket(bucket), expected);
    }
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

  it("unknown length: keeps a bucket without window_minutes in its reported slot", () => {
    // app-server 스키마에서 windowDurationMins 는 선택 필드다.
    const rl = {
      primary: { used_percent: 40, window_minutes: null, resets_at: 1000 },
      secondary: { used_percent: 20, resets_at: 2000 },
    };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary.used_percent, 40);
    assert.equal(secondary.used_percent, 20);
  });

  it("unknown length: a classified bucket wins the slot", () => {
    const rl = {
      primary: { used_percent: 40, window_minutes: null, resets_at: 1000 },
      secondary: { used_percent: 50, window_minutes: 300, resets_at: 2000 },
    };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary.used_percent, 50);
    assert.equal(secondary, null);
  });

  it("known but unsupported length (24h) is still dropped", () => {
    const rl = {
      primary: { used_percent: 40, window_minutes: 1440, resets_at: 1000 },
      secondary: null,
    };
    const { primary, secondary } = normalizeBuckets(rl);
    assert.equal(primary, null);
    assert.equal(secondary, null);
  });
});

describe("Codex multi-window selection", () => {
  it("getCodexRateLimits: probe extraSnapshots가 낡은 세션 데이터를 이긴다", () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "triflux-codex-probe-"));
    const now = new Date("2026-07-11T09:00:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    try {
      writeRollout(sessionsRoot, now, "rollout-stale.jsonl", [
        rateLimitEvent({
          timestamp: "2026-07-11T07:00:00.000Z",
          usedPercent: 6,
          resetsAt: nowSec + 3600,
        }),
      ]);
      const probeSnapshot = {
        limitId: "codex",
        limitName: null,
        primary: {
          used_percent: 45,
          window_minutes: 300,
          resets_at: nowSec + 3600,
        },
        secondary: {
          used_percent: 7,
          window_minutes: 10080,
          resets_at: nowSec + 86_400 * 6,
        },
        credits: null,
        tokens: null,
        contextWindow: null,
        timestamp: now.toISOString(),
        probe: true,
      };

      const buckets = getCodexRateLimits({
        sessionsRoot,
        now,
        extraSnapshots: [probeSnapshot],
      });

      assert.equal(buckets.codex.primary.used_percent, 45);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

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

  it("drops a long-expired five-hour fallback after Codex reports weekly-only primary data", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-weekly-only-fallback-"),
    );
    const now = new Date("2026-07-23T06:00:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    try {
      // A stale local session can be written after the last weekly-only event,
      // but its reset proves that its five-hour value is no longer usable.
      writeRollout(sessionsRoot, now, "rollout-stale-five-hour.jsonl", [
        {
          timestamp: "2026-07-23T05:59:00.000Z",
          payload: {
            rate_limits: {
              limit_id: "codex",
              primary: {
                used_percent: 10,
                window_minutes: 300,
                resets_at: nowSec - 6 * 60 * 60,
              },
              secondary: null,
            },
          },
        },
      ]);
      writeRollout(sessionsRoot, now, "rollout-weekly-only.jsonl", [
        {
          timestamp: "2026-07-23T05:55:00.000Z",
          payload: {
            rate_limits: {
              limit_id: "codex",
              primary: {
                used_percent: 13,
                window_minutes: 10080,
                resets_at: nowSec + 6 * 24 * 60 * 60,
              },
              secondary: null,
            },
          },
        },
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(
        buckets.codex.primary,
        null,
        "a long-expired five-hour snapshot must not repopulate the 5h HUD slot",
      );
      assert.equal(buckets.codex.secondary.used_percent, 13);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("keeps a just-reset five-hour fallback during the probe polling gap", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-reset-grace-"),
    );
    const now = new Date("2026-07-23T06:00:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    try {
      writeRollout(sessionsRoot, now, "rollout-just-reset.jsonl", [
        {
          timestamp: "2026-07-23T05:59:00.000Z",
          payload: {
            rate_limits: {
              limit_id: "codex",
              primary: {
                used_percent: 10,
                window_minutes: 300,
                resets_at: nowSec - 60,
              },
              secondary: null,
            },
          },
        },
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.primary.used_percent, 0);
      assert.equal(buckets.codex.primary.expired, true);
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
          // 하루 전에 열린 창이라 무거운 창이 관측된 시각과 겹친다.
          secondaryResetsAt: nowSec + 6 * 24 * 60 * 60,
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

  it("puts a weekly-only probe snapshot in the 1w slot, not the 5h slot", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-probe-weekly-only-"),
    );
    const now = new Date("2026-09-23T13:50:00.000Z");
    try {
      // 2026-09-23 account/rateLimits/read 실측 응답을 옮긴 값이다.
      const probeSnapshot = {
        limitId: "codex",
        limitName: null,
        primary: {
          used_percent: 33,
          window_minutes: 10080,
          resets_at: 1790754846,
        },
        secondary: null,
        credits: null,
        tokens: null,
        contextWindow: null,
        timestamp: now.toISOString(),
        probe: true,
      };

      const buckets = getCodexRateLimits({
        sessionsRoot,
        now,
        extraSnapshots: [probeSnapshot],
      });

      assert.equal(
        buckets.codex.primary,
        null,
        "a weekly window must not fill the 5h HUD slot",
      );
      assert.equal(buckets.codex.secondary.used_percent, 33);
      assert.equal(buckets.codex.secondary.resets_at, 1790754846);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("drops a weekly window that an early reset replaced before its reset time", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-weekly-replaced-"),
    );
    const now = new Date("2026-09-23T13:50:00.000Z");
    try {
      // 2026-09-23 실측: 100% 였던 주간 창이 07:54 에 새 창으로 바뀌었다.
      // 옛 창은 그 뒤로 관측되지 않았지만 리셋 시각은 아직 4일 넘게 남았다.
      writeRollout(sessionsRoot, now, "rollout-old-window.jsonl", [
        weeklyOnlyEvent({
          timestamp: "2026-09-23T07:53:16.809Z",
          usedPercent: 100,
          resetsAt: 1790561788,
        }),
      ]);
      writeRollout(sessionsRoot, now, "rollout-new-window.jsonl", [
        weeklyOnlyEvent({
          timestamp: "2026-09-23T13:49:00.000Z",
          usedPercent: 34,
          resetsAt: 1790754846,
        }),
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.primary, null);
      assert.equal(buckets.codex.secondary.used_percent, 34);
      assert.equal(buckets.codex.secondary.resets_at, 1790754846);
      assert.equal(buckets.codex.mixedWindows, undefined);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("keeps max-used weekly selection when both windows were observed while open", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-weekly-concurrent-"),
    );
    const now = new Date("2026-09-23T13:50:00.000Z");
    try {
      // 새 창이 열린 뒤에도 옛 창이 관측되면 다른 계정이 함께 도는 것이다.
      writeRollout(sessionsRoot, now, "rollout-heavy-account.jsonl", [
        weeklyOnlyEvent({
          timestamp: "2026-09-23T13:40:00.000Z",
          usedPercent: 100,
          resetsAt: 1790561788,
        }),
      ]);
      writeRollout(sessionsRoot, now, "rollout-light-account.jsonl", [
        weeklyOnlyEvent({
          timestamp: "2026-09-23T13:49:00.000Z",
          usedPercent: 34,
          resetsAt: 1790754846,
        }),
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.secondary.used_percent, 100);
      assert.equal(buckets.codex.mixedWindows, true);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("uses the session window length when the newest probe omits it", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-five-hour-length-less-probe-"),
    );
    const now = new Date("2026-09-23T13:50:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    const fiveHourEvent = (timestamp, usedPercent, resetsAt) => ({
      timestamp,
      payload: {
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: usedPercent,
            window_minutes: 300,
            resets_at: resetsAt,
          },
          secondary: null,
        },
      },
    });
    try {
      // 옛 5h 창은 10:30 이 마지막 관측이고, 조기 리셋 뒤 11:50 에 새 창이 열렸다.
      writeRollout(sessionsRoot, now, "rollout-old-five-hour.jsonl", [
        fiveHourEvent("2026-09-23T10:30:00.000Z", 80, nowSec + 70 * 60),
      ]);
      writeRollout(sessionsRoot, now, "rollout-new-five-hour.jsonl", [
        fiveHourEvent("2026-09-23T13:40:00.000Z", 10, nowSec + 3 * 60 * 60),
      ]);
      const probeWithoutLength = {
        limitId: "codex",
        limitName: null,
        primary: {
          used_percent: 12,
          window_minutes: null,
          resets_at: nowSec + 3 * 60 * 60,
        },
        secondary: null,
        credits: null,
        tokens: null,
        contextWindow: null,
        timestamp: now.toISOString(),
        probe: true,
      };

      const buckets = getCodexRateLimits({
        sessionsRoot,
        now,
        extraSnapshots: [probeWithoutLength],
      });

      assert.equal(buckets.codex.primary.used_percent, 12);
      assert.equal(buckets.codex.mixedWindows, undefined);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("keeps a window observed shortly after the newer window opened", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-weekly-just-after-open-"),
    );
    const now = new Date("2026-09-23T13:50:00.000Z");
    try {
      // 새 창은 07:54:06 에 열렸고 옛 창은 그 24초 뒤에 관측됐다.
      writeRollout(sessionsRoot, now, "rollout-heavy-account.jsonl", [
        weeklyOnlyEvent({
          timestamp: "2026-09-23T07:54:30.000Z",
          usedPercent: 100,
          resetsAt: 1790561788,
        }),
      ]);
      writeRollout(sessionsRoot, now, "rollout-light-account.jsonl", [
        weeklyOnlyEvent({
          timestamp: "2026-09-23T13:49:00.000Z",
          usedPercent: 34,
          resetsAt: 1790754846,
        }),
      ]);

      const buckets = getCodexRateLimits({ sessionsRoot, now });

      assert.equal(buckets.codex.secondary.used_percent, 100);
      assert.equal(buckets.codex.mixedWindows, true);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("does not let a probe-only window replace a session window", () => {
    const sessionsRoot = mkdtempSync(
      join(tmpdir(), "triflux-codex-weekly-probe-only-"),
    );
    const now = new Date("2026-09-23T13:50:00.000Z");
    try {
      // 프로브는 세션 로그와 다른 계정(로그인 전환 뒤)의 창을 볼 수 있다.
      writeRollout(sessionsRoot, now, "rollout-current-account.jsonl", [
        weeklyOnlyEvent({
          timestamp: "2026-09-23T07:53:16.809Z",
          usedPercent: 100,
          resetsAt: 1790561788,
        }),
      ]);
      const probeSnapshot = {
        limitId: "codex",
        limitName: null,
        primary: {
          used_percent: 34,
          window_minutes: 10080,
          resets_at: 1790754846,
        },
        secondary: null,
        credits: null,
        tokens: null,
        contextWindow: null,
        timestamp: now.toISOString(),
        probe: true,
      };

      const buckets = getCodexRateLimits({
        sessionsRoot,
        now,
        extraSnapshots: [probeSnapshot],
      });

      assert.equal(buckets.codex.secondary.used_percent, 100);
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

  describe("tail read", () => {
    it("reverse reader: 작은 청크에서도 옛 trim().split().reverse() 와 같은 줄을 낸다", () => {
      const dir = mkdtempSync(join(tmpdir(), "triflux-codex-tail-"));
      try {
        const file = join(dir, "a.jsonl");
        const samples = [
          ["첫 줄", "", "가나다 ".repeat(40), '{"a":1}', "끝"].join("\n") +
            "\n\n",
          "\uFEFF\n \t첫\n\n끝\u00a0\n\r\n",
          "   \n \n",
          "",
          "한 줄",
        ];
        for (const text of samples) {
          writeFileSync(file, text);
          const expected = text.trim().split("\n").reverse();
          // 파일 머리의 공백은 머리가 한 청크에 들어올 때만 지운다.
          const chunks = /^\s/.test(text) ? [4096] : [1, 3, 7, 4096];
          for (const chunk of chunks) {
            const reader = createReverseLineReader(file, chunk);
            const got = [];
            for (let l = reader.next(); l !== null; l = reader.next()) {
              got.push(l);
            }
            reader.close();
            assert.deepEqual(got, expected, `chunk=${chunk}`);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reverse reader: 마지막 줄을 읽으려고 앞선 큰 줄을 읽지 않는다", () => {
      const dir = mkdtempSync(join(tmpdir(), "triflux-codex-tail-"));
      try {
        const file = join(dir, "a.jsonl");
        writeFileSync(file, `${"x".repeat(1_000_000)}\n{"last":1}\n`);
        const reader = createReverseLineReader(file);
        assert.equal(reader.next(), '{"last":1}');
        assert.ok(
          reader.bytesRead <= 64 * 1024,
          `bytesRead=${reader.bytesRead}`,
        );
        reader.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("첫 버킷 뒤 64KB 안에 다른 limit_id 가 없으면 첫 버킷만 반환한다", () => {
      const sessionsRoot = mkdtempSync(join(tmpdir(), "triflux-codex-cut-"));
      try {
        const now = new Date("2026-07-11T06:30:00.000Z");
        const nowSec = Math.floor(now.getTime() / 1000);
        const other = rateLimitEvent({
          timestamp: "2026-07-11T05:00:00.000Z",
          usedPercent: 50,
          resetsAt: nowSec + 3600,
        });
        other.payload.rate_limits.limit_id = "codex_other";
        const filler = {
          timestamp: "2026-07-11T05:30:00.000Z",
          payload: { output: "x".repeat(70_000) },
        };
        const newest = rateLimitEvent({
          timestamp: "2026-07-11T06:20:00.000Z",
          usedPercent: 33,
          resetsAt: nowSec + 3600,
        });
        writeRollout(sessionsRoot, now, "rollout-far.jsonl", [
          other,
          filler,
          newest,
        ]);
        const far = getCodexRateLimits({ sessionsRoot, now });
        assert.equal(far.codex.primary.used_percent, 33);
        assert.equal(far.codex_other, undefined);

        const nearRoot = mkdtempSync(join(tmpdir(), "triflux-codex-near-"));
        try {
          writeRollout(nearRoot, now, "rollout-near.jsonl", [other, newest]);
          const near = getCodexRateLimits({ sessionsRoot: nearRoot, now });
          assert.equal(near.codex_other.primary.used_percent, 50);
        } finally {
          rmSync(nearRoot, { recursive: true, force: true });
        }
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });

    it("큰 파일에서 끝의 버킷만 읽고 결과는 그대로다", () => {
      const sessionsRoot = mkdtempSync(join(tmpdir(), "triflux-codex-big-"));
      try {
        const now = new Date("2026-07-11T06:30:00.000Z");
        const nowSec = Math.floor(now.getTime() / 1000);
        const filler = {
          timestamp: "2026-07-11T05:00:00.000Z",
          payload: { output: "한".repeat(40_000) },
        };
        const events = [
          rateLimitEvent({
            timestamp: "2026-07-11T05:10:00.000Z",
            usedPercent: 10,
            resetsAt: nowSec + 3600,
          }),
          ...Array.from({ length: 300 }, () => filler),
          rateLimitEvent({
            timestamp: "2026-07-11T06:20:00.000Z",
            usedPercent: 33,
            resetsAt: nowSec + 3600,
          }),
          filler,
        ];
        writeRollout(sessionsRoot, now, "rollout-big.jsonl", events);
        const file = join(
          sessionsRoot,
          "2026",
          "07",
          "11",
          "rollout-big.jsonl",
        );

        const reader = createReverseLineReader(file);
        reader.next();
        reader.next();
        assert.ok(
          reader.bytesRead <= 256 * 1024,
          `bytesRead=${reader.bytesRead}`,
        );
        reader.close();

        const buckets = getCodexRateLimits({ sessionsRoot, now });
        assert.equal(buckets.codex.primary.used_percent, 33);
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });
  });
});
