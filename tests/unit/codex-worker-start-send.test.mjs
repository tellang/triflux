import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ADAPTERS,
  buildLaunchKeys,
  prepareCodexThread,
} from "../../bin/tfx-live.mjs";
import { queueCodexMessage } from "../../hub/team/codex-queue.mjs";
import { sendCodexPeer } from "../../hub/team/native-peer.mjs";

const threadId = "019a0000-0000-7000-8000-000000000001";

for (const [label, turn] of [
  [
    "failed",
    { id: "turn-1", status: "failed", error: { message: "wake rejected" } },
  ],
  ["interrupted", { id: "turn-1", status: "interrupted" }],
  ["missing", undefined],
  ["empty ID", { id: "", status: "inProgress" }],
]) {
  test(`peer does not report sent for ${label} wake response`, async () => {
    const calls = [];
    const client = {
      request: async (method) => {
        calls.push(method);
        if (method === "thread/loaded/list") return { data: [threadId] };
        if (method === "thread/read")
          return {
            thread: {
              id: threadId,
              threadSource: "user",
              canAcceptDirectInput: true,
            },
          };
        return method === "turn/start" ? { turn } : {};
      },
    };
    const result = await sendCodexPeer({
      client,
      threadId,
      message: "start work",
    });
    assert.equal(result.status, "partial");
    assert.equal(result.retrySafe, false);
    assert.equal(result.modelReceipt, false);
    assert.match(result.error, /wake/);
    assert.equal(calls.filter((m) => m === "thread/inject_items").length, 1);
    assert.equal(calls.filter((m) => m === "turn/start").length, 1);
  });
}

test("queue add reaches the daemon holding the TUI thread without a second app-server", async () => {
  const calls = [];
  let closed = false;
  const result = await queueCodexMessage({
    threadId,
    message: "start work",
    resolveSocket: () => "/isolated/daemon.sock",
    clientFactory: ({ socketPath }) => {
      assert.equal(socketPath, "/isolated/daemon.sock");
      return {
        connect: async () => {},
        notify: () => {},
        close: () => {
          closed = true;
        },
        request: async (method, params) => {
          calls.push([method, params]);
          if (method === "thread/loaded/list") return { data: [threadId] };
          if (method === "thread/queue/add")
            return { queuedSubmission: { id: "q1" } };
          return {};
        },
      };
    },
    spawnFn: () => assert.fail("must not spawn another app-server"),
    execFn: () => assert.fail("must not enqueue the message again"),
  });
  assert.equal(result.queuedMessageId, "q1");
  assert.equal(result.via, "shared-daemon");
  assert.equal(closed, true);
  assert.deepEqual(calls.at(-1)[1].input, [
    { type: "text", text: "start work", text_elements: [] },
  ]);
});

test("shared queue timeout never requeues a possibly accepted message", async () => {
  const calls = [];
  let closed = false;
  await assert.rejects(
    queueCodexMessage({
      threadId,
      message: "one message",
      resolveSocket: () => "/isolated/daemon.sock",
      clientFactory: () => ({
        connect: async () => {},
        notify: () => {},
        close: () => {
          closed = true;
        },
        request: async (method) => {
          calls.push(method);
          if (method === "thread/loaded/list") return { data: [threadId] };
          if (method === "thread/queue/add")
            throw new Error("timeout after write");
          return {};
        },
      }),
      spawnFn: () => assert.fail("must not requeue"),
      execFn: () => assert.fail("must not resend through argv"),
    }),
    (error) => error.maybeQueued === true,
  );
  assert.equal(calls.filter((m) => m === "thread/queue/add").length, 1);
  assert.equal(closed, true);
});

test("shared queue verifies paginated loaded targets before writing", async () => {
  for (const data of [{}, { data: [], nextCursor: "repeat" }]) {
    let closed = false;
    await assert.rejects(
      queueCodexMessage({
        threadId,
        message: "one message",
        resolveSocket: () => "/isolated/daemon.sock",
        clientFactory: () => ({
          connect: async () => {},
          notify: () => {},
          close: () => {
            closed = true;
          },
          request: async (method) => {
            assert.notEqual(method, "thread/queue/add");
            return method === "thread/loaded/list" ? data : {};
          },
        }),
        spawnFn: () => assert.fail("must not change queue target"),
      }),
      /Cannot verify loaded Codex queue/,
    );
    assert.equal(closed, true);
  }
});

test("Codex family aliases resolve the pinned model without changing global files", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "tfx-model-pin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".config", "triflux"), { recursive: true });
  await writeFile(
    join(home, ".config", "triflux", "models.json"),
    JSON.stringify({
      astra: "gpt-6-astra",
      sol: "gpt-6-sol",
      terra: "gpt-6.1-terra",
      luna: "gpt-6-luna",
    }),
  );
  const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
  for (const [model, actual] of Object.entries({
    astra: "gpt-6-astra",
    sol: "gpt-6-sol",
    terra: "gpt-6.1-terra",
    luna: "gpt-6-luna",
  })) {
    assert.ok(
      buildLaunchKeys(ADAPTERS.codex, { model, env })[0].includes(
        `model="${actual}"`,
      ),
    );
    const calls = [];
    const prepared = await prepareCodexThread(
      "/isolated/socket",
      { model, env },
      {
        clientFactory: () => ({
          connect: async () => {},
          notify: () => {},
          close: () => {},
          request: async (method, params) => {
            calls.push([method, params]);
            return { thread: { id: threadId } };
          },
        }),
      },
    );
    prepared.close();
    assert.equal(calls.find(([m]) => m === "thread/start")[1].model, actual);
  }
});

test("loaded resume explains how to change actual TUI permissions and preserves the thread", async () => {
  const calls = [];
  await assert.rejects(
    prepareCodexThread(
      "/isolated/socket",
      {
        resume: threadId,
        launcher: "codex --dangerously-bypass-approvals-and-sandbox",
      },
      {
        clientFactory: () => ({
          connect: async () => {},
          notify: () => {},
          close: () => {},
          request: async (method) => {
            calls.push(method);
            return { data: [threadId] };
          },
        }),
      },
    ),
    (error) => {
      assert.match(error.message, /\/permissions/);
      assert.match(error.message, /Full Access/);
      assert.match(error.message, /thread\/settings\/update/);
      assert.match(error.message, /codex resume/);
      return true;
    },
  );
  assert.deepEqual(calls, ["initialize", "thread/loaded/list"]);
});
