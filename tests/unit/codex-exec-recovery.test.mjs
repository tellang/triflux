import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = "scripts/lib/codex-recovery.sh";

function invokeRecovery(stderrContent) {
  const tmp = mkdtempSync(join(tmpdir(), "codex-exec-recovery-"));
  const stdoutLog = join(tmp, "stdout.log");
  const stderrLog = join(tmp, "stderr.log");
  writeFileSync(stdoutLog, "");
  writeFileSync(stderrLog, stderrContent);

  const res = spawnSync(
    "bash",
    [
      "-c",
      `source "${LIB}"; STDOUT_LOG="${stdoutLog}" STDERR_LOG="${stderrLog}" recover_codex_stdout`,
    ],
    { encoding: "utf-8" },
  );

  const stdout = readFileSync(stdoutLog, "utf-8");
  const stderr = res.stderr || "";
  rmSync(tmp, { recursive: true, force: true });
  return { stdout, stderr, exit: res.status };
}

describe("recover_codex_stdout", () => {
  it("function is sourceable and returns 0 on empty STDERR_LOG", () => {
    const res = invokeRecovery("");
    assert.equal(
      res.exit,
      0,
      `helper should exit 0 on empty stderr; got status=${res.exit}, stderr=${res.stderr}`,
    );
  });
});
