import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveClaudeDaemonPaths } from "../../hub/team/claude-daemon-control.mjs";
import {
  askCodexAppServerThread,
  createClaudeUdsEndpoint,
  createCodexAppServerUdsEndpoint,
  createCodexExecEndpoint,
  extractClaudeUdsText,
  listCodexAppServerThreads,
  runUdsOrchestration,
  subscribeClaudeUntilMarker,
} from "../../hub/team/uds-orchestrator.mjs";
import { JsonRpcWsUdsClient } from "../../hub/workers/lib/jsonrpc-ws-uds.mjs";

const FAKE_CODEX_SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-codex-app-server-ws-uds.mjs",
);

async function withFakeCodexServer(env, fn) {
  const dir = await fs.mkdtemp("/tmp/tfx-codex-uds-");
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

function scriptedEndpoint(name, replies) {
  const calls = [];
  return {
    name,
    calls,
    async ask(prompt, meta = {}) {
      calls.push({ prompt, meta });
      return { endpoint: name, text: replies.shift(), done: true };
    },
  };
}

test("codex-led mode asks Codex, then Claude UDS, then Codex final", async () => {
  const codex = scriptedEndpoint("codex", ["CODEX_PLAN", "CODEX_FINAL"]);
  const claude = scriptedEndpoint("claude-uds", ["CLAUDE_REVIEW"]);

  const result = await runUdsOrchestration({
    mode: "codex-led",
    task: "demo task",
    codex,
    claude,
  });

  assert.equal(result.mode, "codex-led");
  assert.equal(result.final.text, "CODEX_FINAL");
  assert.deepEqual(
    result.turns.map((turn) => turn.endpoint),
    ["codex", "claude-uds", "codex"],
  );
  assert.match(codex.calls[0].prompt, /Lead as Codex/);
  assert.match(claude.calls[0].prompt, /Review Codex/);
});

test("claude-led mode asks Claude UDS, then Codex, then Claude final", async () => {
  const codex = scriptedEndpoint("codex", ["CODEX_REVIEW"]);
  const claude = scriptedEndpoint("claude-uds", [
    "CLAUDE_PLAN",
    "CLAUDE_FINAL",
  ]);

  const result = await runUdsOrchestration({
    mode: "claude-led",
    task: "demo task",
    codex,
    claude,
  });

  assert.equal(result.final.text, "CLAUDE_FINAL");
  assert.deepEqual(
    result.turns.map((turn) => turn.endpoint),
    ["claude-uds", "codex", "claude-uds"],
  );
  assert.match(claude.calls[0].prompt, /Lead as Claude/);
  assert.match(codex.calls[0].prompt, /Review Claude/);
});

test("peer mode asks Claude UDS and Codex as peers, then synthesizes", async () => {
  const codex = scriptedEndpoint("codex", ["CODEX_PEER"]);
  const claude = scriptedEndpoint("claude-uds", ["CLAUDE_PEER", "PEER_FINAL"]);

  const result = await runUdsOrchestration({
    mode: "peer",
    task: "demo task",
    codex,
    claude,
  });

  assert.equal(result.final.text, "PEER_FINAL");
  assert.deepEqual(
    result.turns.map((turn) => turn.endpoint),
    ["claude-uds", "codex", "claude-uds"],
  );
  assert.match(claude.calls[1].prompt, /Synthesize peer answers/);
});

async function withFakeClaudeDaemon(handler, fn) {
  const dir = await fs.mkdtemp("/tmp/tfx-uds-");
  const paths = deriveClaudeDaemonPaths({
    configDir: path.join(dir, "claude"),
    tmpRoot: dir,
  });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      while (data.includes("\n")) {
        const index = data.indexOf("\n");
        const line = data.slice(0, index).trim();
        data = data.slice(index + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        handler(request, socket);
      }
    });
  });

  try {
    server.listen(paths.controlSock);
    await once(server, "listening");
    await fn(paths, requests);
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function writeJson(socket, value, { end = false } = {}) {
  const line = `${JSON.stringify(value)}\n`;
  if (end) socket.end(line);
  else socket.write(line);
}

test("Claude UDS marker subscription extends its idle window for stream activity", async () => {
  await withFakeClaudeDaemon(
    (request, socket) => {
      if (request.op !== "subscribe") return;
      setTimeout(
        () => writeJson(socket, { type: "stream", line: "⏺ first\\n" }),
        20,
      );
      setTimeout(
        () => writeJson(socket, { type: "stream", line: "still working\\n" }),
        200,
      );
      setTimeout(
        () => writeJson(socket, { type: "stream", line: "DONE\\n" }),
        380,
      );
    },
    async (paths) => {
      const result = await subscribeClaudeUntilMarker(
        paths.controlSock,
        "active123",
        "DONE",
        { timeoutMs: 300, maxTurnMs: 1000 },
      );
      assert.equal(result.markerSeen, true);
      assert.equal(result.timedOut, undefined);
      assert.ok(
        result.elapsedMs >= 350,
        `expected extension, got ${result.elapsedMs}ms`,
      );
    },
  );
});

test("createClaudeUdsEndpoint dispatches with shared daemon helper, captures marker text, and tears down", async () => {
  await withFakeClaudeDaemon(
    (request, socket) => {
      if (request.op === "dispatch") {
        writeJson(
          socket,
          {
            ok: true,
            op: "dispatch",
            short: request.d.short,
            via: "spare",
            pid: process.pid,
          },
          { end: true },
        );
      } else if (request.op === "list") {
        writeJson(
          socket,
          {
            ok: true,
            jobs: [
              {
                short: "fixed123",
                pid: process.pid,
                sessionId: "fixed123-session",
                bridgeSessionId: "cse_uds_orch",
                startedAt: 1234,
              },
            ],
          },
          { end: true },
        );
      } else if (request.op === "subscribe") {
        writeJson(socket, { type: "snapshot", streamTail: ["boot\n"] });
        writeJson(socket, { type: "stream", line: "⏺ ANSWER_TEXT\n" });
        writeJson(socket, {
          type: "stream",
          line: `${request.marker || ""}\n`,
        });
      } else if (request.op === "kill") {
        writeJson(socket, { ok: true, op: "kill" }, { end: true });
      } else {
        writeJson(socket, { ok: true, op: request.op }, { end: true });
      }
    },
    async (paths, requests) => {
      const endpoint = createClaudeUdsEndpoint({
        daemonPaths: paths,
        markerFactory: () => "DONE_MARKER",
        timeoutMs: 1000,
        shortFactory: () => "fixed123",
        sessionIdFactory: () => "fixed123-session",
      });

      const result = await endpoint.ask("say answer");

      assert.equal(result.done, true);
      assert.equal(result.text, "ANSWER_TEXT");
      assert.equal(result.dispatch?.ok, true);
      assert.ok(requests.find((request) => request.op === "dispatch"));
      assert.ok(requests.find((request) => request.op === "subscribe"));
      assert.ok(requests.find((request) => request.op === "kill"));
      assert.equal(
        requests.find((request) => request.op === "dispatch").d.short,
        "fixed123",
      );
      assert.match(
        requests
          .find((request) => request.op === "dispatch")
          .d.launch.args.join(" "),
        /DONE_MARKER/,
      );
    },
  );
});

test("createClaudeUdsEndpoint throws before subscribe when daemon dispatch is not ok", async () => {
  await withFakeClaudeDaemon(
    (request, socket) => {
      if (request.op === "dispatch") {
        writeJson(socket, { ok: false, op: "dispatch" }, { end: true });
        return;
      }
      writeJson(socket, { ok: true, op: request.op }, { end: true });
    },
    async (paths, requests) => {
      const endpoint = createClaudeUdsEndpoint({
        daemonPaths: paths,
        markerFactory: () => "DONE_MARKER",
        timeoutMs: 1000,
        shortFactory: () => "fail1234",
        sessionIdFactory: () => "fail1234-session",
      });

      await assert.rejects(
        () => endpoint.ask("say answer"),
        /dispatch failed/u,
      );
      assert.deepEqual(
        requests.map((request) => request.op),
        ["dispatch"],
      );
    },
  );
});

test("createClaudeUdsEndpoint ignores echoed marker instructions before completion", async () => {
  await withFakeClaudeDaemon(
    (request, socket) => {
      if (request.op === "dispatch") {
        writeJson(
          socket,
          {
            ok: true,
            op: "dispatch",
            short: request.d.short,
            pid: process.pid,
          },
          { end: true },
        );
      } else if (request.op === "list") {
        writeJson(
          socket,
          {
            ok: true,
            jobs: [
              {
                short: "echo1234",
                pid: process.pid,
                sessionId: "echo1234-session",
                bridgeSessionId: "cse_echo",
                startedAt: 1234,
              },
            ],
          },
          { end: true },
        );
      } else if (request.op === "subscribe") {
        writeJson(socket, {
          type: "snapshot",
          streamTail: [
            "When finished, print this exact completion marker on its own line: DONE_MARKER\n",
          ],
        });
        writeJson(socket, { type: "stream", line: "⏺ ACTUAL_ANSWER\n" });
        writeJson(socket, { type: "stream", line: "DONE_MARKER\n" });
      } else if (request.op === "kill") {
        writeJson(socket, { ok: true, op: "kill" }, { end: true });
      } else {
        writeJson(socket, { ok: true, op: request.op }, { end: true });
      }
    },
    async (paths) => {
      const endpoint = createClaudeUdsEndpoint({
        daemonPaths: paths,
        markerFactory: () => "DONE_MARKER",
        timeoutMs: 1000,
        shortFactory: () => "echo1234",
        sessionIdFactory: () => "echo1234-session",
      });

      const result = await endpoint.ask("say answer");

      assert.equal(result.done, true);
      assert.equal(result.text, "ACTUAL_ANSWER");
    },
  );
});

test("extractClaudeUdsText filters status noise after assistant marker", () => {
  const text = [
    "Claude Code",
    "⏺ FINAL_ANSWER",
    "✳ Crunching tokens",
    "Opus",
    "╭────────╮",
    "DONE_MARKER",
  ].join("\n");

  assert.equal(extractClaudeUdsText(text, "DONE_MARKER"), "FINAL_ANSWER");
});

test("createCodexExecEndpoint normalizes Codex exec success and failure", async () => {
  const success = createCodexExecEndpoint({
    executeCodex: async ({ prompt }) => ({
      ok: true,
      output: `codex:${prompt}`,
    }),
  });
  assert.deepEqual(await success.ask("ping"), {
    endpoint: "codex",
    text: "codex:ping",
    done: true,
  });

  const stdoutFallback = createCodexExecEndpoint({
    executeCodex: async () => ({ ok: true, stdout: "legacy stdout" }),
  });
  assert.equal((await stdoutFallback.ask("ping")).text, "legacy stdout");

  const failure = createCodexExecEndpoint({
    executeCodex: async () => ({ ok: false, stderr: "boom" }),
  });
  await assert.rejects(() => failure.ask("ping"), /Codex exec failed: boom/);
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
      const endpoint = createCodexAppServerUdsEndpoint({
        socketPath,
        spawnServer: false,
      });
      const response = await endpoint.ask("ping");
      assert.equal(response.text, "FINAL ONE\n\nFINAL TWO");
      assert.deepEqual(response.meta.commentary, ["working"]);
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

test("Codex UDS timeout and attach endpoint leave the daemon untouched", async () => {
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
  await withFakeCodexServer({}, async (socketPath) => {
    const endpoint = createCodexAppServerUdsEndpoint({
      socketPath,
      spawnServer: false,
      spawnFn: () => {
        throw new Error("spawned");
      },
    });
    assert.equal((await endpoint.ask("ping")).meta.spawned, false);
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
    if (new Error().stack.includes("runCodexAppServerTurn"))
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
