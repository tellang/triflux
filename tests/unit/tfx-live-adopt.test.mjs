import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doAdopt } from "../../bin/tfx-live.mjs";

const ROOT = "01a14597-e98f-79c0-ac85-a4d292b30e7a";
const OTHER = "01a145c4-45e5-7ac0-886f-4a24956c88b2";
const CHILD = "01a147ca-5ca7-7803-ba87-993dace1b44e";
const THREADS = [
  { threadId: ROOT, name: "10.17 리드", source: "vscode" },
  { threadId: OTHER, name: "다른 세션", source: "vscode" },
  { threadId: CHILD, name: null, source: { subAgent: {} } },
];

// receivers 는 확인 메시지를 사용자 입력으로 받은 thread 다. 하위 에이전트는 받아도 후보가 아니다.
function harness({
  receivers = [ROOT, CHILD],
  screen = "› ",
  draft = "",
} = {}) {
  const calls = [];
  let typed = null;
  const deps = {
    runTmux: async (_remote, args) => {
      calls.push(args);
      if (args[0] === "display-message") return { stdout: "%7\n" };
      if (args[0] === "send-keys" && args.includes("-l")) typed = args.at(-1);
      return { stdout: "" };
    },
    captureVisible: async () => (typed ? `› ${draft}${typed}` : screen),
    paneCliProcess: async () => ({ pid: 1, running: true }),
    submitComposerLine: async () => {
      calls.push(["submit"]);
      return true;
    },
    sleep: async () => {},
    listThreads: async () => THREADS,
    rolloutHasUserInput: async (id, prefix) =>
      Boolean(typed?.startsWith(prefix)) && receivers.includes(id),
  };
  return { calls, deps };
}

const opts = { session: "hand-codex", timeoutMs: 50, pollIntervalMs: 1 };
const setOptions = (calls) => calls.filter((args) => args[0] === "set-option");

test("adopt types into the pane it resolved and records the thread that received the nonce", async () => {
  const { calls, deps } = harness();
  const result = await doAdopt(opts, deps);
  assert.equal(result.threadId, ROOT);
  for (const args of calls.filter((args) => args[0] === "send-keys"))
    assert.equal(args[args.indexOf("-t") + 1], "%7");
  assert.deepEqual(setOptions(calls), [
    ["set-option", "-p", "-t", "%7", "@tfx_codex_thread", ROOT],
  ]);
});

test("adopt finds a fresh Codex whose thread appears only after the nonce", async () => {
  const { calls, deps } = harness();
  deps.listThreads = async () =>
    calls.some((args) => args[0] === "submit") ? THREADS : [];
  assert.equal((await doAdopt(opts, deps)).threadId, ROOT);
});

test("adopt refuses to guess when several threads hold the nonce", async () => {
  const { calls, deps } = harness({ receivers: [ROOT, OTHER] });
  await assert.rejects(doAdopt(opts, deps), /several threads/);
  assert.deepEqual(setOptions(calls), []);
});

test("adopt fails without recording when no daemon thread received the nonce", async () => {
  const { calls, deps } = harness({ receivers: [CHILD] });
  await assert.rejects(doAdopt(opts, deps), /--no-daemon/);
  assert.deepEqual(setOptions(calls), []);
});

test("adopt removes its own text and never submits a user's draft", async () => {
  const { calls, deps } = harness({ draft: "고치던 초안 " });
  await assert.rejects(doAdopt(opts, deps), /composer was not empty/);
  assert.ok(calls.some((args) => args.at(-1) === "BSpace"));
  assert.equal(
    calls.some((args) => args[0] === "submit"),
    false,
  );
});

test("adopt types nothing while a menu screen is open", async () => {
  const { calls, deps } = harness({
    screen:
      "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit",
  });
  await assert.rejects(doAdopt(opts, deps), /input prompt/);
  assert.equal(
    calls.some((args) => args[0] === "send-keys"),
    false,
  );
});

test("a nonce seen only in another thread's tool output is not proof of input", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-adopt-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const day = path.join(home, "sessions", "2026", "10", "17");
  await fs.mkdir(day, { recursive: true });
  const { deps } = harness();
  delete deps.rolloutHasUserInput;
  const runTmux = deps.runTmux;
  deps.runTmux = async (remote, args) => {
    const result = await runTmux(remote, args);
    if (args[0] === "send-keys" && args.includes("-l")) {
      const text = args.at(-1);
      const write = (id, entry) =>
        fs.writeFile(
          path.join(day, `rollout-2026-10-17T00-00-00-${id}.jsonl`),
          `${JSON.stringify(entry)}\n`,
        );
      await write(OTHER, {
        type: "response_item",
        payload: { type: "function_call_output", output: text },
      });
      await write(ROOT, {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
    }
    return result;
  };
  assert.equal((await doAdopt(opts, deps)).threadId, ROOT);
});
