import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createProcessCleanup,
  forceKillPid,
} from "../../hub/team/process-cleanup.mjs";

function cimProc(overrides = {}) {
  return {
    ProcessId: 4321,
    Name: "node.exe",
    ParentProcessId: 99999,
    CommandLine: 'node -e "setInterval(()=>{},1000)" // oh-my-codex/dist/mcp',
    WorkingSetSize: 25 * 1024 * 1024,
    ...overrides,
  };
}

function makeMockExecFile(procs) {
  return async (cmd, args) => {
    const cmdStr = Array.isArray(args) ? args.join(" ") : String(args);

    if (cmdStr.includes("Win32_Process") && cmdStr.includes("ConvertTo-Json")) {
      return { stdout: JSON.stringify(procs), stderr: "" };
    }

    if (cmdStr.includes("Win32_Process") && cmdStr.includes("CreationDate")) {
      return {
        stdout: new Date(Date.now() - 5_000).toISOString(),
        stderr: "",
      };
    }

    if (cmd === "ps" && cmdStr.includes("pid=")) {
      const lines = procs.map((p) => {
        const pid = p.ProcessId || 0;
        const ppid = p.ParentProcessId || 0;
        const rss = Math.round((p.WorkingSetSize || 0) / 1024);
        const name = (p.Name || "").replace(/\.exe$/i, "");
        const cmdLine = p.CommandLine || "";
        return `${pid} ${ppid} ${rss} ${name} ${cmdLine}`;
      });
      return { stdout: lines.join("\n"), stderr: "" };
    }

    if (cmd === "psmux") {
      throw new Error("psmux: command not found");
    }

    return { stdout: "", stderr: "" };
  };
}

describe("process-cleanup Windows tree termination", () => {
  it("forceKillPid는 Windows에서 taskkill /T /F /PID를 사용한다", () => {
    const taskkillCalls = [];

    forceKillPid(4321, {
      isWindows: true,
      execFileSyncFn: (file, args, options) => {
        taskkillCalls.push({ file, args: [...args], options });
        return "";
      },
      killFn: () => {
        throw new Error("fallback should not be used");
      },
    });

    assert.equal(taskkillCalls.length, 1);
    assert.equal(taskkillCalls[0].file, "taskkill");
    assert.deepEqual(taskkillCalls[0].args, ["/F", "/T", "/PID", "4321"]);
    assert.equal(taskkillCalls[0].options.windowsHide, true);
  });

  it("createProcessCleanup.kill은 Windows orphan 정리 시 taskkill /T로 트리 종료를 에스컬레이션한다", async () => {
    const taskkillCalls = [];
    const killCalls = [];
    const alivePids = new Set([4321]);

    const cleanup = createProcessCleanup({
      execFileFn: makeMockExecFile([cimProc({ ProcessId: 4321 })]),
      skipPsmuxCheck: true,
      isWindows: true,
      sleepFn: async () => {},
      execFileSyncFn: (file, args, options) => {
        taskkillCalls.push({ file, args: [...args], options });
        alivePids.delete(4321);
        return "";
      },
      killFn: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 0) {
          if (alivePids.has(pid)) return true;
          const err = new Error("ESRCH");
          err.code = "ESRCH";
          throw err;
        }
        return true;
      },
    });

    const found = await cleanup.scan();
    assert.equal(found.length, 1);

    const result = await cleanup.kill();
    assert.equal(result.length, 1);
    assert.equal(result[0].killed, true);

    assert.deepEqual(
      killCalls.map(({ pid, signal }) => ({ pid, signal })),
      [
        { pid: 4321, signal: "SIGTERM" },
        { pid: 4321, signal: 0 },
      ],
    );
    assert.equal(taskkillCalls.length, 1);
    assert.deepEqual(taskkillCalls[0].args, ["/F", "/T", "/PID", "4321"]);
  });
});
