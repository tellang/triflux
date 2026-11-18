/** biome-ignore-all lint/suspicious/noThenProperty: CLI 계약의 then은 함수가 아닌 지시 문자열이다. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { doClear, stripCodexHooksDisableFlag } from "../../bin/tfx-live.mjs";
import { readLeadMarker, writeLeadMarker } from "../../hub/lib/lead-marker.mjs";

function fixture() {
  const sent = [];
  let buffer = "";
  // 비운 명령을 보내면 화면이 새 대화로 바뀐다.
  let screen = "› old";
  const deps = {
    paneCliProcess: async () => ({ running: true }),
    sleep: async () => {},
    capturePane: async () => "",
    captureVisible: async () => screen,
    runTmux: async (_remote, args) => {
      if (args[0] === "set-buffer") buffer = args.at(-1);
      if (args[0] === "send-keys" && args.at(-1) === "Enter") {
        sent.push(buffer);
        if (sent.length === 1) screen = "›";
      }
      return { stdout: "" };
    },
  };
  const flags = (cli, extra = {}) => ({
    cli,
    session: "fake",
    "if-busy": "wait",
    timeout: "1",
    settle: "1",
    "poll-interval": "1",
    ...extra,
  });
  return { sent, deps, flags };
}

test("CLI 별로 맞는 슬래시 명령을 중계 표식 없이 보낸다", async () => {
  for (const [cli, command] of [
    ["claude", "/clear"],
    ["agy", "/clear"],
    ["codex", "/new"],
  ]) {
    const fake = fixture();
    const result = await doClear(fake.flags(cli), fake.deps);
    assert.deepEqual(fake.sent, [command]);
    assert.equal(result.clear.command, command);
    assert.equal(result.clear.inputSent, true);
    assert.equal(result.followUp, undefined);
  }
});

test("인계 파일과 then 은 비운 뒤 한 메시지로 순서대로 간다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-clear-"));
  try {
    const handoff = join(dir, "handoff.md");
    await writeFile(handoff, "인계");
    const fake = fixture();
    const result = await doClear(
      fake.flags("codex", { handoff, then: "다음 작업" }),
      fake.deps,
    );
    assert.equal(fake.sent.length, 2);
    assert.equal(fake.sent[0], "/new");
    assert.match(
      fake.sent[1],
      new RegExp(
        `^\\[tfx-live req=${result.followUp.requestId}\\]\\n인계 파일 .+ 를 읽고 이어간다\\.\\n다음 작업$`,
      ),
    );
    assert.equal(result.followUp.inputSent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("없는 인계 파일은 아무것도 보내지 않고 거부한다", async () => {
  const fake = fixture();
  await assert.rejects(
    doClear(
      fake.flags("claude", { handoff: "/no/such/handoff.md" }),
      fake.deps,
    ),
    /handoff file not found/,
  );
  assert.deepEqual(fake.sent, []);
});

test("agy 는 대화 ID 가 바뀌기 전에는 뒤따름을 보내지 않고 바뀐 뒤에 보낸다", async () => {
  const fake = fixture();
  fake.deps.paneCliProcess = async () => ({ running: true, pid: 1 });
  fake.deps.captureVisible = async () => "> ";
  // lock 이 바뀌는 사이에는 ID 를 못 읽는다. 그 null 을 전환으로 보면 안 된다.
  const ids = ["old", "old", null, "new"];
  let polls = 0;
  fake.deps.agyConversation = async () => {
    // 첫 호출은 보내기 전 읽기, 이후는 전환 확인 폴링이다.
    if (fake.sent.length === 0) return { conversationId: "old" };
    polls += 1;
    assert.equal(fake.sent.length, 1, "전환 확인 전에 뒤따름이 나갔다");
    return { conversationId: ids[Math.min(polls, ids.length - 1)] };
  };
  const result = await doClear(
    fake.flags("agy", { then: "다음 작업" }),
    fake.deps,
  );
  assert.equal(fake.sent.length, 2);
  // 전환 확인 3회와 뒤따름 전송 때 agy 컨텍스트 조회 1회.
  assert.equal(polls, 4);
  assert.equal(result.followUp.inputSent, true);
});

test("첫 입력 전 agy 는 화면이 그대로여도 대화 ID 가 생기면 뒤따름을 보낸다", async () => {
  const fake = fixture();
  fake.deps.paneCliProcess = async () => ({ running: true, pid: 1 });
  fake.deps.captureVisible = async () => "> ";
  fake.deps.agyConversation = async () =>
    fake.sent.length === 0 ? null : { conversationId: "new" };
  const result = await doClear(
    fake.flags("agy", { then: "다음 작업" }),
    fake.deps,
  );
  assert.equal(fake.sent.length, 2);
  assert.equal(result.followUp.inputSent, true);
});

test("전환이 확인되지 않은 채 상한을 넘기면 뒤따름 없이 실패로 끝난다", async () => {
  const fake = fixture();
  fake.deps.captureVisible = async () => "› old";
  const result = await doClear(
    fake.flags("codex", { then: "다음 작업", "busy-timeout": "0.01" }),
    fake.deps,
  );
  assert.deepEqual(fake.sent, ["/new"]);
  assert.equal(result.ok, false);
  assert.equal(result.followUp.inputSent, false);
  assert.match(result.followUp.error, /new conversation not confirmed/);
});

test("doClear는 followUp 성공 시 알림 상태를 초기화하고 실패 시에만 pendingHandoff를 남긴다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-clear-marker-"));
  try {
    const env = { HOME: dir, XDG_STATE_HOME: join(dir, "state") };
    const handoff = join(dir, "handoff.md");
    await writeFile(handoff, "인계 내용");
    writeLeadMarker(
      {
        session: "fake",
        paneId: "%7",
        cli: "codex",
        sessionRole: "lead",
        role: "코드 리드",
        notifiedThreshold: 85,
        notifiedThreadId: "old-thread",
      },
      { env },
    );
    const fake = fixture();
    fake.deps.env = env;
    const okRes = await doClear(
      fake.flags("codex", { handoff, then: "이어서 검증" }),
      fake.deps,
    );
    assert.equal(okRes.followUp.inputSent, true);
    const afterSuccess = readLeadMarker({ session: "fake" }, { env });
    assert.equal(afterSuccess.notifiedThreshold, 0);
    assert.equal(afterSuccess.notifiedThreadId, null);
    assert.equal(afterSuccess.pendingHandoff, null);

    // 새 대화 전환이 확인되지 않아 followUp 전송에 실패하면 복구용 pendingHandoff를 남긴다.
    const stuck = fixture();
    stuck.deps.env = env;
    stuck.deps.captureVisible = async () => "› old";
    const failRes = await doClear(
      stuck.flags("codex", {
        handoff,
        then: "이어서 검증",
        timeout: "0.01",
      }),
      stuck.deps,
    );
    assert.equal(failRes.ok, false);
    const afterFail = readLeadMarker({ session: "fake" }, { env });
    assert.equal(afterFail.pendingHandoff.path, resolve(handoff));
    assert.equal(afterFail.pendingHandoff.then, "이어서 검증");
    assert.equal(typeof afterFail.pendingHandoff.at, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stripCodexHooksDisableFlag는 리드와 소통 세션용 Codex 실행 명령에서 features.hooks=false만 제거한다", () => {
  assert.equal(
    stripCodexHooksDisableFlag(
      "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -c features.hooks=false",
    ),
    "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust",
  );
  assert.equal(
    stripCodexHooksDisableFlag(
      "codex resume 0199a000-0000-7000-8000-000000000001 --dangerously-bypass-approvals-and-sandbox -c 'features.hooks=false'",
    ),
    "codex resume 0199a000-0000-7000-8000-000000000001 --dangerously-bypass-approvals-and-sandbox",
  );
});
