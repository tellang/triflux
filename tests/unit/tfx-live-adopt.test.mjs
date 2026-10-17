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
const FOOTER = "\n\n  GPT-6.1-Sol high · Context 0% used\n  ? for shortcuts";
// codex-cli 0.163.0 의 빈 입력창. 플레이스홀더는 흐린 글씨(SGR 2)다.
const EMPTY = `\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m${FOOTER}`;
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// receivers 는 확인 메시지를 사용자 입력으로 받은 thread 다. 하위 에이전트는 받아도 후보가 아니다.
// render 는 입력한 메시지가 입력창에 어떻게 보이는지 정한다.
function harness({
  receivers = [ROOT, CHILD],
  screen = EMPTY,
  render = (typed) => `› ${typed}${FOOTER}`,
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
    captureEscaped: async () => (typed ? render(typed) : screen),
    captureVisible: async () => strip(typed ? render(typed) : screen),
    paneCliProcess: async () => ({ pid: 1, running: true }),
    submitComposerLine: async () => {
      calls.push(["submit"]);
      return true;
    },
    sleep: async () => {},
    listThreads: async () => THREADS,
    rolloutHasUserInput: async (id, _prefix, message) =>
      typed === message && receivers.includes(id),
  };
  return { calls, deps };
}

const opts = { session: "hand-codex", timeoutMs: 50, pollIntervalMs: 1 };
const setOptions = (calls) => calls.filter((args) => args[0] === "set-option");
const sentKeys = (calls) => calls.some((args) => args[0] === "send-keys");
const submitted = (calls) => calls.some((args) => args[0] === "submit");

test("adopt types into the pane it resolved and records the thread that received the nonce", async () => {
  const { calls, deps } = harness();
  assert.equal((await doAdopt(opts, deps)).threadId, ROOT);
  for (const args of calls.filter((args) => args[0] === "send-keys"))
    assert.equal(args[args.indexOf("-t") + 1], "%7");
  assert.deepEqual(setOptions(calls), [
    ["set-option", "-p", "-t", "%7", "@tfx_codex_thread", ROOT],
  ]);
});

test("adopt accepts its message when a narrow pane wraps it", async () => {
  const { deps } = harness({
    render: (typed) =>
      `› ${typed.slice(0, 20)}\n  ${typed.slice(20, 60)}\n  ${typed.slice(60)}${FOOTER}`,
  });
  assert.equal((await doAdopt(opts, deps)).threadId, ROOT);
});

test("adopt finds a fresh Codex whose thread appears only after the nonce", async () => {
  const { calls, deps } = harness();
  deps.listThreads = async () => (submitted(calls) ? THREADS : []);
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

for (const [label, screen] of [
  ["a draft, even with the cursor at its start", `› 고치던 초안${FOOTER}`],
  [
    "the model menu",
    "› 1. GPT-6.1-Sol (current)  Latest workhorse model\n  2. GPT-6-Astra            Frontier intelligence\n  enter select · esc back",
  ],
  [
    "the trust menu",
    "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit",
  ],
])
  test(`adopt sends no key while the pane shows ${label}`, async () => {
    const { calls, deps } = harness({ screen });
    await assert.rejects(doAdopt(opts, deps), /empty input prompt/);
    assert.equal(sentKeys(calls), false);
  });

test("adopt removes its own text and submits nothing when the composer changes while typing", async () => {
  const { calls, deps } = harness({
    render: (typed) => `› 끼어든 입력 ${typed}${FOOTER}`,
  });
  await assert.rejects(doAdopt(opts, deps), /changed while typing/);
  assert.ok(calls.some((args) => args.at(-1) === "BSpace"));
  assert.equal(submitted(calls), false);
});

test("only the exact message as a user input proves the thread, not tool output", async (t) => {
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
      const user = (body) => ({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: body }],
        },
      });
      await write(OTHER, {
        type: "response_item",
        payload: { type: "function_call_output", output: text },
      });
      // 초안과 함께 제출된 입력은 확인 메시지 그대로가 아니다.
      await write(CHILD, user(`초안 ${text}`));
      await write(ROOT, user(text));
    }
    return result;
  };
  deps.listThreads = async () =>
    THREADS.map((thread) => ({ ...thread, source: "vscode" }));
  assert.equal((await doAdopt(opts, deps)).threadId, ROOT);
});
