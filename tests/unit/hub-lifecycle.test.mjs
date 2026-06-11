// tests/unit/hub-lifecycle.test.mjs — Hub startup reaper regressions

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectHubProcesses,
  isWorktreeOrEphemeralHubContext,
  reapExistingHubProcesses,
} from "../../hub/hub-lifecycle.mjs";

describe("hub lifecycle context detection", () => {
  it("treats codex swarm wt directories as ephemeral hub contexts", () => {
    assert.equal(
      isWorktreeOrEphemeralHubContext({
        cwd: "/repo/.codex-swarm/wt-agent-a",
        env: {},
      }),
      true,
    );
    assert.equal(
      isWorktreeOrEphemeralHubContext({
        cwd: "/repo/runtime/wt-agent-a",
        env: {},
      }),
      true,
    );
  });
});

describe("hub lifecycle reaper", () => {
  it("detects hub/server.mjs node processes from ps output", () => {
    const psOutput = `
      111 1 /opt/homebrew/bin/node /repo/hub/server.mjs
      222 1 node /repo/hub/tray.mjs
      333 1 /usr/bin/node /repo/packages/triflux/hub/server.mjs --flag
      444 1 /usr/bin/python /repo/hub/server.mjs
    `;

    assert.deepEqual(collectHubProcesses(psOutput, { currentPid: 999 }), [
      {
        pid: 111,
        ppid: 1,
        command: "/opt/homebrew/bin/node /repo/hub/server.mjs",
      },
      {
        pid: 333,
        ppid: 1,
        command: "/usr/bin/node /repo/packages/triflux/hub/server.mjs --flag",
      },
    ]);
  });

  it("preserves self, pidfile owner, and the 27888 listener while reaping non-standard hubs", async () => {
    const killed = [];
    const psOutput = `
      111 1 /opt/homebrew/bin/node /repo/hub/server.mjs
      222 1 /opt/homebrew/bin/node /repo/hub/server.mjs
      333 1 /opt/homebrew/bin/node /repo/hub/server.mjs
      444 1 /opt/homebrew/bin/node /repo/hub/server.mjs
    `;

    const result = await reapExistingHubProcesses({
      currentPid: 111,
      readPidFileFn: () => ({ pid: 222 }),
      findListeningPidsForPortFn: () => [333],
      execFileSyncFn: () => psOutput,
      killFn: (pid, signal) => {
        killed.push([pid, signal]);
      },
      waitForExitFn: async () => true,
    });

    assert.deepEqual(
      result.reaped.map((process) => process.pid),
      [444],
    );
    assert.deepEqual(result.preserved, {
      currentPid: 111,
      pidFilePid: 222,
      defaultPortPids: [333],
    });
    assert.deepEqual(killed, [[444, "SIGTERM"]]);
  });

  it("reports escalation failures when SIGKILL cannot reap a stuck hub", async () => {
    const killed = [];
    const psOutput = `
      444 1 /opt/homebrew/bin/node /repo/hub/server.mjs
    `;

    const result = await reapExistingHubProcesses({
      currentPid: 111,
      readPidFileFn: () => ({ pid: 222 }),
      findListeningPidsForPortFn: () => [333],
      execFileSyncFn: () => psOutput,
      killFn: (pid, signal) => {
        killed.push([pid, signal]);
        if (signal === "SIGKILL") throw new Error("operation not permitted");
      },
      waitForExitFn: async () => false,
    });

    assert.deepEqual(killed, [
      [444, "SIGTERM"],
      [444, "SIGKILL"],
    ]);
    assert.deepEqual(result.failed, [
      {
        pid: 444,
        signal: "SIGKILL",
        error: "operation not permitted",
      },
    ]);
  });
});
