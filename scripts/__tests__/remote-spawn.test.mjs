import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { startSpawnExitWatcher, watchSpawnSessionExit } from "../remote-spawn.mjs";

describe("remote-spawn watcher", () => {
  it("lead pane dead 상태가 grace 기간 유지되면 세션을 정리한다", async () => {
    let nowMs = 0;
    let pollIndex = 0;
    const killed = [];
    const statuses = [
      { isDead: false, exitCode: null },
      { isDead: true, exitCode: 0 },
      { isDead: true, exitCode: 0 },
      { isDead: true, exitCode: 0 },
    ];

    const result = await watchSpawnSessionExit("tfx-spawn-unit", {
      pollMs: 100,
      graceMs: 200,
      maxWaitMs: 1000,
      sessionExists: () => true,
      getPaneStatus: () => statuses[Math.min(pollIndex++, statuses.length - 1)],
      killSession: (name) => killed.push(name),
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    assert.equal(result.cleaned, true);
    assert.equal(result.reason, "pane-dead");
    assert.deepEqual(killed, ["tfx-spawn-unit"]);
  });

  it("live session은 정리하지 않고 timeout으로 종료한다", async () => {
    let nowMs = 0;
    let killCount = 0;

    const result = await watchSpawnSessionExit("tfx-spawn-timeout", {
      pollMs: 100,
      graceMs: 200,
      maxWaitMs: 250,
      sessionExists: () => true,
      getPaneStatus: () => ({ isDead: false, exitCode: null }),
      killSession: () => { killCount += 1; },
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    assert.equal(result.cleaned, false);
    assert.equal(result.reason, "timeout");
    assert.equal(killCount, 0);
  });

  it("detached watcher를 --watch-exit 인자로 실행한다", () => {
    const calls = [];
    const started = startSpawnExitWatcher("tfx-spawn-detached", {
      force: true,
      execPath: "node-test",
      scriptPath: "C:/tmp/remote-spawn.mjs",
      spawnFn: (file, args, options) => {
        calls.push({ file, args, options, unrefCalled: false });
        return {
          unref() {
            calls[0].unrefCalled = true;
          },
        };
      },
    });

    assert.equal(started, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "node-test");
    assert.deepEqual(calls[0].args, ["C:/tmp/remote-spawn.mjs", "--watch-exit", "tfx-spawn-detached"]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, "ignore");
    assert.equal(calls[0].unrefCalled, true);
  });
});
