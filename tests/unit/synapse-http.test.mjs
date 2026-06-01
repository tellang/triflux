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
          // token: false keeps the headers deterministic regardless of whether a
          // ~/.claude/.tfx-hub-token file happens to exist on the test machine.
          token: false,
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

  it("token이 주어지면 Authorization Bearer 헤더를 붙인다", async () => {
    const calls = [];
    registerSynapseSession(
      { sessionId: "worker-tok" },
      {
        token: "secret-token",
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return { ok: true };
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
    assert.equal(calls[0].init.headers["content-type"], "application/json");
  });

  it("TFX_HUB_PORT env가 있으면 base URL을 해당 포트로 해석한다", async () => {
    const prev = process.env.TFX_HUB_PORT;
    process.env.TFX_HUB_PORT = "39999";
    try {
      const calls = [];
      registerSynapseSession(
        { sessionId: "worker-port" },
        {
          token: false,
          fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return { ok: true };
          },
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls[0].url, "http://127.0.0.1:39999/synapse/register");
    } finally {
      if (prev === undefined) delete process.env.TFX_HUB_PORT;
      else process.env.TFX_HUB_PORT = prev;
    }
  });

  it("register는 인터랙티브 peer 필드(cwd/pid/sessionKind)를 그대로 전달한다", async () => {
    const calls = [];
    registerSynapseSession(
      {
        sessionId: "interactive-1",
        cwd: "/home/dev/proj",
        pid: 4242,
        worktreePath: "/home/dev/proj",
        branch: "main",
        host: "local",
        sessionKind: "interactive",
        isRemote: false,
      },
      {
        token: false,
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return { ok: true };
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls[0].url, "http://127.0.0.1:27888/synapse/register");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.sessionId, "interactive-1");
    assert.equal(body.cwd, "/home/dev/proj");
    assert.equal(body.pid, 4242);
    assert.equal(body.sessionKind, "interactive");
    assert.equal(body.isRemote, false);
  });

  it("heartbeat는 sessionId + partial 형태로 보낸다 (live 라우트 shape)", async () => {
    const calls = [];
    heartbeatSynapseSession(
      "sess-1",
      { host: "remote", status: "healthy" },
      {
        token: false,
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return { ok: true };
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls[0].url, "http://127.0.0.1:27888/synapse/heartbeat");
    // The live route reads `{ sessionId, partial }` → heartbeat(sessionId, partial).
    assert.equal(
      calls[0].init.body,
      JSON.stringify({
        sessionId: "sess-1",
        partial: { host: "remote", status: "healthy" },
      }),
    );
  });

  it("unregister는 sessionId만 보낸다", async () => {
    const calls = [];
    unregisterSynapseSession("sess-2", {
      token: false,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls[0].url, "http://127.0.0.1:27888/synapse/unregister");
    assert.equal(calls[0].init.body, JSON.stringify({ sessionId: "sess-2" }));
  });

  it("timeoutMs가 주어지면 AbortSignal을 fetch init에 실어 보낸다", async () => {
    const calls = [];
    unregisterSynapseSession("sess-timeout", {
      token: false,
      timeoutMs: 1500,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      calls[0].init.signal,
      "expected an AbortSignal on the fetch init",
    );
    assert.equal(typeof calls[0].init.signal.aborted, "boolean");
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
