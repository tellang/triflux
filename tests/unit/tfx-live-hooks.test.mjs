import assert from "node:assert/strict";
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

test("Codex hook-trust bypass 기본값은 시작·재개·sandbox에 한 번만 붙는다", () => {
  for (const command of [
    ...[{}, { model: "example", effort: "high" }, { sandbox: true }].map(
      (opts) => live.buildLaunchKeys(live.ADAPTERS.codex, opts)[0],
    ),
    live.ADAPTERS.codex.resumeById(id),
    live.ADAPTERS.codex.resumeLast(),
  ]) {
    assert.equal(
      command.split("--dangerously-bypass-hook-trust").length - 1,
      1,
    );
    assert.match(command, /features.hooks=false/);
  }
  for (const cli of ["claude", "agy"]) {
    assert.doesNotMatch(
      live.buildLaunchKeys(live.ADAPTERS[cli])[0],
      /bypass-hook-trust/,
    );
    assert.doesNotMatch(live.ADAPTERS[cli].resumeById(id), /bypass-hook-trust/);
  }
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
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: { "features.hooks": false, model_reasoning_effort: "high" },
  });
  assert.equal(
    calls.some(([method]) => method === "close"),
    false,
  );
  result.close();
  assert.equal(calls.at(-1)[0], "close");
});

test("Codex sandbox thread는 신규와 unloaded 재개 모두 제한한다", async () => {
  for (const resume of [undefined, id]) {
    const { calls, client } = fakeClient();
    const prepared = await live.prepareCodexThread(
      "/test/socket",
      { sandbox: true, resume },
      {
        clientFactory: () => client,
      },
    );
    prepared.close();
    const params = calls.find(
      ([method]) => method === (resume ? "thread/resume" : "thread/start"),
    )[1];
    assert.equal(params.approvalPolicy, "on-request");
    assert.equal(params.sandbox, "workspace-write");
  }
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

for (const sandbox of [
  { type: "dangerFullAccess" },
  { type: "readOnly", networkAccess: false },
  {
    type: "workspaceWrite",
    writableRoots: ["/test/project"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  { type: "externalSandbox", networkAccess: "restricted" },
]) {
  test(`Codex readback preserves response SandboxPolicy type: ${sandbox.type}`, async () => {
    const { calls, client } = fakeClient();
    const request = client.request;
    client.request = async (method, params) => {
      if (method !== "thread/resume") return request(method, params);
      calls.push([method, params]);
      return { thread: { id }, approvalPolicy: "never", sandbox };
    };
    const prepared = await live.prepareCodexThread(
      "/test/socket",
      { resume: id },
      {
        clientFactory: () => client,
      },
    );
    try {
      const permissions = await prepared.readPermissions();
      assert.equal(permissions.permissionsVerified, true);
      assert.deepEqual(permissions.sandbox, sandbox);
      assert.deepEqual(calls.at(-1), [
        "thread/resume",
        { threadId: id, excludeTurns: true },
      ]);
    } finally {
      prepared.close();
    }
  });
}

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

test("모든 훅 검토 메뉴는 시작 처리 없이 같은 차단 사유를 보고한다", () => {
  for (const raw of [
    ...[0, 1, 2].map(hookReview),
    hookReview().replace(
      "Continue without trusting (hooks won't run)",
      "Continue",
    ),
    `${hookReview()}\n› Ask Codex to do anything`,
  ]) {
    assert.equal(live.ADAPTERS.codex.isReady(raw), false);
    const blocking = live.ADAPTERS.codex.blockingScreens.find((screen) =>
      screen.isPresent(raw),
    );
    assert.equal(blocking?.name, "codex-hooks-review");
    assert.match(blocking.warning, /no (?:approval|trust approval) was sent/);
    assert.match(blocking.warning, /attach to the tmux session/);
    assert.equal(
      live.ADAPTERS.codex.startupScreens.some((screen) =>
        screen.isPresent(raw),
      ),
      false,
    );
  }
});
