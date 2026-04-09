import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createWtManager } from "../../hub/team/wt-manager.mjs";

const tempDirs = [];

function createTempPidDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-wt-manager-"));
  tempDirs.push(dir);
  return dir;
}

function extractWrappedCommand(args) {
  const encIdx = args.lastIndexOf("-EncodedCommand");
  if (encIdx >= 0) {
    const b64 = args[encIdx + 1];
    return Buffer.from(b64, "base64").toString("utf16le");
  }
  const cmdIdx = args.lastIndexOf("-Command");
  return cmdIdx >= 0 ? args[cmdIdx + 1] : "";
}

function extractPidFile(args) {
  const wrapped = extractWrappedCommand(args);
  const match = /Set-Content '([^']+)'/u.exec(wrapped);
  if (!match) {
    throw new Error(`PID file path not found in wrapped command: ${wrapped}`);
  }
  return match[1];
}

function createHarness(options = {}) {
  let currentTime = options.startTime ?? 0;
  let nextPid = options.startPid ?? 2_000;
  const spawnCalls = [];
  const killCalls = [];
  const sendKeysCalls = [];
  const sleepCalls = [];

  const deps = {
    platform: () => options.platform || "win32",
    now: () => currentTime,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      currentTime += ms;
      if (typeof options.onSleep === "function") {
        await options.onSleep({ ms, currentTime, sleepCalls });
      }
    },
    spawn: (file, args, spawnOpts) => {
      const pid = nextPid++;
      spawnCalls.push({
        file,
        args: [...args],
        opts: { ...spawnOpts },
        pid,
        at: currentTime,
        unrefCalled: false,
      });

      const pidFile = extractPidFile(args);
      if (options.writePidFile !== false) {
        writeFileSync(pidFile, String(pid), "utf8");
      }

      return {
        unref() {
          spawnCalls[spawnCalls.length - 1].unrefCalled = true;
        },
      };
    },
    isPidAlive: options.isPidAlive || (() => true),
    kill: (pid) => {
      killCalls.push(pid);
    },
    sendKeysToPane: (pane, command, submit) => {
      sendKeysCalls.push({ pane, command, submit });
    },
  };

  return {
    deps,
    spawnCalls,
    killCalls,
    sendKeysCalls,
    sleepCalls,
    advanceTime(ms) {
      currentTime += ms;
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("wt-manager: createWtManager", () => {
  it("Windows가 아니면 즉시 에러를 던진다", () => {
    assert.throws(
      () => createWtManager({ deps: { platform: () => "linux" } }),
      /Windows-only/,
    );
  });

  it("Object.freeze된 공개 API를 반환한다", () => {
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      deps: createHarness().deps,
    });

    assert.ok(Object.isFrozen(manager));
    assert.equal(typeof manager.createTab, "function");
    assert.equal(typeof manager.closeTab, "function");
    assert.equal(typeof manager.listTabs, "function");
    assert.equal(typeof manager.closeStale, "function");
    assert.equal(typeof manager.createSession, "function");
    assert.equal(typeof manager.getTabCount, "function");
  });
});

describe("wt-manager: createTab", () => {
  it("wt.exe를 detached/unref 패턴으로 호출하고 탭을 추적한다", async () => {
    const pidDir = createTempPidDir();
    const harness = createHarness();
    const manager = createWtManager({
      windowName: "tfx-test",
      pidDir,
      deps: harness.deps,
    });

    await manager.createTab({
      title: "lead",
      command: 'Write-Host "ready"',
      profile: "triflux",
      cwd: "C:/repo/triflux",
    });

    assert.equal(harness.spawnCalls.length, 1);
    const [call] = harness.spawnCalls;
    assert.equal(call.file, "wt.exe");
    assert.equal(call.opts.detached, true);
    assert.equal(call.opts.stdio, "ignore");
    assert.equal(call.unrefCalled, true);
    assert.deepEqual(call.args.slice(0, 3), ["-w", "tfx-test", "nt"]);
    assert.ok(call.args.includes("--title"));
    assert.ok(call.args.includes("lead"));
    assert.ok(call.args.includes("--profile"));
    assert.ok(call.args.includes("triflux"));
    assert.ok(call.args.includes("-d"));
    assert.ok(call.args.includes("C:/repo/triflux"));
    assert.deepEqual(call.args.slice(-4, -1), [
      "powershell.exe",
      "-NoExit",
      "-EncodedCommand",
    ]);

    const wrapped = extractWrappedCommand(call.args);
    const pidFile = extractPidFile(call.args);
    assert.equal(readFileSync(pidFile, "utf8"), String(call.pid));
    assert.ok(wrapped.includes(`Set-Content '${pidFile}'`));
    assert.ok(wrapped.includes('Write-Host "ready"'));
    assert.deepEqual(manager.listTabs(), [
      { title: "lead", pid: call.pid, createdAt: 0 },
    ]);
    assert.equal(manager.getTabCount(), 1);
  });

  it("최대 탭 수를 넘기면 에러를 던진다", async () => {
    const manager = createWtManager({
      maxTabs: 1,
      pidDir: createTempPidDir(),
      deps: createHarness().deps,
    });

    await manager.createTab({ title: "first" });

    await assert.rejects(
      () => manager.createTab({ title: "second" }),
      /max tabs exceeded/i,
    );
  });

  it("탭 생성 간격을 최소 500ms로 스로틀링한다", async () => {
    const pidDir = createTempPidDir();
    const harness = createHarness();
    const manager = createWtManager({
      pidDir,
      tabCreateDelayMs: 500,
      deps: harness.deps,
    });

    await manager.createTab({ title: "worker-1" });
    await manager.createTab({ title: "worker-2" });

    assert.deepEqual(harness.sleepCalls, [500]);
    assert.equal(harness.spawnCalls[0].at, 0);
    assert.equal(harness.spawnCalls[1].at, 500);
  });
});

describe("wt-manager: lifecycle helpers", () => {
  it("closeTab은 PID를 종료하고 탭을 제거한다", async () => {
    const harness = createHarness();
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      deps: harness.deps,
    });

    await manager.createTab({ title: "monitor" });
    await manager.closeTab("monitor");

    assert.deepEqual(harness.killCalls, [harness.spawnCalls[0].pid]);
    assert.equal(manager.getTabCount(), 0);
    assert.deepEqual(manager.listTabs(), []);
  });

  it("listTabs와 closeStale은 age/titlePattern 조건으로 stale 탭만 정리한다", async () => {
    const harness = createHarness();
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      tabCreateDelayMs: 1,
      deps: harness.deps,
    });

    await manager.createTab({ title: "lead" });
    harness.advanceTime(1_000);
    await manager.createTab({ title: "worker-1" });
    harness.advanceTime(2_000);
    await manager.createTab({ title: "worker-2" });
    harness.advanceTime(2_000);

    const closed = await manager.closeStale({
      olderThanMs: 2_500,
      titlePattern: /^worker-/u,
    });

    assert.equal(closed, 1);
    assert.deepEqual(harness.killCalls, [harness.spawnCalls[1].pid]);
    assert.deepEqual(
      manager.listTabs().map((tab) => tab.title),
      ["lead", "worker-2"],
    );
  });

  it("createSession은 탭 생성 후 psmux send-keys를 연결한다", async () => {
    const harness = createHarness();
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      deps: harness.deps,
    });

    await manager.createSession({
      tab: { title: "swarm lead", profile: "triflux" },
      pane: "swarm:0.0",
      command: "npm run watch",
    });

    assert.equal(manager.getTabCount(), 1);
    assert.deepEqual(harness.sendKeysCalls, [
      {
        pane: "swarm:0.0",
        command: "npm run watch",
        submit: true,
      },
    ]);
  });
});
