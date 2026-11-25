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

test("doClear는 데몬 Codex 스레드에서 /new 대신 직전 모델·effort·Full Access를 이어받은 새 스레드로 교체한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-clear-codex-daemon-"));
  try {
    const oldId = "019a0000-0000-7000-8000-000000000011";
    const newId = "019a0000-0000-7000-8000-000000000022";
    const handoff = join(dir, "handoff.md");
    const rollout = join(dir, `rollout-${oldId}.jsonl`);
    await writeFile(handoff, "인계 내용");
    await writeFile(
      rollout,
      `${JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-6.2-astra",
          effort: "xhigh",
          approval_policy: "never",
          sandbox_policy: { type: "danger-full-access" },
          cwd: "/tmp/proj",
        },
      })}\n`,
    );
    const tmuxCalls = [];
    let buffer = "";
    const sent = [];
    const prepareCalls = [];
    const deps = {
      paneCliProcess: async () => ({ running: true }),
      sleep: async () => {},
      capturePane: async () => "",
      captureVisible: async () => "›",
      findCodexRollout: async (id) => (id === oldId ? rollout : null),
      resolveCodexSocket: () => "/tmp/codex.sock",
      prepareCodexThread: async (_socket, opts) => {
        prepareCalls.push(opts);
        return {
          threadId: newId,
          readPermissions: async () => ({
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            permissionsVerified: true,
          }),
          close: () => {},
        };
      },
      dismissStartupScreens: async () => {},
      waitForReady: async () => ({ ready: true, raw: "›" }),
      runTmux: async (_remote, args) => {
        tmuxCalls.push(args);
        if (args[0] === "display-message") {
          return { stdout: `${oldId}\t/tmp/proj\n` };
        }
        if (args[0] === "set-buffer") buffer = args.at(-1);
        if (args[0] === "send-keys" && args.at(-1) === "Enter" && buffer) {
          sent.push(buffer);
          buffer = "";
        }
        return { stdout: "" };
      },
    };
    const result = await doClear(
      {
        cli: "codex",
        session: "fake",
        handoff,
        then: "이어서 작업",
        "if-busy": "wait",
        timeout: "1",
        settle: "1",
        "poll-interval": "1",
      },
      deps,
    );
    assert.equal(prepareCalls.length, 1);
    assert.equal(prepareCalls[0].model, "gpt-6.2-astra");
    assert.equal(prepareCalls[0].effort, "xhigh");
    assert.equal(prepareCalls[0].sandbox, false);
    assert.equal(prepareCalls[0].cwd, "/tmp/proj");
    assert.equal(result.threadId, newId);
    assert.equal(result.previousThreadId, oldId);
    assert.equal(result.clear.command, "thread/start+reattach");
    assert.equal(result.clear.preserved.model, "gpt-6.2-astra");
    assert.equal(result.clear.preserved.effort, "xhigh");
    assert.equal(result.clear.preserved.permissionsVerified, true);
    assert.ok(
      tmuxCalls.some((a) => a[0] === "respawn-pane" && a.includes("-k")),
    );
    assert.ok(
      tmuxCalls.some(
        (a) =>
          a[0] === "set-option" &&
          a.includes("@tfx_codex_thread") &&
          a.includes(newId),
      ),
    );
    assert.ok(
      tmuxCalls.some(
        (a) =>
          a[0] === "send-keys" &&
          a.some(
            (v) =>
              typeof v === "string" &&
              v.includes(`codex resume ${newId}`) &&
              v.includes("--remote unix:///tmp/codex.sock"),
          ),
      ),
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0], /인계 파일 .+ 를 읽고 이어간다\.\n이어서 작업$/);
    assert.equal(result.followUp.inputSent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doClear는 직전 데몬 Codex 스레드가 workspace-write면 새 스레드도 sandbox를 유지한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-clear-codex-sb-"));
  try {
    const oldId = "019a0000-0000-7000-8000-000000000033";
    const newId = "019a0000-0000-7000-8000-000000000044";
    const rollout = join(dir, `rollout-${oldId}.jsonl`);
    await writeFile(
      rollout,
      `${JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-6.2-sol",
          effort: "medium",
          approval_policy: "on-request",
          sandbox_policy: { type: "workspace-write" },
          cwd: "/tmp/proj",
        },
      })}\n`,
    );
    const prepareCalls = [];
    const result = await doClear(
      {
        cli: "codex",
        session: "fake",
        "if-busy": "wait",
        timeout: "1",
        settle: "1",
        "poll-interval": "1",
      },
      {
        paneCliProcess: async () => ({ running: true }),
        sleep: async () => {},
        capturePane: async () => "",
        captureVisible: async () => "›",
        findCodexRollout: async (id) => (id === oldId ? rollout : null),
        resolveCodexSocket: () => "/tmp/codex.sock",
        prepareCodexThread: async (_socket, opts) => {
          prepareCalls.push(opts);
          return {
            threadId: newId,
            readPermissions: async () => ({
              approvalPolicy: "on-request",
              sandbox: { type: "workspaceWrite" },
              permissionsVerified: true,
            }),
            close: () => {},
          };
        },
        dismissStartupScreens: async () => {},
        waitForReady: async () => ({ ready: true, raw: "›" }),
        runTmux: async (_remote, args) =>
          args[0] === "display-message"
            ? { stdout: `${oldId}\t/tmp/proj\n` }
            : { stdout: "" },
      },
    );
    assert.equal(prepareCalls[0].sandbox, true);
    assert.equal(prepareCalls[0].model, "gpt-6.2-sol");
    assert.equal(prepareCalls[0].effort, "medium");
    assert.equal(result.threadId, newId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doClear는 read-only 또는 rollout 미확인 Codex 스레드에서 권한을 넓히지 않고 /new로 폴백한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-clear-codex-ro-"));
  try {
    const roId = "019a0000-0000-7000-8000-000000000055";
    const missingId = "019a0000-0000-7000-8000-000000000066";
    const rollout = join(dir, `rollout-${roId}.jsonl`);
    await writeFile(
      rollout,
      `${JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-6.2-sol",
          effort: "high",
          approval_policy: "on-request",
          sandbox_policy: { type: "read-only" },
          cwd: "/tmp/proj",
        },
      })}\n`,
    );
    for (const [id, findRollout] of [
      [roId, async () => rollout],
      [missingId, async () => null],
    ]) {
      const prepareCalls = [];
      const sent = [];
      const tmuxArgs = [];
      let buffer = "";
      const result = await doClear(
        {
          cli: "codex",
          session: "fake",
          "if-busy": "wait",
          timeout: "1",
          settle: "1",
          "poll-interval": "1",
        },
        {
          paneCliProcess: async () => ({ running: true }),
          sleep: async () => {},
          capturePane: async () => "",
          captureVisible: async () => "›",
          findCodexRollout: findRollout,
          resolveCodexSocket: () => "/tmp/codex.sock",
          prepareCodexThread: async (_socket, opts) => {
            prepareCalls.push(opts);
            return { threadId: "should-not-happen", close: () => {} };
          },
          runTmux: async (_remote, args) => {
            tmuxArgs.push(args);
            if (args[0] === "display-message")
              return { stdout: `${id}\t/tmp/proj\n` };
            if (args[0] === "set-buffer") buffer = args.at(-1);
            if (args[0] === "send-keys" && args.at(-1) === "Enter" && buffer) {
              sent.push(buffer);
              buffer = "";
            }
            return { stdout: "" };
          },
        },
      );
      assert.equal(prepareCalls.length, 0);
      assert.equal(result.clear.command, "/new");
      assert.deepEqual(sent, ["/new"]);
      assert.ok(
        tmuxArgs.some(
          (a) =>
            a[0] === "set-option" &&
            a.includes("-u") &&
            a.includes("@tfx_codex_thread"),
        ),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doClear는 새 스레드 권한 검증에 실패하면 후속 인계 지시를 보내지 않고 중단한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-clear-codex-unverified-"));
  try {
    const oldId = "019a0000-0000-7000-8000-000000000077";
    const newId = "019a0000-0000-7000-8000-000000000088";
    const handoff = join(dir, "handoff.md");
    const rollout = join(dir, `rollout-${oldId}.jsonl`);
    await writeFile(handoff, "인계 내용");
    await writeFile(
      rollout,
      `${JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-6.2-sol",
          effort: "high",
          approval_policy: "on-request",
          sandbox_policy: { type: "workspace-write" },
          cwd: "/tmp/proj",
        },
      })}\n`,
    );
    const sent = [];
    let buffer = "";
    const result = await doClear(
      {
        cli: "codex",
        session: "fake",
        handoff,
        then: "이어서 검증",
        "if-busy": "wait",
        timeout: "1",
        settle: "1",
        "poll-interval": "1",
      },
      {
        paneCliProcess: async () => ({ running: true }),
        sleep: async () => {},
        capturePane: async () => "",
        captureVisible: async () => "›",
        findCodexRollout: async () => rollout,
        resolveCodexSocket: () => "/tmp/codex.sock",
        prepareCodexThread: async () => ({
          threadId: newId,
          readPermissions: async () => ({
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            permissionsVerified: false,
          }),
          close: () => {},
        }),
        dismissStartupScreens: async () => {},
        waitForReady: async () => ({ ready: true, raw: "›" }),
        runTmux: async (_remote, args) => {
          if (args[0] === "display-message")
            return { stdout: `${oldId}\t/tmp/proj\n` };
          if (args[0] === "set-buffer") buffer = args.at(-1);
          if (args[0] === "send-keys" && args.at(-1) === "Enter" && buffer) {
            sent.push(buffer);
            buffer = "";
          }
          return { stdout: "" };
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.followUp.inputSent, false);
    assert.match(result.error, /did not verify preserved permissions/);
    assert.equal(sent.length, 0);

    // handoff와 then이 없어도 권한 검증 실패를 오류로 반환한다.
    const bareResult = await doClear(
      {
        cli: "codex",
        session: "fake",
        "if-busy": "wait",
        timeout: "1",
        settle: "1",
        "poll-interval": "1",
      },
      {
        paneCliProcess: async () => ({ running: true }),
        sleep: async () => {},
        capturePane: async () => "",
        captureVisible: async () => "›",
        findCodexRollout: async () => rollout,
        resolveCodexSocket: () => "/tmp/codex.sock",
        prepareCodexThread: async () => ({
          threadId: newId,
          readPermissions: async () => ({
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            permissionsVerified: false,
          }),
          close: () => {},
        }),
        dismissStartupScreens: async () => {},
        waitForReady: async () => ({ ready: true, raw: "›" }),
        runTmux: async (_remote, args) =>
          args[0] === "display-message"
            ? { stdout: `${oldId}\t/tmp/proj\n` }
            : { stdout: "" },
      },
    );
    assert.equal(bareResult.ok, false);
    assert.match(bareResult.error, /did not verify preserved permissions/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
