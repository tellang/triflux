// tests/unit/setup-legacy-tray-reap.test.mjs — 제거된 CTO 트레이 잔여 프로세스 정리 (ADR-0022)
// ps 출력과 kill 은 주입한다 — 실제 프로세스를 조회하거나 죽이지 않는다.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectLegacyTrayProcesses,
  reapLegacyTrayProcesses,
} from "../../scripts/setup.mjs";

const UID = 501;
const START = "Sat Oct  4 10:00:00 2026";
const NPM_TRAY =
  "/opt/homebrew/bin/node /Users/me/.npm-global/lib/node_modules/triflux/hub/tray.mjs";
const DEV_SWIFT_FRONTEND =
  "/usr/bin/swift-frontend -frontend -interpret /Users/me/Projects/tools/triflux/hub/mac-tray.swift -- 27888";
const PKG_SWIFT =
  "swift /Users/me/Projects/tools/triflux/packages/triflux/hub/mac-tray.swift 27888";
const OPT_NODE_TRAY =
  "node --enable-source-maps /Users/me/Projects/tools/triflux/hub/tray.mjs";

function psLine(uid, pid, command, start = START) {
  return `  ${uid} ${String(pid).padStart(5)} ${start}     ${command}`;
}

const PS_OUTPUT = [
  "",
  psLine(UID, 101, NPM_TRAY),
  psLine(UID, 102, DEV_SWIFT_FRONTEND),
  psLine(UID, 103, PKG_SWIFT),
  psLine(UID, 104, "/opt/homebrew/bin/node /Users/me/triflux/hub/server.mjs"),
  psLine(UID, 105, "vim /Users/me/triflux/hub/tray.mjs"),
  psLine(UID, 106, "/opt/homebrew/bin/node /Users/me/triflux/hub/not-tray.mjs"),
  psLine(UID, 107, "/opt/homebrew/bin/node /Users/me/triflux/hub/tray.mjs.bak"),
  // 경로를 인자로만 받은 프로세스 — 실행 대상(entrypoint)이 아니다.
  psLine(UID, 108, "node /work/index.mjs /work/triflux/hub/tray.mjs"),
  // triflux 설치 위치로 보이지 않는 경로.
  psLine(UID, 109, "node /repo/hub/tray.mjs"),
  // 옵션 뒤 첫 스크립트 인자가 트레이면 대상이다.
  psLine(UID, 110, OPT_NODE_TRAY),
  // -interpret 없는 swift-frontend(컴파일)는 트레이 실행이 아니다.
  psLine(UID, 111, "swift-frontend -frontend -c /x/triflux/hub/mac-tray.swift"),
  // 다른 사용자 소유 프로세스는 건드리지 않는다.
  psLine(0, 112, NPM_TRAY),
  // 값을 받는 옵션(-r)의 값은 실행 대상이 아니다.
  psLine(UID, 113, "node -r /x/triflux/hub/tray.mjs /work/app.mjs"),
  psLine(UID, 999, "/opt/homebrew/bin/node /Users/me/triflux/hub/tray.mjs"),
  "",
].join("\n");

const LIST_ARGS = ["-axo", "uid=,pid=,lstart=,command="];

function fakePs(table, recheck = {}) {
  const calls = [];
  const fn = (command, args) => {
    assert.equal(command, "ps");
    calls.push(args);
    if (args[0] === "-axo") {
      assert.deepEqual(args, LIST_ARGS);
      return table;
    }
    assert.deepEqual(args.slice(0, 3), [
      "-o",
      "uid=,pid=,lstart=,command=",
      "-p",
    ]);
    const pid = Number(args[3]);
    if (Object.hasOwn(recheck, pid)) {
      const value = recheck[pid];
      if (value instanceof Error) throw value;
      return value;
    }
    return `${table
      .split("\n")
      .find(
        (line) => line.match(/^\s*\d+\s+(\d+)\s/u)?.[1] === String(pid),
      )}\n`;
  };
  return { fn, calls };
}

describe("setup legacy tray reap", () => {
  it("현재 사용자가 triflux 경로의 트레이를 실행 대상으로 띄운 프로세스만 고른다", () => {
    assert.deepEqual(
      collectLegacyTrayProcesses(PS_OUTPUT, {
        currentPid: 999,
        currentUid: UID,
      }).map((proc) => proc.pid),
      [101, 102, 103, 110],
    );
  });

  it("고른 프로세스는 uid·시작 시각·command 를 보관한다", () => {
    const [first] = collectLegacyTrayProcesses(PS_OUTPUT, {
      currentPid: 999,
      currentUid: UID,
    });
    assert.deepEqual(first, {
      pid: 101,
      uid: UID,
      startedAt: START,
      command: NPM_TRAY,
    });
  });

  it("uid 를 알 수 없으면 아무것도 고르지 않는다", () => {
    assert.deepEqual(
      collectLegacyTrayProcesses(PS_OUTPUT, {
        currentPid: 999,
        currentUid: null,
      }),
      [],
    );
  });

  it("옛 dev 클론과 npm 전역 설치 경로를 모두 잡는다", () => {
    const table = [
      psLine(UID, 201, "node /Users/me/Projects/tools/triflux/hub/tray.mjs"),
      psLine(
        UID,
        202,
        "/usr/local/bin/node /usr/local/lib/node_modules/triflux/hub/tray.mjs",
      ),
    ].join("\n");
    assert.deepEqual(
      collectLegacyTrayProcesses(table, { currentPid: 1, currentUid: UID }).map(
        (proc) => proc.pid,
      ),
      [201, 202],
    );
  });

  it("SIGTERM 직전에 다시 조회해 같은 프로세스일 때만 보내고 실패한 kill 은 건너뛴다", () => {
    const kills = [];
    const ps = fakePs(PS_OUTPUT);
    const reaped = reapLegacyTrayProcesses({
      platform: "darwin",
      currentPid: 999,
      currentUid: UID,
      execFileSyncFn: ps.fn,
      killFn: (pid, signal) => {
        kills.push([pid, signal]);
        if (pid === 102) throw new Error("ESRCH");
      },
    });

    assert.deepEqual(kills, [
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [103, "SIGTERM"],
      [110, "SIGTERM"],
    ]);
    assert.deepEqual(
      reaped.map((proc) => proc.pid),
      [101, 103, 110],
    );
    assert.deepEqual(
      ps.calls.slice(1).map((args) => args[3]),
      ["101", "102", "103", "110"],
    );
  });

  it("PID 가 재사용됐으면(시작 시각·command·uid 불일치, 조회 실패) 보내지 않는다", () => {
    const kills = [];
    const ps = fakePs(PS_OUTPUT, {
      101: `${psLine(UID, 101, NPM_TRAY, "Sat Oct  4 11:30:00 2026")}\n`,
      102: `${psLine(UID, 102, "/usr/bin/python3 server.py")}\n`,
      103: new Error("ps exited 1"),
      110: `${psLine(0, 110, OPT_NODE_TRAY)}\n`,
    });
    const reaped = reapLegacyTrayProcesses({
      platform: "linux",
      currentPid: 999,
      currentUid: UID,
      execFileSyncFn: ps.fn,
      killFn: (pid, signal) => kills.push([pid, signal]),
    });
    assert.deepEqual(kills, []);
    assert.deepEqual(reaped, []);
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
        currentUid: UID,
        execFileSyncFn: () => {
          throw new Error("ps missing");
        },
        killFn,
      }),
      [],
    );
  });
});
