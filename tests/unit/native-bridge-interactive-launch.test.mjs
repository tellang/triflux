import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPtyControlFrame,
  buildPtyDataFrame,
  deriveClaudeDaemonPaths,
  extractPtyFrames,
  startClaudeNativeBridge,
} from "../../hub/team/claude-native-bridge.mjs";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";

function createFakeTransportFactory() {
  const transports = [];
  const createTransport = (options) => {
    const transport = {
      options,
      startCalls: 0,
      stopCalls: 0,
      writeInputValues: [],
      resizeCalls: [],
      async start() {
        this.startCalls += 1;
      },
      async writeInput(value) {
        this.writeInputValues.push(Buffer.from(value));
      },
      async resize(value) {
        this.resizeCalls.push(value);
      },
      async stop() {
        this.stopCalls += 1;
      },
      emit(chunk) {
        options.onData(chunk);
      },
    };
    transports.push(transport);
    return transport;
  };
  return { createTransport, transports };
}

async function connectPty(sockPath) {
  const socket = net.connect(sockPath);
  await once(socket, "connect");
  socket.unref();
  return socket;
}

async function waitForFrame(socket, predicate, { timeoutMs = 1000 } = {}) {
  let buffer = Buffer.alloc(0);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      once(socket, "data").then(([value]) => value),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for frame")),
          remaining,
        ),
      ),
    ]);
    buffer = Buffer.concat([buffer, chunk]);
    const result = extractPtyFrames(buffer);
    buffer = result.rest;
    const match = result.frames.find(predicate);
    if (match) return match;
  }
  throw new Error("timed out waiting for frame");
}

async function waitForCondition(predicate, message, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test("startClaudeNativeBridge interactive workers launch tmux transport from worker cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-native-int-"));
  const configDir = path.join(tmp, "claude");
  const fake = createFakeTransportFactory();
  const bridge = await startClaudeNativeBridge({
    sessionName: "session-interactive",
    assignments: [
      {
        cli: "codex",
        role: "executor",
        prompt: "do work",
        cwd: "/tmp/shard-worktree",
      },
    ],
    configDir,
    workerType: "interactive",
    launchCmd: "codex",
    createTransport: fake.createTransport,
  });
  const paths = deriveClaudeDaemonPaths({ configDir });
  const roster = JSON.parse(await fs.readFile(paths.rosterPath, "utf8"));
  const entry = roster.workers[bridge.workers[0]];
  const transport = fake.transports[0];
  const socket = await connectPty(entry.ptySock);

  try {
    await waitForFrame(
      socket,
      (frame) => frame.kind === 1 && frame.ctrl?.t === "live",
    );
    assert.equal(fake.transports.length, 1);
    assert.equal(transport.startCalls, 1);
    assert.match(
      transport.options.sessionName,
      /^session-interactive-worker-1/u,
    );
    assert.equal(transport.options.cwd, "/tmp/shard-worktree");
    assert.equal(transport.options.launchCmd, "codex");
    assert.deepEqual(entry.dispatch.env, {});
    assert.equal(entry.cwd, "/tmp/shard-worktree");

    socket.write(buildPtyDataFrame("hello\n"));
    await waitForCondition(
      () => transport.writeInputValues.length === 1,
      "timed out waiting for transport input",
    );
    assert.equal(transport.writeInputValues[0].toString("utf8"), "hello\n");

    transport.emit("codex output\n");
    const outputFrame = await waitForFrame(socket, (frame) => frame.kind === 0);
    assert.equal(outputFrame.payload.toString("utf8"), "codex output\n");

    socket.write(buildPtyControlFrame({ t: "resize", cols: 100, rows: 33 }));
    await waitForCondition(
      () => transport.resizeCalls.length === 1,
      "timed out waiting for transport resize",
    );
    assert.deepEqual(transport.resizeCalls, [{ cols: 100, rows: 33 }]);

    socket.write(buildPtyControlFrame({ t: "kill", sig: "SIGTERM" }));
    await waitForCondition(
      () => transport.stopCalls === 1,
      "timed out waiting for transport stop",
    );
  } finally {
    socket.destroy();
    await bridge.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("CLI start parser accepts native bridge interactive attach mode", () => {
  const result = parseTeamArgs([
    "start",
    "--teammate-mode",
    "headless",
    "--native-bridge-mode",
    "interactive-attach",
  ]);

  assert.equal(result.nativeBridge, true);
  assert.equal(result.nativeBridgeMode, "interactive-attach");
});
