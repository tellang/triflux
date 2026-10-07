import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("smoke: 주요 모듈 import 검증", () => {
  it("hub/team/shared.mjs — ANSI 상수 export", async () => {
    const mod = await import("../../hub/team/shared.mjs");
    assert.equal(typeof mod.AMBER, "string");
    assert.equal(typeof mod.RESET, "string");
  });

  it("hub/team/staleState.mjs — stale 상태 유틸 export", async () => {
    const mod = await import("../../hub/team/staleState.mjs");
    assert.equal(typeof mod.TEAM_STATE_FILE_NAME, "string");
    assert.equal(typeof mod.STALE_TEAM_MAX_AGE_MS, "number");
  });

  it("hub/pipeline/transitions.mjs — 파이프라인 전이 규칙 export", async () => {
    const mod = await import("../../hub/pipeline/transitions.mjs");
    assert.ok(Array.isArray(mod.PHASES));
    assert.ok(mod.PHASES.includes("plan"));
    assert.ok(mod.PHASES.includes("complete"));
    assert.ok(mod.TERMINAL instanceof Set);
    assert.ok(mod.TERMINAL.has("complete"));
    assert.ok(mod.TERMINAL.has("failed"));
  });
});
