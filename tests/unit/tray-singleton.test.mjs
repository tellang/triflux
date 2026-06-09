// tests/unit/tray-singleton.test.mjs — macOS tray singleton regressions

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectMacTrayProcesses,
  reapExistingMacTrayProcesses,
} from "../../hub/tray.mjs";

describe("macOS tray singleton", () => {
  it("detects existing node tray parents for the same tray script", () => {
    const scriptPath = "/Users/tellang/Projects/tools/triflux/hub/tray.mjs";
    const psOutput = `
      27259     1 /opt/homebrew/bin/node /Users/tellang/Projects/tools/triflux/hub/tray.mjs
      27270 27259 /usr/bin/swift-frontend -frontend -interpret /Users/tellang/Projects/tools/triflux/hub/mac-tray.swift -- 27888
      35710     1 /opt/homebrew/bin/node /Users/tellang/Projects/tools/triflux/hub/tray.mjs
      99999     1 /opt/homebrew/bin/node /Users/tellang/Projects/other/hub/tray.mjs
    `;

    assert.deepEqual(
      collectMacTrayProcesses(psOutput, { scriptPath, currentPid: 12345 }),
      [
        {
          pid: 27259,
          ppid: 1,
          command:
            "/opt/homebrew/bin/node /Users/tellang/Projects/tools/triflux/hub/tray.mjs",
        },
        {
          pid: 35710,
          ppid: 1,
          command:
            "/opt/homebrew/bin/node /Users/tellang/Projects/tools/triflux/hub/tray.mjs",
        },
      ],
    );
  });

  it("reaps existing same-script tray parents before starting a new tray", () => {
    const killed = [];
    const scriptPath = "/repo/hub/tray.mjs";
    const psOutput = `
      111 1 node /repo/hub/tray.mjs
      222 1 node /repo/hub/tray.mjs
      333 1 node /other/hub/tray.mjs
    `;

    const reaped = reapExistingMacTrayProcesses({
      scriptPath,
      currentPid: 444,
      execFileSyncFn: () => psOutput,
      killFn: (pid, signal) => killed.push([pid, signal]),
    });

    assert.deepEqual(
      reaped.map((process) => process.pid),
      [111, 222],
    );
    assert.deepEqual(killed, [
      [111, "SIGTERM"],
      [222, "SIGTERM"],
    ]);
  });
});
