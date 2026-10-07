import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CodexMcpWorker } from "../../hub/workers/codex-mcp.mjs";
import { createWorker } from "../../hub/workers/factory.mjs";

describe("worker factory", () => {
  it("createWorker('codex') returns CodexMcpWorker", async () => {
    const worker = await createWorker("codex");
    assert.ok(worker instanceof CodexMcpWorker);
    assert.equal(worker.type, "codex");
  });

  it("codex 워커는 approvalPolicy 값을 막지 않는다", async () => {
    const worker = await createWorker("codex", { approvalPolicy: "on-failure" });
    assert.ok(worker instanceof CodexMcpWorker);
  });

  it("unknown worker type still rejects with a recognizable error", async () => {
    await assert.rejects(
      () => createWorker("nonexistent"),
      /Unknown worker type/,
    );
  });
});
