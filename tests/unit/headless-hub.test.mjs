import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deregisterHeadlessWorkers,
  getHeadlessLeadAgentId,
  getHeadlessWorkerAgentId,
  publishHeadlessResult,
  registerHeadlessWorker,
} from "../../hub/team/headless.mjs";

describe("headless hub helpers", () => {
  it("worker/lead agent id를 일관되게 만든다", () => {
    assert.equal(getHeadlessWorkerAgentId("sess-1", 0), "headless-sess-1-0");
    assert.equal(getHeadlessLeadAgentId("sess-1"), "headless-sess-1-lead");
  });

  it("registerHeadlessWorker가 bridge register payload를 보낸다", async () => {
    const calls = [];
    await registerHeadlessWorker(
      "sess-1",
      2,
      "codex",
      async (path, options) => {
        calls.push({ path, options });
        return { ok: true };
      },
    );

    assert.deepEqual(calls, [
      {
        path: "/bridge/register",
        options: {
          body: {
            agentId: "headless-sess-1-2",
            topics: ["headless.worker"],
            capabilities: ["codex"],
          },
        },
      },
    ]);
  });

  it("publishHeadlessResult가 bridge publish payload를 보낸다", async () => {
    const calls = [];
    await publishHeadlessResult(
      "sess-1",
      "headless-sess-1-0",
      "completed",
      { status: "completed" },
      async (path, options) => {
        calls.push({ path, options });
        return { ok: true };
      },
    );

    assert.deepEqual(calls, [
      {
        path: "/bridge/publish",
        options: {
          body: {
            from: "headless-sess-1-lead",
            to: "topic:headless.results",
            type: "event",
            payload: {
              workerId: "headless-sess-1-0",
              status: "completed",
              handoff: { status: "completed" },
            },
          },
        },
      },
    ]);
  });

  it("deregisterHeadlessWorkers가 모든 worker를 deregister한다", async () => {
    const calls = [];
    await deregisterHeadlessWorkers("sess-1", 3, async (path, options) => {
      calls.push({ path, options });
      return { ok: true };
    });

    assert.deepEqual(calls, [
      {
        path: "/bridge/deregister",
        options: { body: { agentId: "headless-sess-1-0" } },
      },
      {
        path: "/bridge/deregister",
        options: { body: { agentId: "headless-sess-1-1" } },
      },
      {
        path: "/bridge/deregister",
        options: { body: { agentId: "headless-sess-1-2" } },
      },
    ]);
  });

  it("Hub 호출 실패를 삼켜 기존 동작을 유지한다", async () => {
    await assert.doesNotReject(() =>
      registerHeadlessWorker("sess-1", 0, "codex", async () => {
        throw new Error("hub down");
      }),
    );
    await assert.doesNotReject(() =>
      publishHeadlessResult(
        "sess-1",
        "headless-sess-1-0",
        "failed",
        null,
        async () => {
          throw new Error("hub down");
        },
      ),
    );
    await assert.doesNotReject(() =>
      deregisterHeadlessWorkers("sess-1", 2, async () => {
        throw new Error("hub down");
      }),
    );
  });
});
