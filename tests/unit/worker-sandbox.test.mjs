import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { createConductor } from "../../hub/team/conductor.mjs";
import { buildWorkerSandboxEnv } from "../../hub/team/worker-sandbox.mjs";
import { DelegatorMcpWorker } from "../../hub/workers/delegator-mcp.mjs";

const cleanup = [];

function tmpRoot(name) {
  const dir = join(tmpdir(), `tfx-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

function mockSpawnRecorder(calls) {
  return function mockSpawn(_command, _args, options = {}) {
    calls.push(options);
    const child = new EventEmitter();
    child.pid = Math.floor(Math.random() * 1_000_000) + 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
}

afterEach(() => {
  while (cleanup.length) {
    rmSync(cleanup.pop(), { recursive: true, force: true });
  }
});

describe("worker sandbox env", () => {
  it("redirects POSIX and Windows user-state roots into a worker home", () => {
    const cwd = tmpRoot("worker-sandbox-cwd");
    const result = buildWorkerSandboxEnv({
      cwd,
      sessionId: "worker:1",
      env: {
        HOME: "/host/home",
        APPDATA: "C:\\Users\\host\\AppData\\Roaming",
      },
    });

    const expectedHome = join(cwd, ".triflux", "worker-home", "worker_1");
    assert.equal(result.home, expectedHome);
    assert.equal(result.env.HOME, expectedHome);
    assert.equal(result.env.USERPROFILE, expectedHome);
    assert.equal(result.env.APPDATA, join(expectedHome, "AppData", "Roaming"));
    assert.equal(
      result.env.LOCALAPPDATA,
      join(expectedHome, "AppData", "Local"),
    );
    assert.equal(result.env.XDG_CONFIG_HOME, join(expectedHome, ".config"));
    assert.equal(existsSync(result.env.APPDATA), true);
    assert.equal(existsSync(result.env.XDG_STATE_HOME), true);
  });

  it("preserves the host Codex home when CODEX_HOME is unset", () => {
    const cwd = tmpRoot("worker-sandbox-cwd");
    const hostHome = tmpRoot("worker-sandbox-host-home");
    const result = buildWorkerSandboxEnv({
      cwd,
      sessionId: "codex-worker",
      env: {
        HOME: hostHome,
      },
    });

    const expectedHome = join(cwd, ".triflux", "worker-home", "codex-worker");
    assert.equal(result.env.HOME, expectedHome);
    assert.equal(result.env.CODEX_HOME, join(hostHome, ".codex"));
  });

  it("supports explicit opt-out for debugging", () => {
    const result = buildWorkerSandboxEnv({
      cwd: tmpRoot("worker-sandbox-disabled"),
      sessionId: "worker",
      env: { TFX_WORKER_SANDBOX: "0" },
    });
    assert.equal(result.disabled, true);
    assert.deepEqual(result.env, {});
  });

  it("conductor local sessions spawn with sandboxed HOME while preserving CODEX_HOME", async () => {
    const logsDir = tmpRoot("worker-sandbox-logs");
    const workdir = tmpRoot("worker-sandbox-workdir");
    const calls = [];
    const fakeBroker = new EventEmitter();
    fakeBroker.lease = () => undefined;
    const conductor = createConductor({
      logsDir,
      maxRestarts: 0,
      probeOpts: {
        intervalMs: 999_999,
        l1ThresholdMs: 999_999,
        l3ThresholdMs: 999_999,
      },
      broker: fakeBroker,
      deps: { spawn: mockSpawnRecorder(calls) },
    });

    try {
      conductor.spawnSession({
        id: "sandbox-conductor",
        agent: "codex",
        prompt: "test",
        workdir,
        env: { CODEX_HOME: join(workdir, ".codex-lease") },
      });

      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 1);
      const env = calls[0].env;
      const expectedHome = join(
        workdir,
        ".triflux",
        "worker-home",
        "sandbox-conductor",
      );
      assert.equal(env.HOME, expectedHome);
      assert.equal(env.APPDATA, join(expectedHome, "AppData", "Roaming"));
      assert.equal(env.CODEX_HOME, join(workdir, ".codex-lease"));
      assert.notEqual(env.HOME, process.env.HOME);
    } finally {
      await conductor.shutdown("worker_sandbox_test_cleanup");
    }
  });

  it("delegator route spawns inherit sandboxed user-state roots", () => {
    const cwd = tmpRoot("worker-sandbox-delegator");
    const hostHome = tmpRoot("worker-sandbox-host-home");
    const worker = new DelegatorMcpWorker({
      cwd,
      env: {
        HOME: hostHome,
        APPDATA: join(hostHome, "AppData", "Roaming"),
        PATH: process.env.PATH || "",
        CODEX_HOME: join(hostHome, ".codex"),
      },
    });

    const env = worker._buildRouteEnv({
      provider: "codex",
      teamTaskId: "task/one",
    });

    const expectedHome = join(cwd, ".triflux", "worker-home", "task_one");
    assert.equal(env.HOME, expectedHome);
    assert.equal(env.APPDATA, join(expectedHome, "AppData", "Roaming"));
    assert.equal(env.CODEX_HOME, join(hostHome, ".codex"));
    assert.equal(env.TFX_WORKER_SANDBOX_SCOPE, "delegator-route");
  });
});
