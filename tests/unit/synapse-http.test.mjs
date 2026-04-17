import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSynapseTaskSummary,
  fireAndForgetSynapse,
  heartbeatSynapseSession,
  registerSynapseSession,
  unregisterSynapseSession,
} from "../../hub/team/synapse-http.mjs";

describe("synapse-http helpers", () => {
  it("task summary를 앞 100자로 자른다", () => {
    const prompt = "a".repeat(120);
    assert.equal(buildSynapseTaskSummary(prompt).length, 100);
    assert.equal(buildSynapseTaskSummary(prompt), "a".repeat(100));
  });

  it("register는 지정한 endpoint에 POST한다", async () => {
    const calls = [];
    assert.equal(
      registerSynapseSession(
        { sessionId: "worker-1", host: "local", taskSummary: "hello" },
        {
          fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return { ok: true };
          },
        },
      ),
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:27888/synapse/register",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "worker-1",
            host: "local",
            taskSummary: "hello",
          }),
        },
      },
    ]);
  });

  it("heartbeat는 sessionId와 partial meta를 함께 보낸다", async () => {
    const calls = [];
    heartbeatSynapseSession(
      "sess-1",
      { host: "remote", status: "healthy" },
      {
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return { ok: true };
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls[0].url, "http://127.0.0.1:27888/synapse/heartbeat");
    assert.equal(
      calls[0].init.body,
      JSON.stringify({
        sessionId: "sess-1",
        host: "remote",
        status: "healthy",
      }),
    );
  });

  it("unregister는 sessionId만 보낸다", async () => {
    const calls = [];
    unregisterSynapseSession("sess-2", {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls[0].url, "http://127.0.0.1:27888/synapse/unregister");
    assert.equal(calls[0].init.body, JSON.stringify({ sessionId: "sess-2" }));
  });

  it("hub 미응답이어도 fail-open으로 끝난다", async () => {
    assert.equal(
      fireAndForgetSynapse(
        "/synapse/register",
        { sessionId: "sess-3" },
        {
          fetchImpl: async () => {
            throw new Error("hub down");
          },
        },
      ),
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      fireAndForgetSynapse(
        "/synapse/register",
        { sessionId: "sess-4" },
        { fetchImpl: null },
      ),
      false,
    );
  });
});
