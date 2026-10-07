import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { buildWorkerSandboxEnv } from "../../hub/team/worker-sandbox.mjs";
import { DelegatorMcpWorker } from "../../hub/workers/delegator-mcp.mjs";

const cleanup = [];

function tmpRoot(name) {
  const dir = join(tmpdir(), `tfx-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
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

  it("keeps the host HOME for antigravity-family agents (no headless auth)", () => {
    const cwd = tmpRoot("worker-sandbox-agy");
    for (const agent of ["antigravity", "agy", "gemini", "AGY"]) {
      const result = buildWorkerSandboxEnv({
        cwd,
        sessionId: "agy-worker",
        agent,
        env: { HOME: "/host/home" },
      });
      assert.equal(result.disabled, true, `${agent} should skip the sandbox`);
      assert.equal(result.reason, "auth-home-bound-agent");
      assert.deepEqual(result.env, {});
    }
  });

  it("still sandboxes codex (it is isolated via CODEX_HOME)", () => {
    const cwd = tmpRoot("worker-sandbox-codex-agent");
    const result = buildWorkerSandboxEnv({
      cwd,
      sessionId: "codex-worker",
      agent: "codex",
      env: { HOME: "/host/home" },
    });
    const expectedHome = join(cwd, ".triflux", "worker-home", "codex-worker");
    assert.equal(result.disabled, false);
    assert.equal(result.env.HOME, expectedHome);
    assert.equal(result.env.CODEX_HOME, join("/host/home", ".codex"));
  });

  it("delegator route keeps the host HOME for the antigravity provider", () => {
    const cwd = tmpRoot("worker-sandbox-agy-delegator");
    const hostHome = tmpRoot("worker-sandbox-agy-host-home");
    const worker = new DelegatorMcpWorker({
      cwd,
      env: {
        HOME: hostHome,
        PATH: process.env.PATH || "",
      },
    });

    const env = worker._buildRouteEnv({
      provider: "antigravity",
      teamTaskId: "task/agy",
    });

    assert.equal(env.HOME, hostHome);
    assert.equal(env.TFX_WORKER_SANDBOX_SCOPE, undefined);
  });
});
