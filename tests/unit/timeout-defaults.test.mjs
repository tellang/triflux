import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampDurationMs,
  DEFAULT_ASSIGN_TIMEOUT_MS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  resolveHardCeilingMs,
  resolveStallInterventionMs,
  resolveWorkerLeaseTtlMs,
} from "../../hub/lib/timeout-defaults.mjs";

describe("timeout-defaults", () => {
  it("기존 assign duration clamp와 호환된다", () => {
    assert.equal(clampDurationMs(Number.NaN, 5000), 5000);
    assert.equal(clampDurationMs(500), MIN_DURATION_MS);
    assert.equal(clampDurationMs(1e12), MAX_DURATION_MS);
    assert.equal(clampDurationMs(undefined), DEFAULT_ASSIGN_TIMEOUT_MS);
  });

  it("환경은 호출 시점에 판독한다", () => {
    assert.equal(resolveHardCeilingMs({ TFX_HARD_CEILING_SEC: "60" }), 60_000);
    assert.equal(resolveHardCeilingMs({}), 21_600_000);
    assert.equal(resolveStallInterventionMs({}), 1_200_000);
    assert.equal(resolveWorkerLeaseTtlMs({}), 1_320_000);
    assert.equal(
      resolveHardCeilingMs({ TFX_HARD_CEILING_SEC: "-1" }),
      21_600_000,
    );
  });
});
