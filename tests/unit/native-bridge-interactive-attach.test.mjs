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
  extractPtyFrames,
} from "../../hub/team/claude-native-bridge.mjs";
import { startInteractiveNativeWorker } from "../../hub/team/interactive-native-worker.mjs";
import { createInteractiveTuiTransport } from "../../hub/team/interactive-tui-transport.mjs";

function createFakeTransportFactory() {
  const transports = [];
  const createTransport = (options) => {
    const transport = {
      options,
      startCalls: 0,
      stopCalls: 0,
      writeInputValues: [],
      async start() {
        this.startCalls += 1;
      },
      async writeInput(value) {
        this.writeInputValues.push(Buffer.from(value));
      },
      async resize() {},
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

test("interactive native worker routes attach input to transport and transport output to attach clients", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-native-attach-"));
  const fake = createFakeTransportFactory();
  const worker = await startInteractiveNativeWorker({
    short: "attach01",
    rvSock: path.join(tmp, "worker.rv.sock"),
    ptySock: path.join(tmp, "worker.pty.sock"),
    sessionName: "tfx-attach-test",
    cwd: "/tmp/project",
    launchCmd: "codex",
    env: { CODEX_HOME: "/tmp/codex-home" },
    createTransport: fake.createTransport,
  });

  const transport = fake.transports[0];
  const socket = await connectPty(worker.ptySock);
  try {
    await waitForFrame(
      socket,
      (frame) => frame.kind === 1 && frame.ctrl?.t === "live",
    );
    assert.equal(transport.startCalls, 1);
    assert.equal(transport.options.sessionName, "tfx-attach-test");
    assert.equal(transport.options.cwd, "/tmp/project");
    assert.equal(transport.options.launchCmd, "codex");
    assert.deepEqual(transport.options.env, { CODEX_HOME: "/tmp/codex-home" });

    socket.write(buildPtyDataFrame("hello\n"));
    await waitForCondition(
      () => transport.writeInputValues.length === 1,
      "timed out waiting for transport input",
    );
    assert.deepEqual(
      transport.writeInputValues.map((value) => value.toString("utf8")),
      ["hello\n"],
    );

    transport.emit("codex output\n");
    const outputFrame = await waitForFrame(
      socket,
      (frame) => frame.kind === 0,
    );
    assert.equal(outputFrame.payload.toString("utf8"), "codex output\n");

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      transport.writeInputValues.length,
      1,
      "interactive client input must not be echoed back into transport input",
    );

    socket.write(buildPtyControlFrame({ t: "kill", sig: "SIGTERM" }));
    await waitForCondition(
      () => transport.stopCalls === 1,
      "timed out waiting for transport stop",
    );
    await worker.close();
    assert.equal(transport.stopCalls, 1);
  } finally {
    socket.destroy();
    await worker.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("interactive transport stops polling after repeated capture-pane errors", async () => {
  const calls = [];
  let captureAttempts = 0;
  const transport = createInteractiveTuiTransport({
    sessionName: "tfx-capture-errors",
    pollIntervalMs: 5,
    runTmux: async (args) => {
      calls.push([...args]);
      if (args[0] === "capture-pane" && args.includes("-e")) {
        captureAttempts += 1;
        throw new Error(`capture failed ${captureAttempts}`);
      }
      return { stdout: "" };
    },
  });

  await transport.start();
  await waitForCondition(
    () => captureAttempts >= 3,
    "timed out waiting for capture errors",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await transport.stop();

  assert.equal(captureAttempts, 3);
  assert.equal(
    calls.filter((call) => call[0] === "kill-session").length,
    1,
    "transport remains stoppable after polling gives up",
  );
});
