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
    },
    { clientFactory: () => client },
  );
  assert.equal(result, id);
  assert.deepEqual(calls.find(([method]) => method === "thread/start")[1], {
    cwd: "/test/project",
    model: "custom-model",
    config: { "features.hooks": false, model_reasoning_effort: "high" },
  });
  assert.equal(calls.at(-1)[0], "close");
});

test("remote resume은 hooks 설정만 전달하고 기존 thread 권한을 보존한다", async () => {
  for (const opts of [
    { resume: id },
    { resumeLast: true, cwd: "/test/project" },
  ]) {
    const { calls, client } = fakeClient();
    assert.equal(typeof live.prepareCodexThread, "function");
    const result = await live.prepareCodexThread("/test/socket", opts, {
      clientFactory: () => client,
    });
    assert.equal(result, id);
    assert.deepEqual(calls.find(([method]) => method === "thread/resume")[1], {
      threadId: id,
      config: { "features.hooks": false },
      excludeTurns: true,
    });
    assert.equal(
      calls.some(([method]) => method === "thread/start"),
      false,
    );
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
