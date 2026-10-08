import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClaudeWorker } from "../../hub/workers/claude-worker.mjs";
import { createWorker } from "../../hub/workers/factory.mjs";

describe("worker factory", () => {
  it("타입별 worker 인스턴스를 생성한다", async () => {
    assert.ok((await createWorker("claude")) instanceof ClaudeWorker);
  });

  it("알 수 없는 타입은 거부한다", async () => {
    await assert.rejects(
      () => createWorker("nonexistent"),
      /Unknown worker type/,
    );
  });
});
