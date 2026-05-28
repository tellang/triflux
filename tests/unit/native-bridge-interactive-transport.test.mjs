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

function startupSendKeys(calls, sessionName) {
  return calls
    .filter((call) => call[0] === "send-keys" && call[2] === sessionName)
    .filter((call) => call.at(-1) !== "codex")
    .filter((call) => call[3] !== "codex")
    .map((call) => call.at(-1));
}

function updatePromptScreen(selected = "Update now") {
  const lines = [
    "✨ Update available!",
    "  1. Update now",
    "  2. Skip",
    "  3. Skip until next version",
  ];
  return lines
    .map((line) =>
      line.includes(selected) ? line.replace(/^ {2}/, "› ") : line,
    )
    .join("\n");
}

function trustPromptScreen(selected = "Yes, continue") {
  const lines = [
    "Do you trust the contents of this directory?",
    "  No, quit",
    "  Yes, continue",
  ];
  return lines
    .map((line) =>
      line.includes(selected) ? line.replace(/^ {2}/, "› ") : line,
    )
    .join("\n");
}

function mainPromptScreen() {
  return "Welcome to Codex\n/model to change model\n\n› ";
}

test("start creates a detached tmux session, sends launch command, and streams captured output", async () => {
  const chunks = [];
  const fake = createFakeTmux({ captures: [mainPromptScreen(), "ready\n"] });
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

test("start dismisses update before trust without selecting Update now", async () => {
  const fake = createFakeTmux({
    captures: [
      updatePromptScreen("Update now"),
      updatePromptScreen("Skip"),
      trustPromptScreen("Yes, continue"),
      mainPromptScreen(),
    ],
  });
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-update-trust",
  });

  await transport.start();
  await transport.stop();

  assert.deepEqual(startupSendKeys(fake.calls, "tfx-int-update-trust"), [
    "Down",
    "Enter",
    "Enter",
  ]);
});

test("start retries startup prompt dismissal while the TUI is still rendering", async () => {
  const fake = createFakeTmux({
    captures: [
      "",
      "Codex",
      updatePromptScreen("Update now"),
      updatePromptScreen("Skip"),
      mainPromptScreen(),
    ],
  });
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-delayed-render",
  });

  await transport.start();
  await transport.stop();

  assert.deepEqual(startupSendKeys(fake.calls, "tfx-int-delayed-render"), [
    "Down",
    "Enter",
  ]);
});

test("start exits startup prompt dismissal immediately when already at main prompt", async () => {
  const fake = createFakeTmux({ captures: [mainPromptScreen()] });
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-main",
  });

  await transport.start();
  await transport.stop();

  assert.deepEqual(startupSendKeys(fake.calls, "tfx-int-main"), []);
});

test("start dismisses update-only startup prompt by skipping", async () => {
  const fake = createFakeTmux({
    captures: [
      updatePromptScreen("Update now"),
      updatePromptScreen("Skip until next version"),
      mainPromptScreen(),
    ],
  });
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-update-only",
  });

  await transport.start();
  await transport.stop();

  assert.deepEqual(startupSendKeys(fake.calls, "tfx-int-update-only"), [
    "Down",
    "Enter",
  ]);
});

test("start dismisses trust-only startup prompt by continuing", async () => {
  const fake = createFakeTmux({
    captures: [trustPromptScreen("Yes, continue"), mainPromptScreen()],
  });
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-trust-only",
  });

  await transport.start();
  await transport.stop();

  assert.deepEqual(startupSendKeys(fake.calls, "tfx-int-trust-only"), [
    "Enter",
  ]);
});

test("start leaves startup dismissal alone when no prompt is visible", async () => {
  const fake = createFakeTmux({
    captures: ["shell ready\n", mainPromptScreen()],
  });
  const transport = createInteractiveTuiTransport({
    runTmux: fake.runTmux,
    sessionName: "tfx-int-no-prompt",
  });

  await transport.start();
  await transport.stop();

  assert.deepEqual(startupSendKeys(fake.calls, "tfx-int-no-prompt"), []);
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
