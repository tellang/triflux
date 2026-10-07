import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CodexAppServerWorker } from "../../hub/workers/codex-app-server-worker.mjs";
import { CodexMcpWorker } from "../../hub/workers/codex-mcp.mjs";
import { createWorker } from "../../hub/workers/factory.mjs";

describe("worker factory — AC-9 dispatch", () => {
  it("1. createWorker('codex') returns CodexMcpWorker (AC-11 regression, zero default change)", async () => {
    const worker = await createWorker("codex");
    assert.ok(
      worker instanceof CodexMcpWorker,
      "default codex type must remain MCP transport",
    );
    assert.equal(worker.type, "codex");
  });

  it("2. createWorker('codex', { transport: 'app-server' }) returns CodexAppServerWorker", async () => {
    const worker = await createWorker("codex", { transport: "app-server" });
    assert.ok(
      worker instanceof CodexAppServerWorker,
      "transport=app-server must route to app-server worker",
    );
    assert.equal(worker.type, "codex");
    assert.equal(worker.transport, "app-server");
  });

  it("3. createWorker('codex-app-server') returns CodexAppServerWorker (explicit name)", async () => {
    const worker = await createWorker("codex-app-server");
    assert.ok(
      worker instanceof CodexAppServerWorker,
      "explicit codex-app-server type must route to app-server worker",
    );
  });

  it("4. createWorker('codex', { transport: 'mcp' }) explicitly returns CodexMcpWorker", async () => {
    const worker = await createWorker("codex", { transport: "mcp" });
    assert.ok(worker instanceof CodexMcpWorker);
  });
});

describe("worker factory — AC-10 publishCallback wiring", () => {
  it("5. app-server worker has no default publishCallback when none is provided", async () => {
    const worker = await createWorker("codex", { transport: "app-server" });
    assert.equal(
      worker.publishCallback,
      null,
      "기본 워커는 허브에 발행하지 않는다",
    );
  });

  it("6. factory passes through a user-provided publishCallback unchanged", async () => {
    const userCallback = async () => {};
    const worker = await createWorker("codex", {
      transport: "app-server",
      publishCallback: userCallback,
    });
    assert.equal(
      worker.publishCallback,
      userCallback,
      "user publishCallback must be preserved by reference",
    );
  });

  it("7. requestJsonFn이 있어도 기본 허브 발행은 연결하지 않는다", async () => {
    const worker = await createWorker("codex", {
      transport: "app-server",
      requestJsonFn: () => assert.fail("unexpected hub publish"),
    });
    assert.equal(worker.publishCallback, null);
  });
});

describe("worker factory — AC-11 regression", () => {
  it("9. no opts → CodexMcpWorker (unchanged behavior for existing callers)", async () => {
    const worker = await createWorker("codex");
    assert.ok(worker instanceof CodexMcpWorker);
    assert.ok(!(worker instanceof CodexAppServerWorker));
  });

  it("10. unknown worker type still rejects with a recognizable error", async () => {
    await assert.rejects(
      () => createWorker("nonexistent"),
      /Unknown worker type/,
    );
  });
});

describe("worker factory — Issue #95 P1 #4 approvalPolicy validation", () => {
  it("11. app-server transport + approvalPolicy='never' is accepted", async () => {
    const worker = await createWorker("codex", {
      transport: "app-server",
      approvalPolicy: "never",
    });
    assert.ok(worker instanceof CodexAppServerWorker);
  });

  it("12. app-server transport + approvalPolicy='on-failure' rejects", async () => {
    await assert.rejects(
      () =>
        createWorker("codex", {
          transport: "app-server",
          approvalPolicy: "on-failure",
        }),
      /approvalPolicy='never'/,
    );
  });

  it("13. app-server transport + approvalPolicy='untrusted' rejects", async () => {
    await assert.rejects(
      () => createWorker("codex-app-server", { approvalPolicy: "untrusted" }),
      /approvalPolicy='never'/,
    );
  });

  it("14. app-server transport + undefined approvalPolicy defaults OK", async () => {
    const worker = await createWorker("codex", { transport: "app-server" });
    assert.ok(worker instanceof CodexAppServerWorker);
  });

  it("15. mcp transport with non-never approvalPolicy is NOT blocked (no regression)", async () => {
    // The restriction only applies to the app-server transport; the legacy MCP
    // path continues to accept any approvalPolicy value.
    const worker = await createWorker("codex", {
      transport: "mcp",
      approvalPolicy: "on-failure",
    });
    assert.ok(worker instanceof CodexMcpWorker);
  });
});
