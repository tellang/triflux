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
  startNativeWorkerFacade,
} from "../../hub/team/claude-native-bridge.mjs";

async function connectPty(sockPath) {
  const socket = net.connect(sockPath);
  await once(socket, "connect");
  socket.unref();
  return socket;
}

async function waitForLive(socket, { timeoutMs = 1000 } = {}) {
  let buffer = Buffer.alloc(0);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      once(socket, "data").then(([value]) => value),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for live")),
          remaining,
        ),
      ),
    ]);
    buffer = Buffer.concat([buffer, chunk]);
    const result = extractPtyFrames(buffer);
    buffer = result.rest;
    if (
      result.frames.some(
        (frame) => frame.kind === 1 && frame.ctrl?.t === "live",
      )
    ) {
      return;
    }
  }
  throw new Error("timed out waiting for live");
}

function collectFrames(socket, frames, initialBuffer = Buffer.alloc(0)) {
  let buffer = Buffer.from(initialBuffer);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const result = extractPtyFrames(buffer);
    buffer = result.rest;
    frames.push(...result.frames);
  };
  socket.on("data", onData);
  return () => socket.off("data", onData);
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

function timeoutError(message, timeoutMs) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message)), timeoutMs),
  );
}

test("interactive worker routes inbound PTY data to onInput without echoing transcript", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-native-frame-"));
  const onInputValues = [];
  let resolveInput;
  const inputSeen = new Promise((resolve) => {
    resolveInput = resolve;
  });
  const facade = await startNativeWorkerFacade({
    short: "iworker",
    rvSock: path.join(tmp, "worker.rv.sock"),
    ptySock: path.join(tmp, "worker.pty.sock"),
    workerType: "interactive",
    onInput(payload) {
      onInputValues.push(Buffer.from(payload));
      resolveInput();
    },
  });

  const socket = await connectPty(facade.ptySock);
  try {
    await waitForLive(socket);
    const echoedFrames = [];
    const stopCollecting = collectFrames(socket, echoedFrames);
    socket.write(buildPtyDataFrame(Buffer.from("abc\n", "utf8")));
    await Promise.race([
      inputSeen,
      timeoutError("timed out waiting for interactive input", 250),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stopCollecting();

    assert.deepEqual(
      onInputValues.map((value) => value.toString("utf8")),
      ["abc\n"],
    );
    assert.equal(
      echoedFrames.some((frame) => frame.kind === 0),
      false,
      "interactive input must not be rebroadcast as transcript output",
    );
  } finally {
    socket.destroy();
    await facade.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("headless worker keeps echoing inbound PTY data to transcript by default", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-native-frame-"));
  const facade = await startNativeWorkerFacade({
    short: "hworker",
    rvSock: path.join(tmp, "worker.rv.sock"),
    ptySock: path.join(tmp, "worker.pty.sock"),
  });

  const socket = await connectPty(facade.ptySock);
  try {
    await waitForLive(socket);
    socket.write(buildPtyDataFrame("headless echo\n"));

    const frame = await waitForFrame(socket, (candidate) => candidate.kind === 0);
    assert.equal(frame.payload.toString("utf8"), "headless echo\n");
  } finally {
    socket.destroy();
    await facade.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("PTY frame codec still round trips data and control frames incrementally", () => {
  const dataFrame = buildPtyDataFrame(Buffer.from([0, 1, 2, 3]));
  const controlFrame = buildPtyControlFrame({
    t: "resize",
    cols: 120,
    rows: 40,
  });
  const combined = Buffer.concat([dataFrame, controlFrame]);

  const partial = extractPtyFrames(combined.subarray(0, combined.length - 2));
  assert.equal(partial.frames.length, 1);
  assert.equal(partial.frames[0].kind, 0);
  assert.deepEqual([...partial.frames[0].payload], [0, 1, 2, 3]);
  assert.equal(partial.rest.length, controlFrame.length - 2);

  const complete = extractPtyFrames(
    Buffer.concat([partial.rest, combined.subarray(combined.length - 2)]),
  );
  assert.deepEqual(complete.frames, [
    { kind: 1, ctrl: { t: "resize", cols: 120, rows: 40 } },
  ]);
  assert.equal(complete.rest.length, 0);
});
