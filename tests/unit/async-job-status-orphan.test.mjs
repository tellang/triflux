import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/tfx-route.sh";

describe("--job-status orphan-running classification", () => {
  it("reports orphan-running when wrapper pid is dead but child_pids file lists a live process", () => {
    const jobsDir = mkdtempSync(join(tmpdir(), "tfx-async-orphan-"));
    const jobId = "test-orphan-1";
    const jobDir = join(jobsDir, jobId);
    mkdirSync(jobDir, { recursive: true });

    // Simulate: wrapper pid dead (PID 99999 unlikely to exist), child sleep alive.
    writeFileSync(join(jobDir, "pid"), "99999");
    writeFileSync(join(jobDir, "agent_type"), "executor");
    writeFileSync(join(jobDir, "start_time"), String(Math.floor(Date.now() / 1000)));

    // Spawn a real sleep child whose PID we record.
    const sleepProc = spawnSync(
      "bash",
      ["-c", `sleep 30 & echo $! > "${join(jobDir, "child_pids")}"; disown; exit 0`],
      { encoding: "utf-8" },
    );

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

    // Cleanup: kill the sleep child.
    spawnSync("bash", ["-c", `pkill -P $$ sleep 2>/dev/null; true`]);
    rmSync(jobsDir, { recursive: true, force: true });
  });
});
