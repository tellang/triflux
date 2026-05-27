import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createInteractiveTuiTransport } from "../../hub/team/interactive-tui-transport.mjs";

function createFakeTmux({ captures = [] } = {}) {
  const calls = [];
  const queue = [...captures];
  const runTmux = async (args) => {
    calls.push([...args]);
    if (args[0] === "capture-pane") {
      return { stdout: queue.shift() ?? "" };
    }
    return { stdout: "" };
  };
  return { calls, runTmux };
}

function hasCall(calls, expected) {
  return calls.some((call) => {
    try {
      assert.deepEqual(call, expected);
      return true;
    } catch {
      return false;
    }
  });
}

test("start creates a detached tmux session, sends launch command, and streams captured output", async () => {
  const chunks = [];
  const fake = createFakeTmux({ captures: ["", "", "ready\n"] });
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-test",
    cwd: "/tmp/project",
    launchCmd: "codex --profile gpt55_low",
    env: { CODEX_HOME: "/tmp/codex-home" },
    onData: (chunk) => chunks.push(chunk),
    pollIntervalMs: 5,
  });

  await transport.start();
  await sleep(20);
  await transport.stop();

  assert.deepEqual(fake.calls[0], [
    "new-session",
    "-d",
    "-s",
    "tfx-int-test",
    "-c",
    "/tmp/project",
    "-e",
    "CODEX_HOME=/tmp/codex-home",
  ]);
  assert.ok(
    hasCall(fake.calls, [
      "send-keys",
      "-t",
      "tfx-int-test",
      "codex --profile gpt55_low",
      "Enter",
    ]),
  );
  assert.deepEqual(chunks, ["ready\n"]);
});

test("writeInput sends printable text literally and maps control keys to tmux key names", async () => {
  const fake = createFakeTmux();
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-input",
  });

  await transport.writeInput("abc");
  await transport.writeInput("\r");
  await transport.writeInput("\u001b[A");
  await transport.writeInput(Buffer.from([0x03, 0x7f]));

  assert.deepEqual(fake.calls, [
    ["send-keys", "-t", "tfx-int-input", "-l", "--", "abc"],
    ["send-keys", "-t", "tfx-int-input", "Enter"],
    ["send-keys", "-t", "tfx-int-input", "Up"],
    ["send-keys", "-t", "tfx-int-input", "C-c"],
    ["send-keys", "-t", "tfx-int-input", "BSpace"],
  ]);
});

test("resize rejects invalid dimensions and passes positive integers to tmux", async () => {
  const fake = createFakeTmux();
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-resize",
  });

  await assert.rejects(
    () => transport.resize({ cols: 0, rows: 24 }),
    /cols must be a positive integer/,
  );
  await assert.rejects(
    () => transport.resize({ cols: 80, rows: 12.5 }),
    /rows must be a positive integer/,
  );

  await transport.resize({ cols: 120, rows: 40 });

  assert.deepEqual(fake.calls, [
    ["resize-window", "-t", "tfx-int-resize", "-x", "120", "-y", "40"],
  ]);
});

test("stop kills the tmux session once and is idempotent", async () => {
  const fake = createFakeTmux();
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-stop",
  });

  await transport.stop();
  await transport.stop();

  assert.deepEqual(fake.calls, [["kill-session", "-t", "tfx-int-stop"]]);
});
