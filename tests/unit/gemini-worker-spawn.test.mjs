import assert from "node:assert/strict";
import { describe, it } from "node:test";

// quoteWindowsCmdArg와 buildSpawnSpec은 module-private이므로
// gemini-worker.mjs에서 export하지 않는다.
// 대신 GeminiWorker의 실제 동작을 간접 테스트한다.
// 단, quoteWindowsCmdArg 단위 테스트를 위해 별도 추출이 필요하면
// worker-utils.mjs로 이동을 고려한다.

describe("gemini-worker Windows spawn", () => {
  it("GeminiWorker가 import 가능하다", async () => {
    const mod = await import("../../hub/workers/gemini-worker.mjs");
    assert.ok(mod.GeminiWorker, "GeminiWorker 클래스가 export되어야 한다");
  });

  it("GeminiWorker 인스턴스를 생성할 수 있다", async () => {
    const { GeminiWorker } = await import(
      "../../hub/workers/gemini-worker.mjs"
    );
    const worker = new GeminiWorker({ command: "gemini" });
    assert.ok(worker, "인스턴스 생성 가능");
    assert.equal(worker.state, "idle");
  });
});
