import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { runCodexSessionHook } from "../../hooks/codex-session-hook.mjs";

const tmpDirs = [];

function makeTempStateEnv() {
  const root = mkdtempSync(join(tmpdir(), "tfx-codex-session-hook-"));
  tmpDirs.push(root);
  const stateHome = join(root, "state");
  const leadRolesDir = join(stateHome, "triflux", "lead-roles");
  const cwd = join(root, "work");
  mkdirSync(leadRolesDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    root,
    stateHome,
    leadRolesDir,
    cwd,
    env: {
      HOME: root,
      XDG_STATE_HOME: stateHome,
      TMUX_PANE: "",
    },
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

for (const [mode, hookEvent] of [
  ["register", "session_start"],
  ["heartbeat", "UserPromptSubmit"],
]) {
  it(`${mode}는 로컬 세션 기록만 갱신한다`, async () => {
    const { env, cwd } = makeTempStateEnv();
    const payload = {
      session_id: "codex-1",
      cwd,
      hook_event_name: hookEvent,
    };
    const records = [];
    const result = await runCodexSessionHook(JSON.stringify(payload), {
      argvMode: "",
      env,
      writeStdout: false,
      writeSessionRecord: (record) => records.push(record),
    });
    assert.equal(result, "{}\n");
    assert.deepEqual(records, [payload]);
  });
}

it("알 수 없는 이벤트와 잘못된 JSON은 기록하지 않는다", async () => {
  const { env } = makeTempStateEnv();
  for (const input of ["{invalid", "", '{"hook_event_name":"unknown"}']) {
    assert.equal(
      await runCodexSessionHook(input, {
        argvMode: "",
        env,
        writeStdout: false,
        writeSessionRecord: () => assert.fail("unexpected record"),
      }),
      "{}\n",
    );
  }
});

it("로컬 기록의 출력과 실패가 훅 JSON 응답을 막지 않는다", async () => {
  const { env } = makeTempStateEnv();
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
        env,
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

it("일반 세션의 compact SessionStart는 기본 압축 복구 문맥을 반환한다", async () => {
  const { env, cwd } = makeTempStateEnv();
  const raw = await runCodexSessionHook(
    JSON.stringify({
      session_id: "codex-regular",
      cwd,
      source: "compact",
      hook_event_name: "SessionStart",
    }),
    {
      argvMode: "register",
      env,
      writeStdout: false,
      writeSessionRecord: () => {},
    },
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(
    parsed.hookSpecificOutput.additionalContext,
    "[tfx 압축 스냅샷] 현재 작업 목표와 범위, 결과 파일과 지시서 경로, 남은 일과 다음 단계를 확인하고 이어간다.",
  );
});

it("리드 표지 세션의 compact SessionStart는 threadId를 갱신하고 워커 표와 인계 안내를 반환한다", async () => {
  const { env, leadRolesDir, cwd } = makeTempStateEnv();
  const markerPath = join(leadRolesDir, "lead-session.json");
  writeFileSync(
    markerPath,
    JSON.stringify({
      session: "lead-session",
      paneId: "%10",
      cli: "codex",
      sessionRole: "lead",
      role: "v11 리드",
      name: "11.18 v11 리드",
      cwd,
      threadId: "old-thread",
      pendingHandoff: { path: "/tmp/handoff.md" },
      notifiedThreadId: null,
      notifiedThreshold: 0,
    }),
    "utf8",
  );
  mkdirSync(join(cwd, ".omc", "lead"), { recursive: true });
  writeFileSync(
    join(cwd, ".omc", "lead", "workers.md"),
    [
      "# 등록 워커",
      "| 이름 | 상태 |",
      "| --- | --- |",
      "| vn-codex-hooks | 진행중 |",
    ].join("\n"),
    "utf8",
  );

  const raw = await runCodexSessionHook(
    JSON.stringify({
      session_id: "new-thread",
      cwd,
      source: "compact",
      hook_event_name: "SessionStart",
    }),
    {
      argvMode: "register",
      env: { ...env, TMUX_PANE: "%10" },
      writeStdout: false,
      writeSessionRecord: () => {},
    },
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /v11 리드/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /11\.18 v11 리드/);
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /\| vn-codex-hooks \| 진행중 \|/,
  );
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /\/tmp\/handoff\.md/,
  );

  const updatedMarker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(updatedMarker.threadId, "new-thread");
  assert.equal(updatedMarker.pendingHandoff, null);
});

it("heartbeat는 darwin 리드 표지 세션에서 메모리 압박 단계가 warn/critical로 바뀔 때만 안내한다", async () => {
  const { env, leadRolesDir, cwd } = makeTempStateEnv();
  writeFileSync(
    join(leadRolesDir, "comm-session.json"),
    JSON.stringify({
      session: "comm-session",
      paneId: null,
      cli: "codex",
      sessionRole: "communication",
      role: "소통 창구",
      name: "11.18 소통",
      cwd,
      threadId: "thread-comm",
      pendingHandoff: null,
      notifiedThreadId: null,
      notifiedThreshold: 0,
    }),
    "utf8",
  );

  const payload = JSON.stringify({
    session_id: "thread-comm",
    cwd,
    hook_event_name: "UserPromptSubmit",
  });

  const first = JSON.parse(
    await runCodexSessionHook(payload, {
      argvMode: "heartbeat",
      env,
      platform: "darwin",
      readPressureLevel: () => 2,
      writeStdout: false,
      writeSessionRecord: () => {},
    }),
  );
  assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(
    first.hookSpecificOutput.additionalContext,
    "[tfx-pressure] macOS 메모리 압박 단계가 warn(2)로 바뀌었다. 새 워커 생성을 줄이고 끝난 워커를 닫아라.",
  );

  const duplicate = await runCodexSessionHook(payload, {
    argvMode: "heartbeat",
    env,
    platform: "darwin",
    readPressureLevel: () => 2,
    writeStdout: false,
    writeSessionRecord: () => {},
  });
  assert.equal(duplicate, "{}\n");

  const critical = JSON.parse(
    await runCodexSessionHook(payload, {
      argvMode: "heartbeat",
      env,
      platform: "darwin",
      readPressureLevel: () => 4,
      writeStdout: false,
      writeSessionRecord: () => {},
    }),
  );
  assert.equal(
    critical.hookSpecificOutput.additionalContext,
    "[tfx-pressure] macOS 메모리 압박 단계가 critical(4)로 바뀌었다. 새 워커 생성을 줄이고 끝난 워커를 닫아라.",
  );
});

it("stop 모드는 무한 루프 가드 두 단계와 85% 임계치를 지켜 스레드당 1회만 block을 반환한다", async () => {
  const { env, leadRolesDir, cwd } = makeTempStateEnv();
  const markerPath = join(leadRolesDir, "lead-stop.json");
  writeFileSync(
    markerPath,
    JSON.stringify({
      session: "lead-stop",
      paneId: "%22",
      cli: "codex",
      sessionRole: "lead",
      role: "v11 리드",
      name: "11.18 v11 리드",
      cwd,
      threadId: "thread-1",
      pendingHandoff: null,
      notifiedThreadId: null,
      notifiedThreshold: 0,
    }),
    "utf8",
  );

  // 1차 가드: stop_hook_active 가 참이면 즉시 "{}\n"
  assert.equal(
    await runCodexSessionHook(
      JSON.stringify({
        session_id: "thread-1",
        cwd,
        stop_hook_active: true,
        hook_event_name: "Stop",
      }),
      {
        argvMode: "stop",
        env: { ...env, TMUX_PANE: "%22" },
        readContext: async () => ({ contextPct: 95 }),
        writeStdout: false,
      },
    ),
    "{}\n",
  );

  // 85% 미만이면 통과
  assert.equal(
    await runCodexSessionHook(
      JSON.stringify({
        session_id: "thread-1",
        cwd,
        hook_event_name: "Stop",
      }),
      {
        argvMode: "stop",
        env: { ...env, TMUX_PANE: "%22" },
        readContext: async () => ({ contextPct: 84.9 }),
        writeStdout: false,
      },
    ),
    "{}\n",
  );

  // 85% 이상이면 최초 1회 block 반환 및 표지 갱신
  const blocked = JSON.parse(
    await runCodexSessionHook(
      JSON.stringify({
        session_id: "thread-1",
        cwd,
        hook_event_name: "Stop",
      }),
      {
        argvMode: "stop",
        env: { ...env, TMUX_PANE: "%22" },
        readContext: async () => ({ contextPct: 86 }),
        writeStdout: false,
      },
    ),
  );
  assert.deepEqual(blocked, {
    decision: "block",
    reason:
      "[tfx-lead] 컨텍스트 사용량이 85%에 도달했다. 인계 파일을 저장하고 tfx-live clear 로 새 대화에 승계하라.",
    systemMessage:
      "[tfx-lead] 컨텍스트 사용량이 85%에 도달했다. 인계 파일을 저장하고 tfx-live clear 로 새 대화에 승계하라.",
  });

  const updated = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(updated.notifiedThreadId, "thread-1");
  assert.equal(updated.notifiedThreshold, 85);

  // 2차 가드: 같은 session_id 로 다시 호출되면 "{}\n" 반환
  assert.equal(
    await runCodexSessionHook(
      JSON.stringify({
        session_id: "thread-1",
        cwd,
        hook_event_name: "Stop",
      }),
      {
        argvMode: "stop",
        env: { ...env, TMUX_PANE: "%22" },
        readContext: async () => ({ contextPct: 92 }),
        writeStdout: false,
      },
    ),
    "{}\n",
  );
});

it("표지 조회 우선순위(TMUX_PANE > threadId > 비어 있는 TMUX_PANE + codex cwd)와 역할 필터를 지킨다", async () => {
  const { env, leadRolesDir, cwd } = makeTempStateEnv();
  // worker 역할은 활성 표지로 인정하지 않는다
  writeFileSync(
    join(leadRolesDir, "worker.json"),
    JSON.stringify({
      session: "worker",
      paneId: "%99",
      cli: "codex",
      sessionRole: "worker",
      role: "워커",
      name: "워커",
      cwd,
      threadId: "thread-worker",
    }),
    "utf8",
  );
  assert.equal(
    await runCodexSessionHook(
      JSON.stringify({
        session_id: "thread-worker",
        cwd,
        hook_event_name: "Stop",
      }),
      {
        argvMode: "stop",
        env: { ...env, TMUX_PANE: "%99" },
        readContext: async () => ({ contextPct: 95 }),
        writeStdout: false,
      },
    ),
    "{}\n",
  );

  // TMUX_PANE 이 비어 있을 때 cli === "codex" 이고 cwd 가 같으면 매칭된다
  writeFileSync(
    join(leadRolesDir, "cwd-lead.json"),
    JSON.stringify({
      session: "cwd-lead",
      paneId: "%50",
      cli: "codex",
      sessionRole: "lead",
      role: "cwd 리드",
      name: "11.18 cwd 리드",
      cwd,
      threadId: null,
      notifiedThreadId: null,
    }),
    "utf8",
  );
  // 다른 TMUX_PANE 이 설정돼 있으면 cwd 폴백을 타지 않는다
  assert.equal(
    await runCodexSessionHook(
      JSON.stringify({
        session_id: "unmatched-thread",
        cwd,
        hook_event_name: "Stop",
      }),
      {
        argvMode: "stop",
        env: { ...env, TMUX_PANE: "%77" },
        readContext: async () => ({ contextPct: 95 }),
        writeStdout: false,
      },
    ),
    "{}\n",
  );
  // TMUX_PANE 이 비어 있으면 cwd 폴백으로 매칭된다
  const byCwd = JSON.parse(
    await runCodexSessionHook(
      JSON.stringify({
        session_id: "cwd-thread-1",
        cwd,
        hook_event_name: "Stop",
      }),
      {
        argvMode: "stop",
        env: { ...env, TMUX_PANE: "" },
        readContext: async () => ({ contextPct: 90 }),
        writeStdout: false,
      },
    ),
  );
  assert.equal(byCwd.decision, "block");
});
