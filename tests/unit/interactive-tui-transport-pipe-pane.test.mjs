import assert from "node:assert/strict";
import { access, appendFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createInteractiveTuiTransport } from "../../hub/team/interactive-tui-transport.mjs";

function createFakeTmux() {
  const calls = [];
  const runTmux = async (args) => {
    calls.push([...args]);
    if (args[0] === "capture-pane") {
      return { stdout: mainPromptScreen() };
    }
    return { stdout: "" };
  };
  return { calls, runTmux };
}

function mainPromptScreen() {
  return "Welcome to Codex\n/model to change model\n\n> ";
}

function findPipeOn(calls, sessionName) {
  return calls.find(
    (call) =>
      call[0] === "pipe-pane" && call[2] === sessionName && call.includes("-o"),
  );
}

function parsePipeOutputPath(pipeCommand) {
  const match = /^cat >> '((?:'\\''|[^'])*)'$/.exec(pipeCommand);
  assert.ok(match, `unexpected pipe command: ${pipeCommand}`);
  return match[1].replaceAll("'\\''", "'");
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  assert.fail(label);
}

test("start streams tmux pipe-pane bytes to onData in append order", async () => {
  const chunks = [];
  const fake = createFakeTmux();
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-pipe-stream",
    onData: (chunk) => chunks.push(chunk),
    pollIntervalMs: 5,
  });

  await transport.start();
  const pipeOn = findPipeOn(fake.calls, "tfx-int-pipe-stream");
  assert.ok(pipeOn, "pipe-pane should be enabled for ongoing output");
  const outputPath = parsePipeOutputPath(pipeOn.at(-1));

  await appendFile(outputPath, "alpha");
  await waitFor(
    () => chunks.length === 1 && chunks[0] === "alpha",
    "first pipe-pane chunk was not forwarded",
  );

  await appendFile(outputPath, "beta");
  await waitFor(
    () => chunks.length === 2 && chunks[1] === "beta",
    "second pipe-pane chunk was not forwarded",
  );

  await transport.stop();

  assert.deepEqual(chunks, ["alpha", "beta"]);
});

test("stop disables pipe-pane before killing the tmux session and removes the pipe file", async () => {
  const fake = createFakeTmux();
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-pipe-stop",
    pollIntervalMs: 5,
  });

  await transport.start();
  const pipeOn = findPipeOn(fake.calls, "tfx-int-pipe-stop");
  assert.ok(pipeOn, "pipe-pane should be enabled for ongoing output");
  const outputPath = parsePipeOutputPath(pipeOn.at(-1));
  await appendFile(outputPath, "cleanup-target");

  await transport.stop();

  const pipeOffIndex = fake.calls.findIndex((call) =>
    isPipeOffCall(call, "tfx-int-pipe-stop"),
  );
  const killIndex = fake.calls.findIndex(
    (call) => call[0] === "kill-session" && call[2] === "tfx-int-pipe-stop",
  );
  assert.ok(pipeOffIndex >= 0, "pipe-pane should be disabled on stop");
  assert.ok(
    killIndex > pipeOffIndex,
    "pipe-pane should stop before session kill",
  );
  await assert.rejects(() => access(outputPath), /ENOENT/);
});

function isPipeOffCall(call, sessionName) {
  return (
    call.length === 3 &&
    call[0] === "pipe-pane" &&
    call[1] === "-t" &&
    call[2] === sessionName
  );
}
