import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/tfx-route.sh";

describe("--job-status orphan-running classification", () => {
  it("reports orphan-running when wrapper pid is dead but child_pids file lists a live process", () => {
    const jobsDir = mkdtempSync(join(tmpdir(), "tfx-async-orphan-"));
    const jobId = "test-orphan-1";
    const jobDir = join(jobsDir, jobId);
    mkdirSync(jobDir, { recursive: true });

    // Simulate: wrapper pid dead (PID 99999 unlikely to exist on default pid_max), child sleep alive.
    writeFileSync(join(jobDir, "pid"), "99999");
    writeFileSync(join(jobDir, "agent_type"), "executor");
    writeFileSync(join(jobDir, "start_time"), String(Math.floor(Date.now() / 1000)));

    // Spawn a real sleep child whose PID we record. sleep 30 is long enough for
    // the assertion below to fire; cleanup kills it directly by PID, not via pkill.
    //
    // Why script-file + nohup (not `bash -c "sleep 5 & echo $! > path; disown"`):
    //   1. Inline `bash -c` with Windows backslash paths gets escape-mangled by
    //      Git Bash → `child_pids` ends up empty (same flaw documented in
    //      `tfx-route-stall-kill.test.mjs:120-125`). Script file + cwd avoids it.
    //   2. On Windows MSYS, `disown` does not actually detach a child from the
    //      bash session — when the parent bash exits, the sleep child is reaped.
    //      `nohup` with stdio redirected to /dev/null does survive parent exit.
    const childPidsPath = join(jobDir, "child_pids");
    const spawnScriptPath = join(jobDir, "_spawn_child.sh");
    writeFileSync(
      spawnScriptPath,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "nohup sleep 30 >/dev/null 2>&1 &",
        'echo "$!" > child_pids',
        "disown",
        "exit 0",
        "",
      ].join("\n"),
    );
    spawnSync("bash", [spawnScriptPath], {
      encoding: "utf-8",
      cwd: jobDir,
    });

    const res = spawnSync(
      "bash",
      [SCRIPT, "--job-status", jobId],
      { encoding: "utf-8", env: { ...process.env, TFX_JOBS_DIR: jobsDir }, timeout: 5_000 },
    );

    const out = (res.stdout || "").trim();
    assert.match(
      out,
      /^orphan-running pid=\d+/,
      `expected 'orphan-running pid=...', got ${JSON.stringify(out)}`,
    );

    // Cleanup: kill the recorded child PID directly (cross-platform).
    try {
      const pid = Number(readFileSync(childPidsPath, "utf-8").trim());
      if (pid > 0) process.kill(pid);
    } catch {
      // child may have already exited or PID file unreadable — ignore
    }
    rmSync(jobsDir, { recursive: true, force: true });
  });
});
