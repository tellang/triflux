// tests/unit/tui-remote-adapter.test.mjs — tui-remote-adapter.mjs 유닛 테스트
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { createRemoteAdapter } from "../../hub/team/tui-remote-adapter.mjs";
import { STATES } from "../../hub/team/conductor.mjs";

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `tfx-adapter-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHostsJson(dir, data) {
  const path = join(dir, "hosts.json");
  writeFileSync(path, JSON.stringify(data), "utf8");
  return path;
}

/** conductor mock — getSnapshot + on/off + stateChange emit */
function mockConductor(snapshots = []) {
  const emitter = new EventEmitter();
  let currentSnapshots = snapshots;
  return {
    getSnapshot: () => [...currentSnapshots],
    setSnapshots(next) { currentSnapshots = next; },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emitStateChange(payload) { emitter.emit("stateChange", payload); },
  };
}

/** remote-watcher mock */
function mockWatcher(sessions = {}) {
  const emitter = new EventEmitter();
  let currentStatus = { sessions, running: true };
  return {
    getStatus: () => ({ ...currentStatus, sessions: { ...currentStatus.sessions } }),
    setStatus(next) { currentStatus = next; },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emitCompleted(payload) { emitter.emit("sessionCompleted", payload); },
    emitFailed(payload) { emitter.emit("sessionFailed", payload); },
    emitInputWait(payload) { emitter.emit("sessionInputWait", payload); },
  };
}

/** notifier mock */
function mockNotifier() {
  const calls = [];
  return {
    notify(event) { calls.push({ ...event }); return Promise.resolve(); },
    calls,
  };
}

function defaultHostsData() {
  return {
    hosts: {
      ultra4: {
        ssh_user: "SSAFY",
        tailscale: { ip: "100.110.136.64" },
      },
      m2: {
        ssh_user: "dev",
        tailscale: { ip: "100.0.0.2" },
      },
    },
  };
}

function remoteSnapshot(overrides = {}) {
  return {
    id: "tfx-spawn-ultra4-abc123",
    agent: "codex",
    state: STATES.HEALTHY,
    pid: null,
    remote: true,
    host: "ultra4",
    restarts: 0,
    health: { level: "L1" },
    outPath: null,
    errPath: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ── 테스트 ───────────────────────────────────────────────────────────────────

let tmpDir;
let hostsPath;

beforeEach(() => {
  tmpDir = makeTmpDir();
  hostsPath = writeHostsJson(tmpDir, defaultHostsData());
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1. 생성 + 라이프사이클 ──────────────────────────────────────────────────

describe("tui-remote-adapter: 생성", () => {
  it("conductor 없이 생성하면 에러", () => {
    assert.throws(() => createRemoteAdapter({}), /conductor is required/);
  });

  it("conductor만으로 생성 가능", () => {
    const conductor = mockConductor();
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
    });
    assert.ok(adapter.start);
    assert.ok(adapter.stop);
    assert.ok(adapter.getWorkers);
    assert.ok(adapter.on);
    assert.ok(adapter.off);
  });

  it("start/stop 중복 호출 안전", () => {
    const conductor = mockConductor();
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();
    adapter.start(); // 중복 — noop
    adapter.stop();
    adapter.stop(); // 중복 — noop
  });
});

// ── 2. STATES → TUI status 변환 ────────────────────────────────────────────

describe("tui-remote-adapter: STATES → TUI status 변환", () => {
  const stateMap = [
    [STATES.INIT, "pending"],
    [STATES.STARTING, "pending"],
    [STATES.HEALTHY, "running"],
    [STATES.STALLED, "running"],
    [STATES.INPUT_WAIT, "running"],
    [STATES.FAILED, "running"],
    [STATES.RESTARTING, "running"],
    [STATES.COMPLETED, "completed"],
    [STATES.DEAD, "failed"],
  ];

  for (const [conductorState, expectedStatus] of stateMap) {
    it(`${conductorState} → "${expectedStatus}"`, () => {
      const conductor = mockConductor([
        remoteSnapshot({ state: conductorState }),
      ]);
      const adapter = createRemoteAdapter({
        conductor,
        hostsJsonPath: hostsPath,
        deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
      });
      adapter.start();

      const workers = adapter.getWorkers();
      const paneName = "remote:tfx-spawn-ultra4-abc123";
      assert.ok(workers.has(paneName), `paneName ${paneName} 존재해야 함`);
      assert.equal(workers.get(paneName).status, expectedStatus);
      assert.equal(workers.get(paneName).conductor.state, conductorState);

      adapter.stop();
    });
  }
});

// ── 3. paneName 키 컨벤션 ───────────────────────────────────────────────────

describe("tui-remote-adapter: paneName 컨벤션", () => {
  it("remote:{sessionName} 형식 생성", () => {
    const sessionId = "tfx-spawn-ultra4-def456";
    const conductor = mockConductor([remoteSnapshot({ id: sessionId })]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const workers = adapter.getWorkers();
    assert.ok(workers.has(`remote:${sessionId}`));

    adapter.stop();
  });
});

// ── 4. sshUser 로드 ─────────────────────────────────────────────────────────

describe("tui-remote-adapter: sshUser", () => {
  it("hosts.json에서 ssh_user 로드", () => {
    const conductor = mockConductor([remoteSnapshot({ host: "ultra4" })]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const workers = adapter.getWorkers();
    const worker = workers.get("remote:tfx-spawn-ultra4-abc123");
    assert.equal(worker.sshUser, "SSAFY");

    adapter.stop();
  });

  it("호스트 미등록 시 sshUser=null", () => {
    const conductor = mockConductor([
      remoteSnapshot({ host: "unknown-host" }),
    ]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const worker = adapter.getWorkers().get("remote:tfx-spawn-ultra4-abc123");
    assert.equal(worker.sshUser, null);

    adapter.stop();
  });

  it("hosts.json 파일 없으면 graceful fallback", () => {
    const conductor = mockConductor([remoteSnapshot()]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: join(tmpDir, "nonexistent.json"),
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const worker = adapter.getWorkers().get("remote:tfx-spawn-ultra4-abc123");
    assert.equal(worker.sshUser, null);

    adapter.stop();
  });
});

// ── 5. snapshot (remote-watcher lastOutput) ─────────────────────────────────

describe("tui-remote-adapter: snapshot", () => {
  it("watcher의 lastOutput을 snapshot으로 전달", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const watcher = mockWatcher({
      [sessionId]: {
        sessionName: sessionId,
        lastOutput: "Processing file 3/10...\nDone.",
        state: "watching",
      },
    });
    const conductor = mockConductor([remoteSnapshot({ id: sessionId })]);
    const adapter = createRemoteAdapter({
      conductor,
      watcher,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const worker = adapter.getWorkers().get(`remote:${sessionId}`);
    assert.equal(worker.snapshot, "Processing file 3/10...\nDone.");

    adapter.stop();
  });

  it("watcher 없으면 snapshot 빈 문자열", () => {
    const conductor = mockConductor([remoteSnapshot()]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const worker = adapter.getWorkers().get("remote:tfx-spawn-ultra4-abc123");
    assert.equal(worker.snapshot, "");

    adapter.stop();
  });
});

// ── 6. conductor stateChange → notify 변환 ──────────────────────────────────

describe("tui-remote-adapter: conductor → notify 이벤트 변환", () => {
  it("COMPLETED → notify type:'completed'", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, state: STATES.COMPLETED }),
    ]);
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    conductor.emitStateChange({
      sessionId,
      from: STATES.HEALTHY,
      to: STATES.COMPLETED,
      reason: "exit_0",
    });

    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].type, "completed");
    assert.equal(notifier.calls[0].sessionId, sessionId);
    assert.equal(notifier.calls[0].host, "ultra4");

    adapter.stop();
  });

  it("DEAD → notify type:'failed'", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, state: STATES.DEAD }),
    ]);
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    conductor.emitStateChange({
      sessionId,
      from: STATES.FAILED,
      to: STATES.DEAD,
      reason: "maxRestarts_exceeded",
    });

    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].type, "failed");

    adapter.stop();
  });

  it("INPUT_WAIT → notify type:'inputWait'", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, state: STATES.INPUT_WAIT }),
    ]);
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    conductor.emitStateChange({
      sessionId,
      from: STATES.HEALTHY,
      to: STATES.INPUT_WAIT,
      reason: "input_wait:>",
    });

    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].type, "inputWait");

    adapter.stop();
  });

  it("비-원격 세션의 stateChange는 무시", () => {
    const conductor = mockConductor([
      { id: "local-session", agent: "codex", state: STATES.COMPLETED, remote: false, host: null, restarts: 0, health: null },
    ]);
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    conductor.emitStateChange({
      sessionId: "local-session",
      from: STATES.HEALTHY,
      to: STATES.COMPLETED,
      reason: "exit_0",
    });

    assert.equal(notifier.calls.length, 0);

    adapter.stop();
  });
});

// ── 7. watcher → notify (supplemental, conductor 미등록) ────────────────────

describe("tui-remote-adapter: watcher supplemental 이벤트", () => {
  it("conductor 미등록 세션의 sessionCompleted → notify", () => {
    const conductor = mockConductor([]);  // conductor에 없음
    const watcher = mockWatcher({});
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      watcher,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    watcher.emitCompleted({
      sessionName: "tfx-spawn-ultra4-xyz789",
      exitCode: 0,
      host: "ultra4",
    });

    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].type, "completed");
    assert.equal(notifier.calls[0].sessionId, "tfx-spawn-ultra4-xyz789");

    adapter.stop();
  });

  it("conductor 등록 세션의 watcher 이벤트는 무시 (중복 방지)", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([remoteSnapshot({ id: sessionId })]);
    const watcher = mockWatcher({});
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      watcher,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    watcher.emitCompleted({ sessionName: sessionId, exitCode: 0, host: "ultra4" });

    assert.equal(notifier.calls.length, 0);

    adapter.stop();
  });

  it("watcher sessionFailed → notify type:'failed'", () => {
    const conductor = mockConductor([]);
    const watcher = mockWatcher({});
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      watcher,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    watcher.emitFailed({
      sessionName: "tfx-spawn-m2-fail1",
      reason: "session_missing",
      host: "m2",
    });

    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].type, "failed");

    adapter.stop();
  });

  it("watcher sessionInputWait → notify type:'inputWait'", () => {
    const conductor = mockConductor([]);
    const watcher = mockWatcher({});
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      watcher,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    watcher.emitInputWait({
      sessionName: "tfx-spawn-ultra4-wait1",
      inputWaitPattern: "> ",
      host: "ultra4",
    });

    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].type, "inputWait");

    adapter.stop();
  });
});

// ── 8. workerUpdate 이벤트 emit ─────────────────────────────────────────────

describe("tui-remote-adapter: workerUpdate 이벤트", () => {
  it("stateChange 시 workerUpdate 이벤트 emit", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, state: STATES.HEALTHY }),
    ]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });

    const updates = [];
    adapter.on("workerUpdate", (data) => updates.push(data));
    adapter.start();

    conductor.emitStateChange({
      sessionId,
      from: STATES.STARTING,
      to: STATES.HEALTHY,
      reason: "probe_healthy",
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].paneName, `remote:${sessionId}`);
    assert.equal(updates[0].status, "running");
    assert.equal(updates[0].remote, true);
    assert.equal(updates[0].host, "ultra4");

    adapter.stop();
  });

  it("workerCompleted 이벤트 emit", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, state: STATES.COMPLETED }),
    ]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });

    const completed = [];
    adapter.on("workerCompleted", (data) => completed.push(data));
    adapter.start();

    conductor.emitStateChange({
      sessionId,
      from: STATES.HEALTHY,
      to: STATES.COMPLETED,
      reason: "exit_0",
    });

    assert.equal(completed.length, 1);
    assert.equal(completed[0].name, `remote:${sessionId}`);
    assert.equal(completed[0].host, "ultra4");

    adapter.stop();
  });
});

// ── 9. watcher-only 워커 (conductor 미등록) ─────────────────────────────────

describe("tui-remote-adapter: watcher-only 워커", () => {
  it("conductor에 없는 watcher 세션도 getWorkers에 포함", () => {
    const watcherSessionId = "tfx-spawn-m2-orphan1";
    const conductor = mockConductor([]);
    const watcher = mockWatcher({
      [watcherSessionId]: {
        sessionName: watcherSessionId,
        lastOutput: "orphan output",
        state: "watching",
        host: "m2",
      },
    });
    const adapter = createRemoteAdapter({
      conductor,
      watcher,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const workers = adapter.getWorkers();
    const paneName = `remote:${watcherSessionId}`;
    assert.ok(workers.has(paneName));

    const worker = workers.get(paneName);
    assert.equal(worker.remote, true);
    assert.equal(worker.host, "m2");
    assert.equal(worker.sshUser, "dev");
    assert.equal(worker.snapshot, "orphan output");
    assert.equal(worker.conductor, null);

    adapter.stop();
  });
});

// ── 10. host 추출 ───────────────────────────────────────────────────────────

describe("tui-remote-adapter: host 추출", () => {
  it("sessionName에서 host 파싱 (tfx-spawn-{host}-{id})", () => {
    const sessionId = "tfx-spawn-m2-session99";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, host: null }),
    ]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const worker = adapter.getWorkers().get(`remote:${sessionId}`);
    assert.equal(worker.host, "m2");

    adapter.stop();
  });
});

// ── 11. notify 실패 시 adapter 중단 안 함 ───────────────────────────────────

describe("tui-remote-adapter: notify 실패 허용", () => {
  it("notifier.notify() throw 시 adapter 계속 동작", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, state: STATES.COMPLETED }),
    ]);
    const badNotifier = {
      notify() { throw new Error("toast failed"); },
    };
    const adapter = createRemoteAdapter({
      conductor,
      notifier: badNotifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    // throw 안 해야 함
    assert.doesNotThrow(() => {
      conductor.emitStateChange({
        sessionId,
        from: STATES.HEALTHY,
        to: STATES.COMPLETED,
        reason: "exit_0",
      });
    });

    adapter.stop();
  });
});

// ── 12. stop 후 이벤트 구독 해제 ────────────────────────────────────────────

describe("tui-remote-adapter: stop 후 정리", () => {
  it("stop 후 conductor stateChange 무시", () => {
    const sessionId = "tfx-spawn-ultra4-abc123";
    const conductor = mockConductor([
      remoteSnapshot({ id: sessionId, state: STATES.COMPLETED }),
    ]);
    const notifier = mockNotifier();
    const adapter = createRemoteAdapter({
      conductor,
      notifier,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();
    adapter.stop();

    conductor.emitStateChange({
      sessionId,
      from: STATES.HEALTHY,
      to: STATES.COMPLETED,
      reason: "exit_0",
    });

    assert.equal(notifier.calls.length, 0);
  });
});

// ── 13. 워커 데이터 구조 검증 ───────────────────────────────────────────────

describe("tui-remote-adapter: 워커 데이터 구조", () => {
  it("필수 필드 전체 포함", () => {
    const conductor = mockConductor([remoteSnapshot()]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const worker = adapter.getWorkers().get("remote:tfx-spawn-ultra4-abc123");
    assert.ok(worker);

    // 필수 필드 존재 확인
    assert.equal(typeof worker.cli, "string");
    assert.equal(typeof worker.role, "string");
    assert.equal(typeof worker.status, "string");
    assert.equal(typeof worker.host, "string");
    assert.equal(worker.remote, true);
    assert.equal(typeof worker.sessionName, "string");
    assert.equal(typeof worker.snapshot, "string");
    assert.ok(worker.conductor !== undefined);
    assert.equal(typeof worker.conductor.state, "string");
    assert.equal(typeof worker.conductor.restarts, "number");

    adapter.stop();
  });

  it("워커 데이터는 frozen (immutable)", () => {
    const conductor = mockConductor([remoteSnapshot()]);
    const adapter = createRemoteAdapter({
      conductor,
      hostsJsonPath: hostsPath,
      deps: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    adapter.start();

    const worker = adapter.getWorkers().get("remote:tfx-spawn-ultra4-abc123");
    assert.ok(Object.isFrozen(worker));
    assert.ok(Object.isFrozen(worker.conductor));

    adapter.stop();
  });
});
