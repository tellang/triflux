import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanupStaleFsmonitorDaemons,
  findFsmonitorDaemons,
} from "../../hub/lib/process-utils.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-04-26T00:00:00.000Z");

function psJson(records) {
  return JSON.stringify(records);
}

describe("findFsmonitorDaemons", () => {
  it("returns [] on non-Windows platforms", () => {
    const seen = [];
    const result = findFsmonitorDaemons({
      isWindows: false,
      execSyncFn: () => {
        seen.push("exec");
        return "";
      },
    });

    assert.deepEqual(result, []);
    assert.deepEqual(seen, []);
  });

  it("finds only stale git fsmonitor daemons with exact command marker", () => {
    const result = findFsmonitorDaemons({
      isWindows: true,
      minAgeMs: DAY_MS,
      nowMs: NOW_MS,
      execSyncFn: (command) => {
        assert.match(command, /Get-CimInstance Win32_Process/);
        assert.match(command, /Name='git\.exe'/);
        assert.match(command, /fsmonitor--daemon run --detach/);
        return psJson([
          {
            ProcessId: 101,
            ParentProcessId: 10,
            CreationDate: "2026-04-24T23:59:59.000Z",
            CommandLine: "git fsmonitor--daemon run --detach --ipc-threads=8",
          },
          {
            ProcessId: 102,
            ParentProcessId: 10,
            CreationDate: "2026-04-25T23:59:59.000Z",
            CommandLine: "git fsmonitor--daemon run --detach --ipc-threads=8",
          },
          {
            ProcessId: 103,
            ParentProcessId: 10,
            CreationDate: "2026-04-24T23:59:59.000Z",
            CommandLine: "git status",
          },
          {
            ProcessId: 104,
            ParentProcessId: 10,
            CreationDate: "2026-04-24T23:59:59.000Z",
            CommandLine: "git fsmonitor--daemon run --detached",
          },
        ]);
      },
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].pid, 101);
    assert.equal(result[0].parentPid, 10);
    assert.equal(
      result[0].commandLine,
      "git fsmonitor--daemon run --detach --ipc-threads=8",
    );
    assert.ok(result[0].ageMs >= DAY_MS);
  });
});

describe("cleanupStaleFsmonitorDaemons", () => {
  it("kills only stale fsmonitor daemon pids with SIGKILL", () => {
    const kills = [];
    const result = cleanupStaleFsmonitorDaemons({
      isWindows: true,
      minAgeMs: DAY_MS,
      nowMs: NOW_MS,
      execSyncFn: () =>
        psJson([
          {
            ProcessId: 201,
            ParentProcessId: 20,
            CreationDate: "2026-04-24T23:59:59.000Z",
            CommandLine: "git fsmonitor--daemon run --detach --ipc-threads=8",
          },
          {
            ProcessId: 202,
            ParentProcessId: 20,
            CreationDate: "2026-04-24T23:59:59.000Z",
            CommandLine: "git worktree remove C:/repo/wt",
          },
        ]),
      killFn: (pid, signal) => {
        kills.push([pid, signal]);
      },
    });

    assert.equal(result.killed, 1);
    assert.equal(result.stale.length, 1);
    assert.deepEqual(kills, [[201, "SIGKILL"]]);
  });
});
