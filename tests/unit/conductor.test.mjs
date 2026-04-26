// tests/unit/conductor.test.mjs — conductor.mjs 상태 머신 유닛 테스트

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createConductor, STATES } from "../../hub/team/conductor.mjs";
import { createRegistry } from "../../mesh/mesh-registry.mjs";

// 각 테스트가 createConductor를 호출할 때마다 process에 SIGINT/SIGTERM 리스너가
// 추가된다. 테스트 파일 전체 실행 시 11개를 초과해 MaxListenersExceededWarning이
// 발생하므로, 테스트 파일 범위에서만 상한을 높인다.
process.setMaxListeners(50);

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

/** 테스트용 임시 logsDir 생성 */
function makeTmpDir() {
  const dir = join(tmpdir(), `tfx-conductor-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 실제 claude/codex CLI를 호출하지 않는 spawn mock.
 * ~/.claude/projects에 세션 jsonl 쓰레기 생성을 차단한다.
 * 기본: spawn 직후 setImmediate로 즉시 exit(0) — "claude -p echo_test 빠르게 종료"와 동일 타이밍.
 */
function makeMockSpawn({
  exitCode = 0,
  exitSignal = null,
  exitDelayMs = 0,
} = {}) {
  return function mockSpawn() {
    const child = new EventEmitter();
    let exitTimer = null;
    let exited = false;
    child.pid = Math.floor(Math.random() * 1_000_000) + 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const fire = (code, signal) => {
      if (exited) return;
      exited = true;
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = null;
      }
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", code, signal);
      });
    };
    child.kill = () => {
      fire(null, "SIGTERM");
      return true;
    };
    if (exitDelayMs > 0) {
      exitTimer = setTimeout(() => fire(exitCode, exitSignal), exitDelayMs);
    } else {
      fire(exitCode, exitSignal);
    }
    return child;
  };
}

/** 테스트 conductor 팩토리 — grace/probe 값을 짧게 + spawn mock 기본 주입 */
function makeConductor(logsDir, overrides = {}) {
  return createConductor({
    logsDir,
    maxRestarts: 1,
    graceMs: 200, // 200ms grace — 테스트 시간 단축
    probeOpts: {
      intervalMs: 999_999, // probe 자동 발화 억제
      l1ThresholdMs: 999_999,
      l3ThresholdMs: 999_999,
    },
    ...overrides,
    deps: {
      spawn: makeMockSpawn(),
      ...(overrides.deps || {}),
    },
  });
}

/** spawnSession에 사용하는 최소 유효 config (mock spawn이 즉시 exit(0)) */
function minConfig(overrides = {}) {
  return {
    id: `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    agent: "claude",
    prompt: "echo_test",
    ...overrides,
  };
}

/** Promise가 resolve될 때까지 최대 timeoutMs 대기. 초과 시 에러 */
function waitFor(fn, timeoutMs = 3000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        const result = fn();
        if (result) {
          resolve(result);
          return;
        }
      } catch {
        /* 아직 조건 미충족 */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor 타임아웃 (${timeoutMs}ms)`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// ── 테스트 ───────────────────────────────────────────────────────────────────

let logsDir;
let conductor;

beforeEach(() => {
  logsDir = makeTmpDir();
  conductor = makeConductor(logsDir);
});

afterEach(async () => {
  // 각 테스트 후 conductor와 tmpdir 정리
  try {
    await conductor.shutdown("afterEach_cleanup");
  } catch {
    /* 이미 shutdown */
  }
  try {
    rmSync(logsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 1. STATES export 검증 ────────────────────────────────────────────────────

describe("conductor: STATES export", () => {
  it("STATES에 INIT 상태가 존재해야 한다", () => {
    assert.equal(STATES.INIT, "init");
  });

  it("STATES에 STARTING 상태가 존재해야 한다", () => {
    assert.equal(STATES.STARTING, "starting");
  });

  it("STATES에 HEALTHY 상태가 존재해야 한다", () => {
    assert.equal(STATES.HEALTHY, "healthy");
  });

  it("STATES에 STALLED 상태가 존재해야 한다", () => {
    assert.equal(STATES.STALLED, "stalled");
  });

  it("STATES에 INPUT_WAIT 상태가 존재해야 한다", () => {
    assert.equal(STATES.INPUT_WAIT, "input_wait");
  });

  it("STATES에 FAILED 상태가 존재해야 한다", () => {
    assert.equal(STATES.FAILED, "failed");
  });

  it("STATES에 RESTARTING 상태가 존재해야 한다", () => {
    assert.equal(STATES.RESTARTING, "restarting");
  });

  it("STATES에 DEAD 상태가 존재해야 한다", () => {
    assert.equal(STATES.DEAD, "dead");
  });

  it("STATES에 COMPLETED 상태가 존재해야 한다", () => {
    assert.equal(STATES.COMPLETED, "completed");
  });

  it("STATES는 9개 상태를 가져야 한다", () => {
    assert.equal(Object.keys(STATES).length, 9);
  });

  it("STATES는 frozen 객체여야 한다", () => {
    assert.ok(Object.isFrozen(STATES));
  });
});

// ── 2. createConductor 기본 동작 ─────────────────────────────────────────────

describe("conductor: createConductor", () => {
  it("logsDir 없이 생성하면 에러를 던져야 한다", () => {
    assert.throws(() => createConductor({}), /logsDir is required/);
  });

  it("conductor는 공개 API를 노출해야 한다", () => {
    assert.equal(typeof conductor.spawnSession, "function");
    assert.equal(typeof conductor.killSession, "function");
    assert.equal(typeof conductor.sendInput, "function");
    assert.equal(typeof conductor.getSnapshot, "function");
    assert.equal(typeof conductor.getMeshRegistry, "function");
    assert.equal(typeof conductor.shutdown, "function");
    assert.equal(typeof conductor.on, "function");
    assert.equal(typeof conductor.off, "function");
  });

  it("초기 sessionCount는 0이어야 한다", () => {
    assert.equal(conductor.sessionCount, 0);
  });

  it("초기 isShuttingDown은 false여야 한다", () => {
    assert.equal(conductor.isShuttingDown, false);
  });

  it("기본값으로 mesh registry가 자동 연결되어야 한다", () => {
    assert.ok(conductor.getMeshRegistry());
  });

  it("enableMesh가 false면 mesh registry가 비활성화되어야 한다", async () => {
    await conductor.shutdown("disable_mesh_recreate");
    conductor = createConductor({
      logsDir,
      enableMesh: false,
      maxRestarts: 1,
      graceMs: 200,
      probeOpts: {
        intervalMs: 999_999,
        l1ThresholdMs: 999_999,
        l3ThresholdMs: 999_999,
      },
    });

    assert.equal(conductor.getMeshRegistry(), null);
  });

  it("주입된 mesh registry를 그대로 노출해야 한다", async () => {
    const meshRegistry = createRegistry();
    await conductor.shutdown("inject_mesh_registry");
    conductor = createConductor({
      logsDir,
      meshRegistry,
      maxRestarts: 1,
      graceMs: 200,
      probeOpts: {
        intervalMs: 999_999,
        l1ThresholdMs: 999_999,
        l3ThresholdMs: 999_999,
      },
    });

    assert.equal(conductor.getMeshRegistry(), meshRegistry);
  });
});

// ── 3. spawnSession 기본 ─────────────────────────────────────────────────────

describe("conductor: spawnSession", () => {
  it("유효한 config로 세션을 생성하면 session ID를 반환해야 한다", () => {
    const cfg = minConfig();
    const id = conductor.spawnSession(cfg);
    assert.equal(id, cfg.id);
  });

  it("spawnSession 직후 getSnapshot()에 해당 세션이 나타나야 한다", () => {
    const cfg = minConfig();
    conductor.spawnSession(cfg);
    const snapshot = conductor.getSnapshot();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].id, cfg.id);
  });

  it("spawnSession 후 sessionCount가 1 증가해야 한다", () => {
    conductor.spawnSession(minConfig());
    assert.equal(conductor.sessionCount, 1);
  });

  it("두 세션을 spawn하면 sessionCount가 2여야 한다", () => {
    conductor.spawnSession(minConfig({ id: "sess-a" }));
    conductor.spawnSession(minConfig({ id: "sess-b" }));
    assert.equal(conductor.sessionCount, 2);
  });
});

// ── 4. 중복 ID 에러 ──────────────────────────────────────────────────────────

describe("conductor: 중복 ID 에러", () => {
  it("같은 ID로 두 번 spawn하면 에러를 던져야 한다", () => {
    const cfg = minConfig({ id: "dup-id" });
    conductor.spawnSession(cfg);
    assert.throws(() => conductor.spawnSession(cfg), /already exists/);
  });
});

// ── 5. agent 누락 에러 ───────────────────────────────────────────────────────

describe("conductor: agent 누락 에러", () => {
  it("agent 없이 spawnSession하면 에러를 던져야 한다", () => {
    assert.throws(
      () => conductor.spawnSession({ id: "no-agent", prompt: "test" }),
      /agent is required/,
    );
  });

  it("id 없이 spawnSession하면 에러를 던져야 한다", () => {
    assert.throws(
      () => conductor.spawnSession({ agent: "claude", prompt: "test" }),
      /session id is required/,
    );
  });

  it("알 수 없는 agent로 spawnSession하면 에러를 던져야 한다", () => {
    assert.throws(
      () =>
        conductor.spawnSession({
          id: "bad-agent",
          agent: "unknown_cli",
          prompt: "test",
        }),
      /Unknown agent/,
    );
  });
});

// ── 6. getSnapshot 구조 ──────────────────────────────────────────────────────

describe("conductor: getSnapshot 구조", () => {
  it("스냅샷 항목이 id 필드를 포함해야 한다", () => {
    const cfg = minConfig({ id: "snap-test" });
    conductor.spawnSession(cfg);
    const [entry] = conductor.getSnapshot();
    assert.ok("id" in entry, "id 필드 없음");
    assert.equal(entry.id, "snap-test");
  });

  it("스냅샷 항목이 agent 필드를 포함해야 한다", () => {
    conductor.spawnSession(minConfig({ id: "snap-agent", agent: "claude" }));
    const [entry] = conductor.getSnapshot();
    assert.ok("agent" in entry, "agent 필드 없음");
    assert.equal(entry.agent, "claude");
  });

  it("스냅샷 항목이 state 필드를 포함해야 한다", () => {
    conductor.spawnSession(minConfig({ id: "snap-state" }));
    const [entry] = conductor.getSnapshot();
    assert.ok("state" in entry, "state 필드 없음");
    assert.ok(
      Object.values(STATES).includes(entry.state),
      `예상치 못한 state: ${entry.state}`,
    );
  });

  it("스냅샷 항목이 restarts 필드를 포함해야 한다", () => {
    conductor.spawnSession(minConfig({ id: "snap-restarts" }));
    const [entry] = conductor.getSnapshot();
    assert.ok("restarts" in entry, "restarts 필드 없음");
    assert.equal(typeof entry.restarts, "number");
  });

  it("스냅샷 항목이 createdAt 필드를 포함해야 한다", () => {
    conductor.spawnSession(minConfig({ id: "snap-created" }));
    const [entry] = conductor.getSnapshot();
    assert.ok("createdAt" in entry, "createdAt 필드 없음");
    assert.equal(typeof entry.createdAt, "number");
  });

  it("스냅샷 항목이 pid 필드를 포함해야 한다", () => {
    conductor.spawnSession(minConfig({ id: "snap-pid" }));
    const [entry] = conductor.getSnapshot();
    assert.ok("pid" in entry, "pid 필드 없음");
  });

  it("세션이 없으면 getSnapshot()은 빈 배열을 반환해야 한다", () => {
    const snapshot = conductor.getSnapshot();
    assert.ok(Array.isArray(snapshot));
    assert.equal(snapshot.length, 0);
  });
});

// ── 7. killSession ───────────────────────────────────────────────────────────

describe("conductor: killSession", () => {
  it("spawn 후 killSession하면 세션이 DEAD 상태여야 한다", async () => {
    const cfg = minConfig({ id: "kill-test" });
    conductor.spawnSession(cfg);

    await conductor.killSession(cfg.id, "test_kill");

    const [entry] = conductor.getSnapshot();
    assert.equal(entry.state, STATES.DEAD);
  });

  it("존재하지 않는 ID에 killSession해도 에러를 던지지 않아야 한다", async () => {
    await assert.doesNotReject(() => conductor.killSession("nonexistent-id"));
  });

  it("이미 DEAD인 세션에 killSession을 재호출해도 에러를 던지지 않아야 한다", async () => {
    const cfg = minConfig({ id: "double-kill" });
    conductor.spawnSession(cfg);
    await conductor.killSession(cfg.id, "first_kill");
    await assert.doesNotReject(() =>
      conductor.killSession(cfg.id, "second_kill"),
    );
  });
});

// ── 8. shutdown ──────────────────────────────────────────────────────────────

describe("conductor: shutdown", () => {
  it("shutdown 후 isShuttingDown이 true여야 한다", async () => {
    await conductor.shutdown("test_shutdown");
    assert.equal(conductor.isShuttingDown, true);
  });

  it("shutdown을 두 번 호출해도 에러를 던지지 않아야 한다", async () => {
    await conductor.shutdown("first");
    await assert.doesNotReject(() => conductor.shutdown("second"));
  });

  it("shutdown 후 spawnSession을 호출하면 에러를 던져야 한다", async () => {
    await conductor.shutdown("test_shutdown");
    assert.throws(() => conductor.spawnSession(minConfig()), /shutting down/i);
  });

  it("shutdown은 shutdown 이벤트를 emit해야 한다", async () => {
    let fired = false;
    conductor.on("shutdown", () => {
      fired = true;
    });
    await conductor.shutdown("emit_test");
    assert.equal(fired, true);
  });

  it("shutdown 시 mesh bridge가 detach되어 registry를 정리해야 한다", async () => {
    await conductor.shutdown("recreate_slow_child_for_mesh_detach");
    conductor = makeConductor(logsDir, {
      deps: { spawn: makeMockSpawn({ exitDelayMs: 10_000 }) },
    });

    const cfg = minConfig({ id: "shutdown-mesh-session" });
    conductor.spawnSession(cfg);

    await waitFor(() =>
      conductor.getMeshRegistry()?.getAgent(`session:${cfg.id}`),
    );
    await conductor.shutdown("mesh_detach_test");

    assert.equal(
      conductor.getMeshRegistry()?.getAgent(`session:${cfg.id}`),
      null,
    );
  });

  it("shutdown 후 살아있는 세션은 DEAD 상태로 전이해야 한다", async () => {
    await conductor.shutdown("recreate_slow_child_for_alive_shutdown");
    conductor = makeConductor(logsDir, {
      deps: { spawn: makeMockSpawn({ exitDelayMs: 10_000 }) },
    });

    const cfg = minConfig({ id: "shutdown-session" });
    conductor.spawnSession(cfg);
    await waitFor(() => conductor.getSnapshot()[0]?.pid);

    await conductor.shutdown("cleanup_test");

    const [entry] = conductor.getSnapshot();
    assert.equal(entry.state, STATES.DEAD);
  });
});

// ── 9. stateChange 이벤트 ────────────────────────────────────────────────────

describe("conductor: stateChange 이벤트", () => {
  it("spawnSession 시 stateChange 이벤트가 최소 한 번 emit되어야 한다", async () => {
    const events = [];
    conductor.on("stateChange", (e) => events.push(e));

    const cfg = minConfig({ id: "event-test" });
    conductor.spawnSession(cfg);

    // INIT → STARTING 전이가 respawnSession 호출 시 동기적으로 발생
    await waitFor(() => events.length > 0);

    assert.ok(events.length >= 1);
    assert.equal(events[0].sessionId, cfg.id);
    assert.ok("from" in events[0] && "to" in events[0]);
  });

  it("killSession 시 stateChange에 DEAD 전이 이벤트가 포함되어야 한다", async () => {
    const events = [];
    conductor.on("stateChange", (e) => events.push(e));

    const cfg = minConfig({ id: "kill-event-test" });
    conductor.spawnSession(cfg);
    await conductor.killSession(cfg.id, "kill_event_test");

    const deadEvent = events.find((e) => e.to === STATES.DEAD);
    assert.ok(deadEvent, "DEAD 전이 이벤트가 없음");
  });
});

// ── 10. sendInput ────────────────────────────────────────────────────────────

describe("conductor: sendInput", () => {
  it("존재하지 않는 세션에 sendInput하면 false를 반환해야 한다", () => {
    const result = conductor.sendInput("nonexistent", "hello");
    assert.equal(result, false);
  });

  it("살아있는 세션에 sendInput하면 boolean을 반환해야 한다", () => {
    const cfg = minConfig({ id: "stdin-test" });
    conductor.spawnSession(cfg);
    const result = conductor.sendInput(cfg.id, "y");
    assert.equal(typeof result, "boolean");
  });
});

// ── 11. eventLogPath ──────────────────────────────────────────────────────────

describe("conductor: eventLogPath", () => {
  it("eventLogPath는 logsDir 내 .jsonl 파일을 가리켜야 한다", () => {
    const logPath = conductor.eventLogPath;
    assert.ok(typeof logPath === "string");
    assert.ok(
      logPath.endsWith(".jsonl"),
      `예상: .jsonl 확장자, 실제: ${logPath}`,
    );
    assert.ok(logPath.includes("conductor-events"));
  });
});
