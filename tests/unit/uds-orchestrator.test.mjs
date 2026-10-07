import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCodexContext } from "../../hub/team/session-context.mjs";
import {
  askCodexAppServerThread,
  listCodexAppServerThreads,
  renameCodexAppServerThread,
} from "../../hub/team/uds-orchestrator.mjs";
import { JsonRpcWsUdsClient } from "../../hub/workers/lib/jsonrpc-ws-uds.mjs";

const FAKE_CODEX_SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-codex-app-server-ws-uds.mjs",
);

async function withFakeCodexServer(env, fn) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cx-"));
  const socketPath = path.join(dir, "fake.sock");
  const child = spawn(process.execPath, [FAKE_CODEX_SERVER, socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  try {
    for (let i = 0; i < 100; i++) {
      if ((await fs.stat(socketPath).catch(() => null))?.isSocket()) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await fs.stat(socketPath)).isSocket(), true);
    await fn(socketPath);
  } finally {
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, "exit").catch(() => {});
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exited;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("Codex rename uses thread/name/set empty success response and closes its client", async () => {
  const calls = [];
  let closed = false;
  const result = await renameCodexAppServerThread({
    socketPath: "/fake.sock",
    threadId: "one",
    name: "10.8 운영 개선",
    clientFactory: () => ({
      async connect() {},
      notify() {},
      close() {
        closed = true;
      },
      async request(method, params) {
        calls.push({ method, params });
        return {};
      },
    }),
  });
  assert.deepEqual(calls.at(-1), {
    method: "thread/name/set",
    params: { threadId: "one", name: "10.8 운영 개선" },
  });
  assert.equal(result.nameApplied, true);
  assert.equal(result.name, "10.8 운영 개선");
  assert.equal(closed, true);
});

test("Codex UDS lists loaded threads and filters by real cwd", async () => {
  await withFakeCodexServer(
    { FAKE_LOADED_THREADS: '["one","two"]' },
    async (socketPath) => {
      const threads = await listCodexAppServerThreads({
        socketPath,
        cwd: process.cwd(),
      });
      assert.deepEqual(
        threads.map((thread) => thread.threadId),
        ["one", "two"],
      );
      assert.equal(threads[0].status.type, "idle");
      assert.equal(threads[0].source, "cli");
    },
  );
});

test("Codex UDS auto selection reports zero and multiple loaded threads", async () => {
  await withFakeCodexServer(
    { FAKE_LOADED_THREADS: "[]" },
    async (socketPath) => {
      await assert.rejects(
        () =>
          askCodexAppServerThread({
            socketPath,
            threadId: "auto",
            prompt: "ping",
          }),
        /first message/,
      );
    },
  );
  await withFakeCodexServer(
    { FAKE_LOADED_THREADS: '["one","two"]' },
    async (socketPath) => {
      await assert.rejects(
        () =>
          askCodexAppServerThread({
            socketPath,
            threadId: "auto",
            prompt: "ping",
          }),
        /"threadId":"one"/,
      );
    },
  );
});

test("Codex UDS keeps loaded threads whose cwd was removed", async () => {
  await withFakeCodexServer(
    { FAKE_CWD: "/tmp/tfx-deleted-worktree-uds" },
    async (socketPath) => {
      const threads = await listCodexAppServerThreads({ socketPath });
      assert.equal(threads.length, 1);
      assert.equal(threads[0].cwd, "/tmp/tfx-deleted-worktree-uds");
      const selected = await askCodexAppServerThread({
        socketPath,
        threadId: "auto",
        cwd: "/tmp/tfx-deleted-worktree-uds",
        prompt: "ping",
      });
      assert.equal(selected.threadId, "fake-thread-ws");
    },
  );
});

test("Codex UDS retry notification continues and reports retry count", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "retry-notification" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
      });
      assert.equal(result.done, true);
      assert.equal(result.response, "PONG");
      assert.equal(result.meta.retries, 1);
    },
  );
});

test("Codex UDS selects final agent messages and keeps commentary separate", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "multi-message" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
      });
      assert.equal(result.response, "FINAL ONE\n\nFINAL TWO");
      assert.deepEqual(result.commentary, ["working"]);
    },
  );
});

test("Codex UDS uses the last agent message without final_answer phase", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "multi-message-no-final" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
      });
      assert.equal(result.response, "last message");
      assert.deepEqual(result.commentary, ["first message", "last message"]);
    },
  );
});

test("Codex UDS item/completed full text replaces a partial delta", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "partial-completed" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
      });
      assert.equal(result.response, "PONG");
      assert.deepEqual(result.commentary, []);
    },
  );
});

test("Codex UDS ask resumes before turn, collecting immediate notifications", async () => {
  await withFakeCodexServer({ FAKE_DELTAS: "PO,NG" }, async (socketPath) => {
    const result = await askCodexAppServerThread({
      socketPath,
      threadId: "auto",
      prompt: "ping",
      timeoutMs: 200,
    });
    assert.equal(result.threadId, "fake-thread-ws");
    assert.equal(result.turnId, "turn-ws-1");
    assert.equal(result.response, "PONG");
    assert.equal(result.done, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.busyWaitedMs, 0);
  });
});

test("Codex UDS fixture withholds turn notifications without resume", async () => {
  await withFakeCodexServer({}, async (socketPath) => {
    const client = new JsonRpcWsUdsClient({ socketPath });
    const subscriber = new JsonRpcWsUdsClient({ socketPath });
    try {
      for (const peer of [client, subscriber]) {
        await peer.connect();
        await peer.request("initialize", {
          clientInfo: { name: "test", version: "1" },
        });
        peer.notify("initialized", {});
      }
      await subscriber.request("thread/resume", {
        threadId: "fake-thread-ws",
        excludeTurns: true,
      });
      const seen = {
        status: 0,
        delta: 0,
        completed: 0,
        subscribedDelta: 0,
        subscribedCompleted: 0,
      };
      client.onNotification("thread/status/changed", () => seen.status++);
      client.onNotification("item/agentMessage/delta", () => seen.delta++);
      client.onNotification("turn/completed", () => seen.completed++);
      subscriber.onNotification(
        "item/agentMessage/delta",
        () => seen.subscribedDelta++,
      );
      subscriber.onNotification(
        "turn/completed",
        () => seen.subscribedCompleted++,
      );
      await client.request("turn/start", {
        threadId: "fake-thread-ws",
        input: [{ type: "text", text: "ping" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(seen.status, 1);
      assert.equal(seen.delta, 0);
      assert.equal(seen.completed, 0);
      assert.equal(seen.subscribedDelta, 4);
      assert.equal(seen.subscribedCompleted, 1);
    } finally {
      client.close();
      subscriber.close();
    }
  });
});

test("Codex UDS ask rejects resume failure", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "resume-failed" },
    async (socketPath) => {
      await assert.rejects(
        () =>
          askCodexAppServerThread({
            socketPath,
            threadId: "fake-thread-ws",
            prompt: "ping",
          }),
        /resume failed/,
      );
    },
  );
});

test("Codex UDS ignores another turn and preserves tool-only activity", async () => {
  await withFakeCodexServer({ FAKE_MODE: "mixed-ids" }, async (socketPath) => {
    const result = await askCodexAppServerThread({
      socketPath,
      threadId: "fake-thread-ws",
      prompt: "ping",
      timeoutMs: 200,
    });
    assert.equal(result.response, "PONG");
    assert.equal(result.done, true);
    assert.equal(result.turnId, "turn-ws-1");
  });
  await withFakeCodexServer(
    { FAKE_MODE: "missing-completion-id" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
        timeoutMs: 200,
      });
      assert.equal(result.done, true);
      assert.equal(result.status, "completed");
    },
  );
  await withFakeCodexServer(
    { FAKE_MODE: "tool-activity" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
        timeoutMs: 150,
      });
      assert.equal(result.done, true);
      assert.equal(result.timedOut, false);
    },
  );
});

test("Codex UDS error notification fails the turn", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "error-notification" },
    async (socketPath) => {
      await assert.rejects(
        () =>
          askCodexAppServerThread({
            socketPath,
            threadId: "fake-thread-ws",
            prompt: "ping",
            timeoutMs: 200,
          }),
        /fake turn error/,
      );
    },
  );
});

test("Codex UDS busy wait, fail, and steer respect active thread", async () => {
  await withFakeCodexServer({ FAKE_ACTIVE_READS: "2" }, async (socketPath) => {
    const result = await askCodexAppServerThread({
      socketPath,
      threadId: "fake-thread-ws",
      prompt: "ping",
      pollIntervalMs: 10,
      busyTimeoutMs: 200,
    });
    assert.equal(result.done, true);
    assert.ok(result.busyWaitedMs >= 10);
    assert.equal(result.steered, false);
  });
  await withFakeCodexServer(
    { FAKE_ACTIVE_READS: "100" },
    async (socketPath) => {
      await assert.rejects(
        () =>
          askCodexAppServerThread({
            socketPath,
            threadId: "fake-thread-ws",
            prompt: "ping",
            ifBusy: "fail",
          }),
        /target busy/,
      );
      await assert.rejects(
        () =>
          askCodexAppServerThread({
            socketPath,
            threadId: "fake-thread-ws",
            prompt: "ping",
            busyTimeoutMs: 20,
            pollIntervalMs: 5,
          }),
        /target busy after/,
      );
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
        ifBusy: "steer",
      });
      assert.equal(result.steered, true);
      assert.equal(result.turnId, "active-turn-ws-1");
    },
  );
});

test("Codex UDS steer reports a new turn when an active read races with completion", async () => {
  await withFakeCodexServer({ FAKE_ACTIVE_READS: "1" }, async (socketPath) => {
    const result = await askCodexAppServerThread({
      socketPath,
      threadId: "fake-thread-ws",
      prompt: "ping",
      ifBusy: "steer",
    });
    assert.equal(result.done, true);
    assert.equal(result.turnId, "turn-ws-1");
    assert.equal(result.steered, false);
  });
});

test("Codex UDS uses turn/steer when the active turn id is available", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "active-turns-visible", FAKE_ACTIVE_READS: "100" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
        ifBusy: "steer",
      });
      assert.equal(result.done, true);
      assert.equal(result.turnId, "active-turn-ws-1");
      assert.equal(result.steered, true);
    },
  );
});

test("Codex UDS busy wait uses an idle final read at the deadline", async () => {
  let reads = 0;
  let turnStarts = 0;
  let secondReadTimeout;
  const listeners = new Map();
  const client = {
    async connect() {},
    notify() {},
    close() {},
    onNotification(method, callback) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(callback);
      return () => listeners.get(method).delete(callback);
    },
    async request(method, _params, timeoutMs) {
      if (method === "thread/read") {
        reads++;
        if (reads === 1) return { thread: { status: { type: "active" } } };
        secondReadTimeout = timeoutMs;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { thread: { status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        turnStarts++;
        for (const callback of listeners.get("turn/started"))
          callback({ threadId: "one", turn: { id: "turn-1" } });
        for (const callback of listeners.get("turn/completed"))
          callback({
            threadId: "one",
            turn: { id: "turn-1", status: "completed" },
          });
        return { turn: { id: "turn-1" } };
      }
      return {};
    },
  };
  const result = await askCodexAppServerThread({
    socketPath: "/fake.sock",
    threadId: "one",
    prompt: "ping",
    busyTimeoutMs: 20,
    pollIntervalMs: 1,
    clientFactory: () => client,
  });
  assert.equal(result.done, true);
  assert.ok(secondReadTimeout > 0 && secondReadTimeout <= 20);
  assert.equal(turnStarts, 1);
});

test("Codex UDS timeout leaves the daemon untouched", async () => {
  await withFakeCodexServer({ FAKE_MODE: "timeout" }, async (socketPath) => {
    const result = await askCodexAppServerThread({
      socketPath,
      threadId: "fake-thread-ws",
      prompt: "ping",
      timeoutMs: 30,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.done, false);
    assert.equal(result.matchedCompletion, false);
    assert.equal((await fs.stat(socketPath)).isSocket(), true);
  });
});

test("Codex UDS ask honors maxTurnMs despite tool activity", async () => {
  await withFakeCodexServer(
    { FAKE_MODE: "tool-activity" },
    async (socketPath) => {
      const result = await askCodexAppServerThread({
        socketPath,
        threadId: "fake-thread-ws",
        prompt: "ping",
        timeoutMs: 150,
        maxTurnMs: 100,
      });
      assert.equal(result.timedOut, true);
      assert.equal(result.matchedCompletion, false);
    },
  );
});

test("Codex UDS clears turn timers and listeners on completion, timeout, error, and turn/start failure", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const allocated = [];
  const cleared = new Set();
  globalThis.setTimeout = (...args) => {
    const handle = originalSetTimeout(...args);
    // 비동기 재등록에서는 최초 호출 stack이 사라져도 타이머를 추적한다.
    allocated.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    cleared.add(handle);
    return originalClearTimeout(handle);
  };
  try {
    for (const mode of [
      "complete",
      "timeout",
      "notification-error",
      "start-error",
    ]) {
      const listeners = new Map();
      const client = {
        closed: false,
        async connect() {},
        notify() {},
        close() {
          this.closed = true;
        },
        onNotification(method, callback) {
          if (!listeners.has(method)) listeners.set(method, new Set());
          listeners.get(method).add(callback);
          return () => listeners.get(method).delete(callback);
        },
        async request(method) {
          if (method === "thread/read")
            return { thread: { status: { type: "idle" } } };
          if (method === "turn/start") {
            if (mode === "start-error") throw new Error("turn/start failed");
            if (mode === "complete") {
              for (const callback of listeners.get("item/agentMessage/delta"))
                callback({ threadId: "one", turnId: "turn-1", delta: "OK" });
              for (const callback of listeners.get("turn/completed"))
                callback({
                  threadId: "one",
                  turn: { id: "turn-1", status: "completed" },
                });
            }
            if (mode === "notification-error") {
              for (const callback of listeners.get("error"))
                callback({
                  threadId: "one",
                  turnId: "turn-1",
                  error: { message: "fake turn error" },
                  willRetry: false,
                });
            }
            return { turn: { id: "turn-1" } };
          }
          return {};
        },
      };
      const before = allocated.length;
      const ask = () =>
        askCodexAppServerThread({
          socketPath: "/fake.sock",
          threadId: "one",
          prompt: "ping",
          timeoutMs: 20,
          clientFactory: () => client,
        });
      if (mode === "start-error")
        await assert.rejects(ask, /turn\/start failed/);
      else if (mode === "notification-error")
        await assert.rejects(ask, /fake turn error/);
      else {
        const result = await ask();
        assert.equal(result.timedOut, mode === "timeout");
      }
      assert.equal(client.closed, true);
      assert.equal(
        [...listeners.values()].reduce(
          (total, callbacks) => total + callbacks.size,
          0,
        ),
        0,
      );
      assert.ok(allocated.length > before);
      assert.ok(
        cleared.has(allocated.at(-1)),
        `${mode} left its turn timer armed`,
      );
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("Codex rollout tracks appended token usage", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cx-rollout-"));
  const rolloutPath = path.join(dir, "rollout.jsonl");
  try {
    await fs.writeFile(
      rolloutPath,
      [
        { type: "turn_context", payload: { model: "gpt-6-astra" } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 100 },
              model_context_window: 258_400,
            },
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n"),
    );
    assert.equal(
      (await readCodexContext(rolloutPath)).estimatedContextTokens,
      100,
    );
    await fs.appendFile(
      rolloutPath,
      `\n${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 200 } } } })}\n`,
    );
    const result = await readCodexContext(rolloutPath);
    assert.equal(result.estimatedContextTokens, 200);
    assert.equal(result.executionContextLimitTokens, 258_400);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
