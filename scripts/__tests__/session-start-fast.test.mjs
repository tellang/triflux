import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("session-start-fast: 모듈 구조 검증", () => {
  it("hooks/session-start-fast.mjs import 성공", async () => {
    const mod = await import("../../hooks/session-start-fast.mjs");
    assert.ok(mod);
    assert.equal(typeof mod.execute, "function");
  });

  it("BLOCKING 훅 모듈 import 가능", async () => {
    const setup = await import("../../scripts/setup.mjs");
    assert.equal(typeof setup.runCritical, "function");

    const guard = await import("../../scripts/mcp-safety-guard.mjs");
    assert.equal(typeof guard.run, "function");
  });

  it("DEFERRED 훅 모듈 import 가능", async () => {
    const hubEnsure = await import("../../scripts/hub-ensure.mjs");
    assert.equal(typeof hubEnsure.run, "function");

    const gateway = await import("../../scripts/mcp-gateway-ensure.mjs");
    assert.equal(typeof gateway.run, "function");
  });

  it("BACKGROUND 훅 모듈 import 가능", async () => {
    const preflight = await import("../../scripts/preflight-cache.mjs");
    assert.equal(typeof preflight.run, "function");
  });

  it("setup.mjs에 runDeferred export 존재", async () => {
    const setup = await import("../../scripts/setup.mjs");
    assert.equal(typeof setup.runDeferred, "function");
  });
});
