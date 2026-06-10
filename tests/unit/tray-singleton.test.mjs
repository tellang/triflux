// tests/unit/tray-singleton.test.mjs — macOS tray singleton regressions

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectMacTrayProcesses,
  reapExistingMacTrayProcesses,
} from "../../hub/tray.mjs";

describe("macOS tray singleton", () => {
  it("detects every node hub/tray.mjs parent (machine-wide singleton)", () => {
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
        // tray 는 전역 hub.pid(canonical 27888)를 보는 머신 전역 싱글턴이다.
        // 경로가 달라도(worktree 사본, 다른 클론) 같은 tray 로 식별해 reap
        // 한다 — 2026-06-10 worktree tray 중복(메뉴바 아이콘 2개) 재발 방지.
        {
          pid: 99999,
          ppid: 1,
          command:
            "/opt/homebrew/bin/node /Users/tellang/Projects/other/hub/tray.mjs",
        },
      ],
    );
  });

  it("reaps every existing tray parent (any path) before starting a new tray", () => {
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
      [111, 222, 333],
    );
    assert.deepEqual(killed, [
      [111, "SIGTERM"],
      [222, "SIGTERM"],
      [333, "SIGTERM"],
    ]);
  });
});
