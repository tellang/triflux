import assert from "node:assert/strict";
import { it } from "node:test";
import { runCodexSessionHook } from "../../hooks/codex-session-hook.mjs";

for (const [mode, hookEvent] of [
  ["register", "session_start"],
  ["heartbeat", "UserPromptSubmit"],
]) {
  it(`${mode}는 로컬 세션 기록만 갱신한다`, async () => {
    const payload = {
      session_id: "codex-1",
      cwd: "/work",
      hook_event_name: hookEvent,
    };
    const records = [];
    const result = await runCodexSessionHook(JSON.stringify(payload), {
      argvMode: "",
      writeStdout: false,
      writeSessionRecord: (record) => records.push(record),
    });
    assert.equal(result, "{}\n");
    assert.deepEqual(records, [payload]);
  });
}

it("알 수 없는 이벤트와 잘못된 JSON은 기록하지 않는다", async () => {
  for (const input of ["{invalid", "", '{"hook_event_name":"unknown"}']) {
    assert.equal(
      await runCodexSessionHook(input, {
        argvMode: "",
        writeStdout: false,
        writeSessionRecord: () => assert.fail("unexpected record"),
      }),
      "{}\n",
    );
  }
});

it("로컬 기록의 출력과 실패가 훅 JSON 응답을 막지 않는다", async () => {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    if (typeof chunk === "string") writes.push(chunk);
    return true;
  };
  try {
    assert.equal(
      await runCodexSessionHook('{"session_id":"codex-1"}', {
        argvMode: "register",
        writeSessionRecord: () => {
          process.stdout.write("noise\n");
          console.log("noise");
          throw new Error("registry unavailable");
        },
      }),
      "{}\n",
    );
    assert.deepEqual(writes, ["{}\n"]);
  } finally {
    process.stdout.write = originalWrite;
  }
});
