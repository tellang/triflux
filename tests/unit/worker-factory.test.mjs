// tests/unit/worker-factory.test.mjs — Factory dispatch + publishCallback wiring
//
// Covers PRD-3 AC-9 (factory dispatch), AC-10 (default publishCallback wiring),
// and AC-11 (codex-mcp regression sanity: default path still returns MCP worker).
//
// Philosophy:
// - Pure class-identity checks via `instanceof` — no codex spawn, no network.
// - requestJsonFn injection is validated by constructing a fake and confirming
//   the default publishCallback routes to it when invoked.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CodexAppServerWorker } from "../../hub/workers/codex-app-server-worker.mjs";
import { CodexMcpWorker } from "../../hub/workers/codex-mcp.mjs";
import { createWorker } from "../../hub/workers/factory.mjs";

describe("worker factory — AC-9 dispatch", () => {
  it("1. createWorker('codex') returns CodexMcpWorker (AC-11 regression, zero default change)", () => {
    const worker = createWorker("codex");
    assert.ok(
      worker instanceof CodexMcpWorker,
      "default codex type must remain MCP transport",
    );
    assert.equal(worker.type, "codex");
  });

  it("2. createWorker('codex', { transport: 'app-server' }) returns CodexAppServerWorker", () => {
    const worker = createWorker("codex", { transport: "app-server" });
    assert.ok(
      worker instanceof CodexAppServerWorker,
      "transport=app-server must route to app-server worker",
    );
    assert.equal(worker.type, "codex");
    assert.equal(worker.transport, "app-server");
  });

  it("3. createWorker('codex-app-server') returns CodexAppServerWorker (explicit name)", () => {
    const worker = createWorker("codex-app-server");
    assert.ok(
      worker instanceof CodexAppServerWorker,
      "explicit codex-app-server type must route to app-server worker",
    );
  });

  it("4. createWorker('codex', { transport: 'mcp' }) explicitly returns CodexMcpWorker", () => {
    const worker = createWorker("codex", { transport: "mcp" });
    assert.ok(worker instanceof CodexMcpWorker);
  });
});

describe("worker factory — AC-10 publishCallback wiring", () => {
  it("5. app-server worker gets a default publishCallback function when none is provided", () => {
    const worker = createWorker("codex", { transport: "app-server" });
    assert.equal(
      typeof worker.publishCallback,
      "function",
      "factory must inject a default publishCallback closure",
    );
  });

  it("6. factory passes through a user-provided publishCallback unchanged", () => {
    const userCallback = async () => {};
    const worker = createWorker("codex", {
      transport: "app-server",
      publishCallback: userCallback,
    });
    assert.equal(
      worker.publishCallback,
      userCallback,
      "user publishCallback must be preserved by reference",
    );
  });

  it("7. default publishCallback routes to injected requestJsonFn at /bridge/publish", async () => {
    const calls = [];
    const fakeRequestJson = async (path, opts) => {
      calls.push({ path, body: opts?.body });
      return { ok: true };
    };

    const worker = createWorker("codex", {
      transport: "app-server",
      requestJsonFn: fakeRequestJson,
    });

    assert.equal(typeof worker.publishCallback, "function");

    const publishMessage = {
      from: "codex-app-server-test",
      to: "topic:agent.progress",
      topic: "agent.progress",
      type: "event",
      payload: { type: "agent.progress", version: 1 },
    };
    await worker.publishCallback(publishMessage);

    assert.equal(calls.length, 1, "default callback must call requestJsonFn exactly once");
    assert.equal(calls[0].path, "/bridge/publish");
    assert.deepEqual(calls[0].body, publishMessage);
  });

  it("8. default publishCallback swallows requestJsonFn rejections (best-effort)", async () => {
    const fakeRequestJson = async () => {
      throw new Error("bridge down");
    };
    const worker = createWorker("codex-app-server", {
      requestJsonFn: fakeRequestJson,
    });

    // Must not throw — publish failures must never crash worker logic.
    await assert.doesNotReject(
      () => worker.publishCallback({ from: "x", to: "topic:y", payload: {} }),
    );
  });
});

describe("worker factory — AC-11 regression", () => {
  it("9. no opts → CodexMcpWorker (unchanged behavior for existing callers)", () => {
    const worker = createWorker("codex");
    assert.ok(worker instanceof CodexMcpWorker);
    assert.ok(!(worker instanceof CodexAppServerWorker));
  });

  it("10. unknown worker type still throws a recognizable error", () => {
    assert.throws(() => createWorker("nonexistent"), /Unknown worker type/);
  });
});
