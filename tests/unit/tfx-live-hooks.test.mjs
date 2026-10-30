import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as live from "../../bin/tfx-live.mjs";

const id = "019a0000-0000-7000-8000-000000000001";
function fakeClient() {
  const calls = [];
  return {
    calls,
    client: {
      connect: async () => {},
      notify: () => {},
      close: () => {
        calls.push(["close"]);
      },
      request: async (method, params) => {
        calls.push([method, params]);
        if (method === "thread/list") return { data: [{ id }] };
        if (method === "thread/loaded/list")
          return { data: [], nextCursor: null };
        return { thread: { id } };
      },
    },
  };
}

test("Codex 시작과 재개 명령에 세션 한정 hooks=false가 있다", () => {
  for (const command of [
    live.ADAPTERS.codex.launchKeys[0],
    live.ADAPTERS.codex.resumeById(id),
    live.ADAPTERS.codex.resumeLast(),
  ])
    assert.match(command, /-c '?features.hooks=false'?/);
});

test("공유 daemon 신규 thread는 훅을 끈 뒤 TUI 연결 대상으로 반환한다", async () => {
  const { calls, client } = fakeClient();
  assert.equal(typeof live.prepareCodexThread, "function");
  const result = await live.prepareCodexThread(
    "/test/socket",
    {
      cwd: "/test/project",
      model: "custom-model",
      effort: "high",
      name: "10.30 lifecycle 테스트",
    },
    { clientFactory: () => client },
  );
  assert.equal(result.threadId, id);
  assert.deepEqual(calls.find(([method]) => method === "thread/start")[1], {
    cwd: "/test/project",
    model: "custom-model",
    config: { "features.hooks": false, model_reasoning_effort: "high" },
  });
  assert.equal(
    calls.some(([method]) => method === "close"),
    false,
  );
  result.close();
  assert.equal(calls.at(-1)[0], "close");
});

test("unloaded remote resume은 hooks 설정만 전달하고 기존 thread 권한을 보존한다", async () => {
  for (const opts of [
    { resume: id },
    { resumeLast: true, cwd: "/test/project" },
  ]) {
    const { calls, client } = fakeClient();
    assert.equal(typeof live.prepareCodexThread, "function");
    const result = await live.prepareCodexThread("/test/socket", opts, {
      clientFactory: () => client,
    });
    assert.equal(result.threadId, id);
    assert.deepEqual(calls.find(([method]) => method === "thread/resume")[1], {
      threadId: id,
      config: { "features.hooks": false },
      excludeTurns: true,
    });
    assert.equal(
      calls.some(([method]) => method === "thread/start"),
      false,
    );
    assert.equal(
      calls.some(([method]) => method === "close"),
      false,
    );
    result.close();
  }
});

test("loaded thread는 explicit resume과 resume-last 모두 설정 요청 전에 중단한다", async () => {
  for (const opts of [{ resume: id }, { resumeLast: true }]) {
    const { calls, client } = fakeClient();
    const request = client.request;
    client.request = async (method, params) => {
      if (method !== "thread/loaded/list") return request(method, params);
      calls.push([method, params]);
      return params.cursor
        ? { data: [id], nextCursor: null }
        : { data: [], nextCursor: "page-2" };
    };
    await assert.rejects(
      live.prepareCodexThread("/test/socket", opts, {
        clientFactory: () => client,
      }),
      /loaded Codex thread.*hooks override.*unsupported/i,
    );
    assert.equal(
      calls.some(([method]) => method === "thread/resume"),
      false,
    );
    assert.equal(
      calls.some(([method]) => method === "thread/start"),
      false,
    );
    assert.equal(calls.at(-1)[0], "close");
  }
});

test("재개 상태를 확인할 수 없으면 unsupported로 중단하고 연결을 닫는다", async () => {
  for (const reply of [
    {},
    { data: [null] },
    { data: [], nextCursor: 12 },
    { data: [], nextCursor: "repeat" },
    new Error("Method not found"),
  ]) {
    const { calls, client } = fakeClient();
    const request = client.request;
    client.request = async (method, params) => {
      if (method !== "thread/loaded/list") return request(method, params);
      calls.push([method, params]);
      if (reply instanceof Error) throw reply;
      return reply;
    };
    await assert.rejects(
      live.prepareCodexThread(
        "/test/socket",
        { resume: id },
        { clientFactory: () => client },
      ),
      /cannot verify.*unloaded.*unsupported/i,
    );
    assert.equal(
      calls.some(([method]) => method === "thread/resume"),
      false,
    );
    assert.equal(calls.at(-1)[0], "close");
  }
});

test("daemon 훅 설정 실패는 숨기지 않고 연결을 닫는다", async () => {
  const { calls, client } = fakeClient();
  const request = client.request;
  client.request = async (method, params) => {
    if (method === "thread/resume") throw new Error("config rejected");
    return request(method, params);
  };
  await assert.rejects(
    live.prepareCodexThread(
      "/test/socket",
      { resume: id },
      {
        clientFactory: () => client,
      },
    ),
    /config rejected/,
  );
  assert.equal(calls.at(-1)[0], "close");
});

test("rollout bootstrap 오류는 composer가 있어도 ready가 아니다", () => {
  const raw =
    "thread/resume failed during TUI bootstrap: no rollout found for thread id test\n› ";
  assert.equal(live.ADAPTERS.codex.isReady(raw), false);
  assert.ok(
    live.ADAPTERS.codex.blockingScreens.some((screen) => screen.isPresent(raw)),
  );
});

test("Resuming session composer는 daemon attach 완료가 아니다", () => {
  assert.equal(
    live.ADAPTERS.codex.isReady(
      "Resuming session…\n› Ask Codex to do anything",
    ),
    false,
  );
});

test("훅 검토 화면은 자동 승인하거나 ready로 처리하지 않는다", () => {
  const raw =
    "Hooks need review\n8 hooks are new or changed.\n› 1. Review hooks";
  assert.equal(live.ADAPTERS.codex.isReady(raw), false);
  assert.ok(
    live.ADAPTERS.codex.blockingScreens.some(
      (screen) => screen.name === "codex-hooks-review" && screen.isPresent(raw),
    ),
  );
});

const hookReview = (selected = 0) =>
  "Hooks need review\n8 hooks are new or changed.\nHooks can run outside the sandbox after you trust them.\n\n" +
  [
    "1. Review hooks",
    "2. Trust all and continue",
    "3. Continue without trusting (hooks won't run)",
  ]
    .map((line, index) => `${selected === index ? "› " : "  "}${line}`)
    .join("\n");

test("공식 훅 거부 메뉴만 시작 처리하고 다른 검토 화면은 차단한다", () => {
  const screen = live.ADAPTERS.codex.startupScreens.find(
    (item) => item.name === "codex-hooks-decline",
  );
  assert.ok(screen);
  for (let selected = 0; selected < 3; selected += 1) {
    const raw = hookReview(selected);
    assert.equal(screen.isPresent(raw), true);
    assert.equal(
      live.ADAPTERS.codex.blockingScreens.some((item) => item.isPresent(raw)),
      false,
    );
  }
  for (const raw of [
    hookReview().replace(
      "Continue without trusting (hooks won't run)",
      "Continue",
    ),
    `${hookReview()}\n› Ask Codex to do anything`,
  ]) {
    assert.equal(screen.isPresent(raw), false);
    assert.ok(
      live.ADAPTERS.codex.blockingScreens.some((item) => item.isPresent(raw)),
    );
  }
});

test("공식 훅 거부는 선택을 확인한 뒤 Enter를 보내고 화면 변경 시 멈춘다", async (t) => {
  const screen = live.ADAPTERS.codex.startupScreens.find(
    (item) => item.name === "codex-hooks-decline",
  );
  assert.ok(screen);
  const root = await mkdtemp(join(tmpdir(), "tfx-hook-decline-"));
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });
  const statePath = join(root, "state.json");
  await writeFile(
    join(root, "tmux"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(path));
const args = process.argv.slice(2);
if (args[0] === 'capture-pane') {
  console.log(state.accepted ? '› Ask Codex to do anything' : state.screens[state.selected]);
} else if (args[0] === 'send-keys') {
  const key = args.at(-1);
  if (key === 'Down') state.selected = (state.selected + 1) % 3;
  else if (key === 'Enter') state.accepted = state.selected === 2 ? 'declined' : 'unsafe';
  state.keys.push(key);
  fs.writeFileSync(path, JSON.stringify(state));
} else process.exit(1);
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${previousPath}`;
  for (const selected of [0, 1, 2]) {
    await writeFile(
      statePath,
      JSON.stringify({
        selected,
        screens: [0, 1, 2].map(hookReview),
        keys: [],
      }),
    );
    assert.equal((await screen.dismiss(null, "owned-smoke")).dismissed, true);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.accepted, "declined");
    assert.deepEqual(state.keys, [
      ...Array(2 - selected).fill("Down"),
      "Enter",
    ]);
  }
  await writeFile(
    statePath,
    JSON.stringify({
      selected: 0,
      screens: [hookReview(), "Hooks need review\n› Trust all and continue"],
      keys: [],
    }),
  );
  assert.equal((await screen.dismiss(null, "owned-smoke")).dismissed, false);
  const changed = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(changed.accepted, undefined);
  assert.deepEqual(changed.keys, ["Down"]);
});
