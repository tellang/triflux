import assert from "node:assert/strict";
import { describe, it } from "node:test";

// providers/codex.mjs에서 내부 함수를 테스트하기 위해 동적 import
// normalizeBuckets/classifyBucket은 모듈 내부 함수이므로,
// export된 getCodexRateLimits의 동작을 통해 간접 검증한다.
// 직접 단위 테스트를 위해 함수를 export 해야 함.

describe("Codex bucket normalization", () => {
  // classifyBucket 직접 테스트를 위해 모듈 로드
  let classifyBucket;
  let normalizeBuckets;

  it("should import internal functions", async () => {
    const mod = await import("../../hud/providers/codex.mjs");
    classifyBucket = mod.classifyBucket;
    normalizeBuckets = mod.normalizeBuckets;
    assert.ok(classifyBucket, "classifyBucket should be exported");
    assert.ok(normalizeBuckets, "normalizeBuckets should be exported");
  });

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
