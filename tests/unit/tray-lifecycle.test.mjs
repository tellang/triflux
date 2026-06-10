// tests/unit/tray-lifecycle.test.mjs — Hub/Tray auto-start lifecycle regressions

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ensureHubForTray,
  spawnTrayForHub,
} from "../../hub/tray-lifecycle.mjs";

describe("hub/tray lifecycle", () => {
  it("tray startup spawns hub when health is unavailable and disables hub auto-tray recursion", async () => {
    const spawns = [];

    const result = await ensureHubForTray({
      port: "27888",
      serverPath: "/repo/hub/server.mjs",
      nodePath: "/usr/local/bin/node",
      fetchFn: async () => {
        throw new Error("offline");
      },
      spawnFn: (...args) => {
        spawns.push(args);
        return { pid: 1234, unref() {} };
      },
      waitForHealth: false,
      env: { PATH: "/bin", TFX_HUB_AUTO_TRAY: "1" },
    });

    assert.equal(result.status, "started");
    assert.equal(result.pid, 1234);
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0][0], "/usr/local/bin/node");
    assert.deepEqual(spawns[0][1], ["/repo/hub/server.mjs"]);
    assert.equal(spawns[0][2].detached, true);
    assert.equal(spawns[0][2].stdio, "ignore");
    assert.equal(spawns[0][2].env.TFX_HUB_PORT, "27888");
    assert.equal(spawns[0][2].env.TFX_HUB_AUTO_TRAY, "0");
  });

  it("tray startup does not spawn hub when health already responds", async () => {
    const spawns = [];

    const result = await ensureHubForTray({
      port: "27888",
      serverPath: "/repo/hub/server.mjs",
      fetchFn: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      spawnFn: (...args) => spawns.push(args),
      waitForHealth: false,
    });

    assert.equal(result.status, "running");
    assert.deepEqual(spawns, []);
  });

  it("tray startup forces canonical port inside worktree contexts even when env is polluted", async () => {
    const spawns = [];
    const healthChecks = [];

    const result = await ensureHubForTray({
      cwd: "/repo/.worktrees/agent-a7608",
      env: {
        PATH: "/bin",
        TFX_HUB_PORT: "29009",
        TFX_HUB_URL: "http://127.0.0.1:29009/mcp",
      },
      port: "29009",
      serverPath: "/repo/hub/server.mjs",
      nodePath: "/usr/local/bin/node",
      fetchFn: async (url) => {
        healthChecks.push(url);
        throw new Error("offline");
      },
      spawnFn: (...args) => {
        spawns.push(args);
        return { pid: 2233, unref() {} };
      },
      waitForHealth: false,
    });

    assert.equal(result.status, "started");
    assert.equal(healthChecks[0], "http://127.0.0.1:27888/health");
    assert.equal(spawns[0][2].env.TFX_HUB_PORT, "27888");
  });

  it("hub startup spawns tray on macOS unless auto-tray is disabled", () => {
    const spawns = [];

    const result = spawnTrayForHub({
      platform: "darwin",
      trayPath: "/repo/hub/tray.mjs",
      nodePath: "/usr/local/bin/node",
      env: { PATH: "/bin" },
      spawnFn: (...args) => {
        spawns.push(args);
        return { pid: 5678, unref() {} };
      },
    });

    assert.equal(result.status, "started");
    assert.equal(result.pid, 5678);
    assert.deepEqual(spawns[0][0], "/usr/local/bin/node");
    assert.deepEqual(spawns[0][1], ["/repo/hub/tray.mjs"]);
    assert.equal(spawns[0][2].detached, true);
    assert.equal(spawns[0][2].stdio, "ignore");
  });

  it("hub startup skips tray when disabled or not macOS", () => {
    assert.deepEqual(
      spawnTrayForHub({
        platform: "darwin",
        env: { TFX_HUB_AUTO_TRAY: "0" },
        spawnFn: () => {
          throw new Error("should not spawn");
        },
      }),
      { status: "disabled" },
    );

    assert.deepEqual(
      spawnTrayForHub({
        platform: "linux",
        env: {},
        spawnFn: () => {
          throw new Error("should not spawn");
        },
      }),
      { status: "unsupported-platform" },
    );
  });

  it("hub startup skips tray in worktree or ephemeral context", () => {
    assert.deepEqual(
      spawnTrayForHub({
        platform: "darwin",
        trayPath: "/repo/hub/tray.mjs",
        env: { TFX_TEAM_TASK_ID: "task-123" },
        spawnFn: () => {
          throw new Error("should not spawn");
        },
      }),
      { status: "disabled", reason: "ephemeral-or-worktree-context" },
    );
  });
});
