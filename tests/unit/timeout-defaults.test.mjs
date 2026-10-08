import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  clampDurationMs,
  DEFAULT_ASSIGN_TIMEOUT_MS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  resolveHardCeilingMs,
  resolveStallInterventionMs,
  resolveStallKill,
  resolveWorkerLeaseTtlMs,
} from "../../hub/lib/timeout-defaults.mjs";
import { createActivityLifecycle } from "../../hub/lib/worker-lifecycle.mjs";

describe("timeout-defaults", () => {
  it("기존 assign duration clamp와 호환된다", () => {
    assert.equal(clampDurationMs(Number.NaN, 5000), 5000);
    assert.equal(clampDurationMs(500), MIN_DURATION_MS);
    assert.equal(clampDurationMs(1e12), MAX_DURATION_MS);
    assert.equal(clampDurationMs(undefined), DEFAULT_ASSIGN_TIMEOUT_MS);
  });

  const noProfile = { TFX_MACHINE_PROFILE_PATH: "/nonexistent/profile.env" };

  it("환경은 호출 시점에 판독한다", () => {
    assert.equal(
      resolveHardCeilingMs({ ...noProfile, TFX_HARD_CEILING_SEC: "60" }),
      60_000,
    );
    assert.equal(resolveHardCeilingMs(noProfile), 21_600_000);
    assert.equal(resolveStallInterventionMs(noProfile), 1_200_000);
    assert.equal(resolveWorkerLeaseTtlMs(noProfile), 1_320_000);
    assert.equal(resolveStallKill(noProfile), "kill");
    assert.equal(
      resolveHardCeilingMs({ ...noProfile, TFX_HARD_CEILING_SEC: "-1" }),
      21_600_000,
    );
  });

  it("셸과 같이 0 은 상한 없음이고, env 가 없으면 machine profile 을 읽는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-timeout-profile-"));
    try {
      const profile = join(dir, "machine-profile.env");
      writeFileSync(
        profile,
        "TFX_HARD_CEILING_SEC=0\nTFX_STALL_THRESHOLD=300\nTFX_STALL_KILL=classify\n",
      );
      const env = { TFX_MACHINE_PROFILE_PATH: profile };
      assert.equal(resolveHardCeilingMs(env), Number.POSITIVE_INFINITY);
      assert.equal(resolveStallInterventionMs(env), 300_000);
      assert.equal(resolveStallKill(env), "classify");
      assert.equal(
        resolveHardCeilingMs({ ...env, TFX_HARD_CEILING_SEC: "60" }),
        60_000,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classify 는 무활동이어도 끝내지 않고, 상한 없음은 시간이 지나도 끝내지 않는다", async () => {
    let clock = 0;
    const lifecycle = createActivityLifecycle({
      enabled: true,
      interventionMs: 10,
      hardCeilingMs: Number.POSITIVE_INFINITY,
      stallKill: "classify",
      onIntervene: () => assert.fail("classify 는 개입하지 않는다"),
      now: () => clock,
    });
    clock = 1e12;
    assert.equal(await lifecycle.check(), "");
  });
});
