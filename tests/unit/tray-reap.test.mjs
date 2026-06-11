// tests/unit/tray-reap.test.mjs — macOS tray process dedupe matching

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectMacTrayProcesses,
  reapExistingMacTrayProcesses,
} from "../../hub/tray.mjs";

const MAIN_TRAY_PATH = "/repo/hub/tray.mjs";
const WORKTREE_TRAY_PATH = "/repo/.claude/worktrees/agent-a/hub/tray.mjs";
const OTHER_WORKTREE_TRAY_PATH = "/repo/.codex-swarm/wt-b/hub/tray.mjs";

const PS_OUTPUT = `
  101     1 /opt/homebrew/bin/node ${MAIN_TRAY_PATH}
  102     1 /opt/homebrew/bin/node ${WORKTREE_TRAY_PATH}
  103     1 /opt/homebrew/bin/node ${OTHER_WORKTREE_TRAY_PATH}
  104     1 /opt/homebrew/bin/node /repo/hub/server.mjs
  105     1 /usr/bin/python3 ${WORKTREE_TRAY_PATH}
  106     1 /opt/homebrew/bin/node ${WORKTREE_TRAY_PATH}.bak
  107     1 /opt/homebrew/bin/node /repo/hub/not-tray.mjs
`;

describe("collectMacTrayProcesses", () => {
  it("matches worktree tray scripts from the main tray path and excludes itself", () => {
    const matches = collectMacTrayProcesses(PS_OUTPUT, {
      scriptPath: MAIN_TRAY_PATH,
      currentPid: 101,
    });

    assert.deepEqual(
      matches.map((processInfo) => processInfo.pid),
      [102, 103],
    );
  });

  it("matches the main tray script from a worktree tray path and excludes itself", () => {
    const matches = collectMacTrayProcesses(PS_OUTPUT, {
      scriptPath: WORKTREE_TRAY_PATH,
      currentPid: 102,
    });

    assert.deepEqual(
      matches.map((processInfo) => processInfo.pid),
      [101, 103],
    );
  });
});

describe("reapExistingMacTrayProcesses", () => {
  it("SIGTERMs only matching sibling tray node processes", () => {
    const killed = [];

    const reaped = reapExistingMacTrayProcesses({
      scriptPath: MAIN_TRAY_PATH,
      currentPid: 101,
      execFileSyncFn: () => PS_OUTPUT,
      killFn: (pid, signal) => killed.push({ pid, signal }),
    });

    assert.deepEqual(
      reaped.map((processInfo) => processInfo.pid),
      [102, 103],
    );
    assert.deepEqual(killed, [
      { pid: 102, signal: "SIGTERM" },
      { pid: 103, signal: "SIGTERM" },
    ]);
  });
});
