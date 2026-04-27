import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanupOrphanNodeProcesses,
  cleanupOrphanRuntimeProcesses,
  cleanupShardProcesses,
  cleanupStaleFsmonitorDaemons,
  findFsmonitorDaemons,
  findProcessesByCommandLine,
  findProcessTree,
  killProcessTree,
  killProcessTreeSnapshot,
} from "../../hub/lib/process-utils.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-04-26T00:00:00.000Z");

function psJson(records) {
  return JSON.stringify(records);
}

function mockSpawnSync({ processRecords = [], failTaskkill = false } = {}) {
  const calls = [];
  const fn = (command, args = []) => {
    calls.push({ command, args });
    if (command === "taskkill") {
      return {
        status: failTaskkill ? 1 : 0,
        stdout: "",
        stderr: failTaskkill ? "not found" : "",
      };
    }
    if (command === "powershell") {
      const psCommand = args.at(-1) || "";
      if (psCommand.includes("|;")) {
        return {
          status: 1,
          stdout: "",
          stderr: "An empty pipe element is not allowed.",
        };
      }
      return {
        status: 0,
        stdout: psJson(processRecords),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

const SWARM_PROCS = [
  {
    ProcessId: 310,
    ParentProcessId: 1,
    Name: "node.exe",
    CommandLine: "node C:\\repo\\.codex-swarm\\wt-alpha\\hub\\server.mjs",
  },
  {
    ProcessId: 311,
    ParentProcessId: 310,
    Name: "bash.exe",
    CommandLine: "bash -lc cd C:\\repo\\.codex-swarm\\wt-alpha",
  },
  {
    ProcessId: 312,
    ParentProcessId: 1,
    Name: "node.exe",
    CommandLine: "node C:\\other\\hub\\server.mjs",
  },
  {
    ProcessId: 313,
    ParentProcessId: 1,
    Name: "conhost.exe",
    CommandLine: "conhost.exe psmux session-1",
  },
  {
    ProcessId: 314,
    ParentProcessId: 1,
    Name: "bun.exe",
    CommandLine: "bun gbrain serve",
  },
  {
    ProcessId: 315,
    ParentProcessId: 1,
    Name: "git.exe",
    CommandLine: "git fsmonitor--daemon run --detach",
  },
  {
    ProcessId: 316,
    ParentProcessId: 1,
    Name: "bun.exe",
    CommandLine: "bun gbrain serve C:\\repo\\.codex-swarm\\wt-alpha",
  },
  {
    ProcessId: 317,
    ParentProcessId: 1,
    Name: "git.exe",
    CommandLine:
      "git -C C:\\repo\\.codex-swarm\\wt-alpha fsmonitor--daemon run --detach",
  },
];

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

describe("process tree cleanup helpers", () => {
  it("killProcessTree returns ok=true on success", () => {
    const spawnSyncFn = mockSpawnSync();
    const result = killProcessTree(1234, {
      isWindows: true,
      spawnSyncFn,
      protectedPids: new Set(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.killed, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(spawnSyncFn.calls[0].command, "taskkill");
    assert.deepEqual(spawnSyncFn.calls[0].args, ["/T", "/F", "/PID", "1234"]);
  });

  it("killProcessTree falls back to Get-CimInstance when parent dead", () => {
    const spawnSyncFn = mockSpawnSync({
      failTaskkill: true,
      processRecords: [
        {
          ProcessId: 200,
          ParentProcessId: 1,
          Name: "node.exe",
          CommandLine: "node parent.js",
        },
        {
          ProcessId: 201,
          ParentProcessId: 200,
          Name: "node.exe",
          CommandLine: "node child.js",
        },
        {
          ProcessId: 202,
          ParentProcessId: 201,
          Name: "bash.exe",
          CommandLine: "bash worker.sh",
        },
      ],
    });
    const killed = [];

    const result = killProcessTree(200, {
      isWindows: true,
      spawnSyncFn,
      killFn: (pid, signal) => killed.push([pid, signal]),
      isPidAliveFn: (pid) => pid !== 200,
      protectedPids: new Set(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.killed, 2);
    assert.deepEqual(killed, [
      [202, "SIGKILL"],
      [201, "SIGKILL"],
    ]);
    assert.equal(spawnSyncFn.calls[1].command, "powershell");
  });

  it("findProcessTree builds descendant map", () => {
    const result = findProcessTree(10, {
      isWindows: true,
      spawnSyncFn: mockSpawnSync({
        processRecords: [
          {
            ProcessId: 10,
            ParentProcessId: 1,
            Name: "node.exe",
            CommandLine: "node root.js",
          },
          {
            ProcessId: 11,
            ParentProcessId: 10,
            Name: "bash.exe",
            CommandLine: "bash child.sh",
          },
          {
            ProcessId: 12,
            ParentProcessId: 11,
            Name: "node.exe",
            CommandLine: "node grandchild.js",
          },
          {
            ProcessId: 99,
            ParentProcessId: 1,
            Name: "node.exe",
            CommandLine: "node unrelated.js",
          },
        ],
      }),
    });

    assert.deepEqual(
      result.map((p) => p.pid),
      [10, 11, 12],
    );
    assert.equal(result[2].ppid, 11);
    assert.equal(result[2].name, "node.exe");
  });

  it("killProcessTreeSnapshot tolerates missing PIDs", () => {
    const killed = [];
    const result = killProcessTreeSnapshot([301, { pid: 302 }, 303], {
      killFn: (pid, signal) => killed.push([pid, signal]),
      isPidAliveFn: (pid) => pid !== 302,
      protectedPids: new Set(),
    });

    assert.deepEqual(killed, [
      [301, "SIGKILL"],
      [303, "SIGKILL"],
    ]);
    assert.equal(result.killed, 2);
    assert.equal(result.missing, 1);
  });

  it("findProcessesByCommandLine matches substring patterns", () => {
    const result = findProcessesByCommandLine(["wt-alpha", /gbrain serve/], {
      isWindows: true,
      spawnSyncFn: mockSpawnSync({ processRecords: SWARM_PROCS }),
    });

    assert.deepEqual(
      result.map((p) => p.pid),
      [310, 311, 314, 316, 317],
    );
  });

  it("cleanupShardProcesses scopes by worktreePath", () => {
    const killed = [];
    const result = cleanupShardProcesses({
      worktreePath: "C:\\repo\\.codex-swarm\\wt-alpha",
      sessionIds: ["session-1"],
      topPids: [],
      runId: "run-1",
      shardName: "alpha",
      isWindows: true,
      spawnSyncFn: mockSpawnSync({ processRecords: SWARM_PROCS }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.scanned, SWARM_PROCS.length);
    assert.equal(result.killed, 5);
    assert.equal(result.byCategory.node, 1);
    assert.equal(result.byCategory.bash, 1);
    assert.equal(result.byCategory.conhost, 1);
    assert.equal(result.byCategory.bun, 1);
    assert.equal(result.byCategory.git, 1);
    assert.ok(killed.every(([pid]) => pid !== 312));
    assert.ok(killed.every(([pid]) => pid !== 314));
    assert.ok(killed.every(([pid]) => pid !== 315));
  });

  it("cleanupShardProcesses skips protected PIDs", () => {
    const killed = [];
    const result = cleanupShardProcesses({
      worktreePath: "C:\\repo\\.codex-swarm\\wt-alpha",
      sessionIds: ["session-1"],
      topPids: [],
      runId: "run-1",
      shardName: "alpha",
      isWindows: true,
      spawnSyncFn: mockSpawnSync({ processRecords: SWARM_PROCS }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set([310]),
    });

    assert.equal(result.skipped, 1);
    assert.ok(killed.every(([pid]) => pid !== 310));
  });

  it("cleanupShardProcesses dryRun=true kills nothing", () => {
    const killed = [];
    const result = cleanupShardProcesses({
      worktreePath: "C:\\repo\\.codex-swarm\\wt-alpha",
      sessionIds: ["session-1"],
      topPids: [],
      runId: "run-1",
      shardName: "alpha",
      dryRun: true,
      isWindows: true,
      spawnSyncFn: mockSpawnSync({ processRecords: SWARM_PROCS }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 0);
    assert.equal(result.byCategory.bun, 1);
    assert.deepEqual(killed, []);
  });

  it("legacy cleanupOrphanNodeProcesses uses ancestor-chain orphan scope", () => {
    const killed = [];
    const result = cleanupOrphanNodeProcesses({
      isWindows: true,
      spawnSyncFn: mockSpawnSync({
        processRecords: [
          {
            ProcessId: 410,
            ParentProcessId: 999991,
            Name: "node.exe",
            CommandLine: "node C:\\tmp\\mcp-server.js",
          },
          {
            ProcessId: 411,
            ParentProcessId: 999992,
            Name: "bash.exe",
            CommandLine: "bash -lc worker",
          },
          {
            ProcessId: 412,
            ParentProcessId: 999993,
            Name: "cmd.exe",
            CommandLine: "cmd.exe /c worker",
          },
          {
            ProcessId: 413,
            ParentProcessId: 999994,
            Name: "uvx.exe",
            CommandLine: "uvx mcp-server",
          },
          {
            ProcessId: 414,
            ParentProcessId: 999995,
            Name: "codex.exe",
            CommandLine: "codex exec",
          },
          {
            ProcessId: 415,
            ParentProcessId: 999996,
            Name: "claude.exe",
            CommandLine: "claude --mcp",
          },
          {
            ProcessId: 418,
            ParentProcessId: 415,
            Name: "node.exe",
            CommandLine: "node claude-mcp-server.js",
          },
          {
            ProcessId: 416,
            ParentProcessId: 417,
            Name: "node.exe",
            CommandLine: "node live-child.js",
          },
          {
            ProcessId: 417,
            ParentProcessId: process.pid,
            Name: "pwsh.exe",
            CommandLine: "pwsh",
          },
        ],
      }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 4);
    assert.deepEqual(
      killed.map(([pid]) => pid),
      [410, 411, 412, 413],
    );
    assert.ok(killed.every(([, signal]) => signal === "SIGKILL"));
  });

  it("legacy cleanupOrphanNodeProcesses never kills live Claude/Codex session roots", () => {
    const killed = [];
    const result = cleanupOrphanNodeProcesses({
      isWindows: true,
      spawnSyncFn: mockSpawnSync({
        processRecords: [
          {
            ProcessId: 510,
            ParentProcessId: 999991,
            Name: "claude.exe",
            CommandLine: "claude",
          },
          {
            ProcessId: 511,
            ParentProcessId: 510,
            Name: "node.exe",
            CommandLine: "node claude-mcp-server.js",
          },
          {
            ProcessId: 512,
            ParentProcessId: 999992,
            Name: "codex.exe",
            CommandLine: "codex",
          },
          {
            ProcessId: 513,
            ParentProcessId: 512,
            Name: "node.exe",
            CommandLine: "node codex-mcp-server.js",
          },
        ],
      }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 0);
    assert.deepEqual(killed, []);
  });

  it("legacy cleanupOrphanNodeProcesses never kills node wrappers with live Claude/Codex children", () => {
    const killed = [];
    const result = cleanupOrphanNodeProcesses({
      isWindows: true,
      spawnSyncFn: mockSpawnSync({
        processRecords: [
          {
            ProcessId: 520,
            ParentProcessId: 999991,
            Name: "node.exe",
            CommandLine:
              "node C:\\Users\\tellang\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js resume --last",
          },
          {
            ProcessId: 521,
            ParentProcessId: 520,
            Name: "codex.exe",
            CommandLine: "codex resume --last",
          },
          {
            ProcessId: 522,
            ParentProcessId: 999992,
            Name: "node.exe",
            CommandLine:
              "node C:\\Users\\tellang\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume",
          },
          {
            ProcessId: 523,
            ParentProcessId: 522,
            Name: "claude.exe",
            CommandLine: "claude --resume",
          },
        ],
      }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 0);
    assert.deepEqual(killed, []);
  });

  it("cleanupOrphanRuntimeProcesses includes bun.exe", () => {
    const killed = [];
    const result = cleanupOrphanRuntimeProcesses({
      isWindows: true,
      spawnSyncFn: mockSpawnSync({ processRecords: SWARM_PROCS }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 1);
    assert.deepEqual(killed, [[314, "SIGKILL"]]);
  });

  it("cleanupOrphanRuntimeProcesses kills orphaned bun gbrain cli.ts serve duplicates", () => {
    const killed = [];
    const result = cleanupOrphanRuntimeProcesses({
      isWindows: true,
      spawnSyncFn: mockSpawnSync({
        processRecords: [
          {
            ProcessId: 610,
            ParentProcessId: 999991,
            Name: "bun.exe",
            CommandLine:
              'bun "C:\\Users\\tellang\\.bun\\install\\global\\node_modules\\gbrain\\src\\cli.ts" serve',
          },
        ],
      }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 1);
    assert.deepEqual(killed, [[610, "SIGKILL"]]);
  });

  it("cleanupOrphanRuntimeProcesses preserves bun gbrain serve under live Claude", () => {
    const killed = [];
    const result = cleanupOrphanRuntimeProcesses({
      isWindows: true,
      spawnSyncFn: mockSpawnSync({
        processRecords: [
          {
            ProcessId: 620,
            ParentProcessId: 1,
            Name: "claude.exe",
            CommandLine: "claude --resume",
          },
          {
            ProcessId: 621,
            ParentProcessId: 620,
            Name: "gbrain.exe",
            CommandLine: "gbrain serve",
          },
          {
            ProcessId: 622,
            ParentProcessId: 621,
            Name: "bun.exe",
            CommandLine:
              'bun "C:\\Users\\tellang\\.bun\\install\\global\\node_modules\\gbrain\\src\\cli.ts" serve',
          },
        ],
      }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 0);
    assert.deepEqual(killed, []);
  });

  it("legacy cleanupOrphanNodeProcesses wrapper still works", () => {
    const killed = [];
    const result = cleanupOrphanNodeProcesses({
      isWindows: true,
      spawnSyncFn: mockSpawnSync({ processRecords: SWARM_PROCS }),
      killFn: (pid, signal) => killed.push([pid, signal]),
      protectedPids: new Set(),
    });

    assert.equal(result.killed, 3);
    assert.deepEqual(killed, [
      [310, "SIGKILL"],
      [311, "SIGKILL"],
      [312, "SIGKILL"],
    ]);
  });
});
