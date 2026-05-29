import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  encodeBridgeConfig,
  parseBridgeConfig,
  runBridge,
} from "../../hub/team/daemon-pty-tmux-bridge.mjs";

test("encodeBridgeConfig and parseBridgeConfig round-trip shell-sensitive config", () => {
  const config = {
    sessionName: "tfx daemon bridge",
    launchCmd: "codex --profile 'gpt55 low'",
    cwd: "/tmp/project with spaces",
    env: { TFX_MODE: "daemon pty", EMPTY: "" },
    cols: 132,
    rows: 43,
  };

  const encoded = encodeBridgeConfig(config);

  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.deepEqual(parseBridgeConfig(["--config", encoded]), config);
});

test("runBridge starts transport, resizes, forwards input, handles resize, and stops once", async () => {
  const calls = [];
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signals = new EventEmitter();
  stdout.columns = 100;
  stdout.rows = 31;
  stdout.write = (chunk) => calls.push(["stdout.write", chunk]);

  const transport = {
    async start() {
      calls.push(["start"]);
    },
    async resize(size) {
      calls.push(["resize", size]);
    },
    async writeInput(chunk) {
      calls.push(["writeInput", chunk]);
    },
    async stop() {
      calls.push(["stop"]);
    },
  };

  const handle = await runBridge({
    config: {
      sessionName: "tfx-test",
      launchCmd: "codex",
      cwd: "/tmp/project",
      env: { TFX: "1" },
      cols: 120,
      rows: 40,
    },
    stdin,
    stdout,
    signals,
    createTransport(options) {
      calls.push(["createTransport", options]);
      options.onData("hello");
      return transport;
    },
  });

  assert.deepEqual(calls.slice(0, 4), [
    [
      "createTransport",
      {
        sessionName: "tfx-test",
        cwd: "/tmp/project",
        launchCmd: "codex",
        env: { TFX: "1" },
        onData: calls[0][1].onData,
      },
    ],
    ["stdout.write", "hello"],
    ["start"],
    ["resize", { cols: 100, rows: 31 }],
  ]);

  const input = Buffer.from("\u001b[A");
  stdin.emit("data", input);
  stdout.columns = 90;
  stdout.rows = 28;
  stdout.emit("resize");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.filter(([name]) => name === "writeInput").length, 1);
  assert.equal(calls.find(([name]) => name === "writeInput")[1], input);
  assert.deepEqual(calls.at(-1), ["resize", { cols: 90, rows: 28 }]);

  await handle.shutdown();
  signals.emit("SIGTERM");
  stdin.emit("end");
  signals.emit("SIGINT");
  signals.emit("uncaughtException", new Error("boom"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.filter(([name]) => name === "stop").length, 1);
});

test("runBridge falls back to config size and then default size", async () => {
  const sizes = [];
  const makeStream = () => {
    const stream = new EventEmitter();
    stream.write = () => {};
    return stream;
  };
  const makeTransport = () => ({
    async start() {},
    async resize(size) {
      sizes.push(size);
    },
    async writeInput() {},
    async stop() {},
  });

  const first = await runBridge({
    config: { sessionName: "one", cols: 88, rows: 22 },
    stdin: makeStream(),
    stdout: makeStream(),
    signals: new EventEmitter(),
    createTransport: makeTransport,
  });
  await first.shutdown();

  const second = await runBridge({
    config: { sessionName: "two" },
    stdin: makeStream(),
    stdout: makeStream(),
    signals: new EventEmitter(),
    createTransport: makeTransport,
  });
  await second.shutdown();

  assert.deepEqual(sizes, [
    { cols: 88, rows: 22 },
    { cols: 120, rows: 40 },
  ]);
});
