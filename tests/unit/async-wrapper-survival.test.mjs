import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/tfx-route.sh";

function dispatchAsyncJob(jobsDir) {
  const res = spawnSync(
    "bash",
    [SCRIPT, "--async-self-test", "wrapper-sleep-3"],
    { encoding: "utf-8", env: { ...process.env, TFX_JOBS_DIR: jobsDir }, timeout: 5_000 },
  );
  return (res.stdout || "").trim();
}

describe("async wrapper survives parent shell exit (POSIX)", () => {
  it("writes done + exit_code markers after parent script exits and bg subshell completes", async () => {
    const jobsDir = mkdtempSync(join(tmpdir(), "tfx-async-survival-"));
    const jobId = dispatchAsyncJob(jobsDir);
    assert.ok(jobId, `expected job_id, got empty`);

    const jobDir = join(jobsDir, jobId);
    const pidPath = join(jobDir, "pid");
    assert.ok(existsSync(pidPath), `expected pid file at ${pidPath}`);

    // Wait for the bg subshell to complete sleep + trap fire (3s sleep + margin).
    await new Promise((r) => setTimeout(r, 4_500));

    const donePath = join(jobDir, "done");
    const exitCodePath = join(jobDir, "exit_code");

    assert.ok(
      existsSync(donePath),
      `expected done marker at ${donePath} after parent exit (current bug: missing because daemon wait $bg_pid POSIX-illegal returns rc=127 immediately)`,
    );
    assert.ok(
      existsSync(exitCodePath),
      `expected exit_code marker at ${exitCodePath}`,
    );
    const exitCode = readFileSync(exitCodePath, "utf-8").trim();
    assert.equal(exitCode, "0", `expected exit_code=0, got ${JSON.stringify(exitCode)}`);

    rmSync(jobsDir, { recursive: true, force: true });
  });
});
