// tests/unit/setup-legacy-tray-reap.test.mjs — 제거된 CTO 트레이 잔여 프로세스 정리 (ADR-0022)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectLegacyTrayProcesses,
  reapLegacyTrayProcesses,
} from "../../scripts/setup.mjs";

const PS_OUTPUT = `
  101 /opt/homebrew/bin/node /Users/me/.npm-global/lib/node_modules/triflux/hub/tray.mjs
  102 /usr/bin/swift-frontend -frontend -interpret /repo/hub/mac-tray.swift -- 27888
  103 swift /repo/packages/triflux/hub/mac-tray.swift 27888
  104 /opt/homebrew/bin/node /repo/hub/server.mjs
  105 vim /repo/hub/tray.mjs
  106 /opt/homebrew/bin/node /repo/hub/not-tray.mjs
  107 /opt/homebrew/bin/node /repo/hub/tray.mjs.bak
  999 /opt/homebrew/bin/node /repo/hub/tray.mjs
`;

describe("setup legacy tray reap", () => {
  it("node/swift 로 실행 중인 hub 트레이 스크립트만 고른다", () => {
    assert.deepEqual(
      collectLegacyTrayProcesses(PS_OUTPUT, { currentPid: 999 }).map(
        (proc) => proc.pid,
      ),
      [101, 102, 103],
    );
  });

  it("고른 프로세스에 SIGTERM 을 보내고 실패한 kill 은 건너뛴다", () => {
    const kills = [];
    const reaped = reapLegacyTrayProcesses({
      platform: "darwin",
      currentPid: 999,
      execFileSyncFn: (command, args) => {
        assert.equal(command, "ps");
        assert.deepEqual(args, ["-axo", "pid=,command="]);
        return PS_OUTPUT;
      },
      killFn: (pid, signal) => {
        kills.push([pid, signal]);
        if (pid === 102) throw new Error("ESRCH");
      },
    });

    assert.deepEqual(kills, [
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [103, "SIGTERM"],
    ]);
    assert.deepEqual(
      reaped.map((proc) => proc.pid),
      [101, 103],
    );
  });

  it("Windows 와 ps 실패에서는 아무것도 하지 않는다", () => {
    const killFn = () => assert.fail("kill must not be called");
    assert.deepEqual(
      reapLegacyTrayProcesses({
        platform: "win32",
        execFileSyncFn: () => assert.fail("ps must not run on win32"),
        killFn,
      }),
      [],
    );
    assert.deepEqual(
      reapLegacyTrayProcesses({
        platform: "linux",
        execFileSyncFn: () => {
          throw new Error("ps missing");
        },
        killFn,
      }),
      [],
    );
  });
});
