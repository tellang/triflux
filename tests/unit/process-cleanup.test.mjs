// tests/unit/process-cleanup.test.mjs — process-cleanup.mjs 유닛 테스트
// mock Get-CimInstance 출력을 사용해 실제 프로세스를 kill하지 않는다.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createProcessCleanup,
  findOrphanProcesses,
} from "../../hub/team/process-cleanup.mjs";

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

/**
 * Get-CimInstance Win32_Process ConvertTo-Json 출력을 흉내내는 mock execFileFn
 * procs 배열을 JSON 직렬화하여 stdout으로 반환한다.
 *
 * @param {Array<{ProcessId,Name,ParentProcessId,CommandLine,WorkingSetSize}>} procs
 * @param {object} [sessionPids] - session→pids 맵 (psmux list-panes mock)
 */
function makeMockExecFile(procs, sessionPids = {}) {
  return async (_cmd, args, _opts) => {
    const cmdStr = Array.isArray(args) ? args.join(" ") : String(args);

    // Get-CimInstance Win32_Process 쿼리
    if (cmdStr.includes("Win32_Process") && cmdStr.includes("ConvertTo-Json")) {
      return { stdout: JSON.stringify(procs), stderr: "" };
    }

    // Get-CimInstance CreationDate 쿼리 (age)
    if (cmdStr.includes("Win32_Process") && cmdStr.includes("CreationDate")) {
      return {
        stdout: new Date(Date.now() - 60_000).toISOString(),
        stderr: "",
      };
    }

    // psmux list-sessions
    if (cmdStr.includes("list-sessions")) {
      const sessions = Object.keys(sessionPids);
      return { stdout: sessions.join("\n"), stderr: "" };
    }

    // psmux list-panes -t <session>
    if (cmdStr.includes("list-panes")) {
      const sessionArg = args[args.indexOf("-t") + 1] || "";
      const pids = sessionPids[sessionArg] || [];
      return { stdout: pids.join("\n"), stderr: "" };
    }

    return { stdout: "", stderr: "" };
  };
}

/** CIM プロセス レコード 생성 헬퍼 */
function cimProc(overrides) {
  return {
    ProcessId: 1000,
    Name: "node.exe",
    ParentProcessId: 9999, // 존재하지 않는 부모 → 고아 후보
    CommandLine: "node script.mjs",
    WorkingSetSize: 50 * 1024 * 1024, // 50 MB
    ...overrides,
  };
}

// ── A. findOrphanProcesses — 기본 고아 감지 ──────────────────────────────────

describe("findOrphanProcesses — 기본 고아 감지", () => {
  it("부모가 없는 node 프로세스를 고아로 감지한다", async () => {
    const procs = [cimProc({ ProcessId: 100, ParentProcessId: 9999 })];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].pid, 100);
    assert.equal(result[0].name, "node");
    assert.equal(result[0].ramMB, 50);
  });

  it("부모가 살아있는 node 프로세스는 고아로 분류하지 않는다", async () => {
    const procs = [
      cimProc({ ProcessId: 200, ParentProcessId: 300 }),
      cimProc({
        ProcessId: 300,
        ParentProcessId: 1,
        Name: "pwsh.exe",
        CommandLine: "pwsh",
      }),
    ];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    // 300은 target name이 아니고, 200의 부모(300)는 살아있음 → 0
    assert.equal(result.length, 0);
  });

  it("빈 프로세스 목록이면 빈 배열을 반환한다", async () => {
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile([]),
      skipPsmuxCheck: true,
    });
    assert.deepEqual(result, []);
  });

  it("execFileFn 실패 시 빈 배열을 반환한다 (에러 전파 없음)", async () => {
    const failExec = async () => {
      throw new Error("pwsh not found");
    };
    const result = await findOrphanProcesses({
      execFileFn: failExec,
      skipPsmuxCheck: true,
    });
    assert.deepEqual(result, []);
  });

  it("반환된 각 항목이 필수 필드를 포함한다", async () => {
    const procs = [cimProc({ ProcessId: 500, ParentProcessId: 8888 })];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    assert.equal(result.length, 1);
    const [p] = result;
    assert.ok("pid" in p, "pid 필드 누락");
    assert.ok("name" in p, "name 필드 누락");
    assert.ok("ramMB" in p, "ramMB 필드 누락");
    assert.ok("parentPid" in p, "parentPid 필드 누락");
    assert.ok("cmdLine" in p, "cmdLine 필드 누락");
    assert.ok("age" in p, "age 필드 누락");
  });
});

// ── B. 화이트리스트 로직 ──────────────────────────────────────────────────────

describe("findOrphanProcesses — 화이트리스트", () => {
  it("프로세스명 claude는 화이트리스트 처리한다", async () => {
    const procs = [
      cimProc({
        ProcessId: 600,
        Name: "claude.exe",
        CommandLine: "claude --dangerously-skip-permissions",
      }),
    ];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    assert.equal(result.length, 0, "claude는 고아 후보에 포함되면 안 된다");
  });

  it("cmdLine에 oh-my-claudecode 포함 시 화이트리스트 처리한다", async () => {
    const procs = [
      cimProc({
        ProcessId: 700,
        CommandLine: "node oh-my-claudecode/bridge.mjs",
      }),
    ];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    assert.equal(result.length, 0, "OMC bridge는 고아 후보에 포함되면 안 된다");
  });

  it("cmdLine에 triflux/hub/s 포함 시 화이트리스트 처리한다", async () => {
    const procs = [
      cimProc({
        ProcessId: 800,
        CommandLine: "node C:/path/triflux/hub/server.mjs",
      }),
    ];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    assert.equal(result.length, 0, "hub server는 고아 후보에 포함되면 안 된다");
  });

  it("CCXProcess 자식은 화이트리스트 처리한다 (Adobe Creative Cloud)", async () => {
    const procs = [
      // CCXProcess 자체 (대상 프로세스명이 아니므로 필터 통과 전에 제외되지만
      // pid는 ccxParentPids에 들어간다)
      {
        ProcessId: 900,
        Name: "CCXProcess.exe",
        ParentProcessId: 1,
        CommandLine: "CCXProcess.exe",
        WorkingSetSize: 0,
      },
      // CCXProcess의 자식 node 프로세스
      cimProc({
        ProcessId: 901,
        ParentProcessId: 900,
        CommandLine: "node /adobe/helper.js",
      }),
    ];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    assert.equal(
      result.length,
      0,
      "Adobe CC 자식 node는 고아 후보에 포함되면 안 된다",
    );
  });

  it("화이트리스트에 해당하지 않는 고아는 정상 감지한다", async () => {
    const procs = [
      cimProc({
        ProcessId: 999,
        CommandLine: "node /tmp/random-orphan.mjs",
        ParentProcessId: 77777,
      }),
    ];
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].pid, 999);
  });
});

// ── C. psmux 교차검증 ─────────────────────────────────────────────────────────

describe("findOrphanProcesses — psmux 교차검증", () => {
  it("활성 psmux 세션 소속 PID는 고아 목록에서 제외한다", async () => {
    const procs = [cimProc({ ProcessId: 1100, ParentProcessId: 9999 })];
    // psmux session "my-session"의 pane pid = 1100
    const sessionPids = { "my-session": [1100] };
    const result = await findOrphanProcesses({
      execFileFn: makeMockExecFile(procs, sessionPids),
      skipPsmuxCheck: false,
    });
    assert.equal(result.length, 0, "psmux 활성 PID는 고아로 분류하면 안 된다");
  });

  it("psmux 미설치 시 에러 없이 빈 교차검증 결과(= 모두 후보 유지)로 동작한다", async () => {
    const procs = [cimProc({ ProcessId: 1200, ParentProcessId: 9999 })];
    const mockExec = async (_cmd, args, _opts) => {
      const cmdStr = Array.isArray(args) ? args.join(" ") : String(args);
      if (
        cmdStr.includes("Win32_Process") &&
        cmdStr.includes("ConvertTo-Json")
      ) {
        return { stdout: JSON.stringify(procs), stderr: "" };
      }
      if (cmdStr.includes("Win32_Process") && cmdStr.includes("CreationDate")) {
        return {
          stdout: new Date(Date.now() - 30_000).toISOString(),
          stderr: "",
        };
      }
      // psmux 관련 모두 실패
      throw new Error("psmux: command not found");
    };

    const result = await findOrphanProcesses({
      execFileFn: mockExec,
      skipPsmuxCheck: false,
    });
    // psmux 실패해도 고아 감지는 정상 동작
    assert.equal(result.length, 1);
    assert.equal(result[0].pid, 1200);
  });
});

// ── D. createProcessCleanup — 인터페이스 ──────────────────────────────────────

describe("createProcessCleanup — scan/kill/getOrphans", () => {
  it("scan()이 고아 목록을 반환하고 getOrphans()로 재조회 가능하다", async () => {
    const procs = [cimProc({ ProcessId: 2000, ParentProcessId: 9999 })];
    const cleanup = createProcessCleanup({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
    });
    const found = await cleanup.scan();
    assert.equal(found.length, 1);
    assert.equal(found[0].pid, 2000);

    const cached = cleanup.getOrphans();
    assert.deepEqual(cached, found);
  });

  it("dryRun=true이면 kill()이 실제 프로세스를 종료하지 않고 목록만 반환한다", async () => {
    const procs = [cimProc({ ProcessId: 2100, ParentProcessId: 9999 })];
    const cleanup = createProcessCleanup({
      execFileFn: makeMockExecFile(procs),
      skipPsmuxCheck: true,
      dryRun: true,
    });
    await cleanup.scan();
    const result = await cleanup.kill();

    assert.equal(result.length, 1);
    assert.equal(result[0].pid, 2100);
    assert.equal(result[0].killed, false);
    assert.equal(result[0].dryRun, true);
  });

  it("scan() 전 kill()은 빈 배열을 반환한다", async () => {
    const cleanup = createProcessCleanup({
      execFileFn: makeMockExecFile([]),
      skipPsmuxCheck: true,
      dryRun: true,
    });
    const result = await cleanup.kill();
    assert.deepEqual(result, []);
  });

  it("scan() 전 getOrphans()는 빈 배열을 반환한다", () => {
    const cleanup = createProcessCleanup({
      execFileFn: makeMockExecFile([]),
      skipPsmuxCheck: true,
    });
    assert.deepEqual(cleanup.getOrphans(), []);
  });
});
