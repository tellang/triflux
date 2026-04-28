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

const FIXTURE_DIR = "tests/fixtures/codex-exec-recovery";

function loadFixture(name) {
  return readFileSync(`${FIXTURE_DIR}/${name}`, "utf-8");
}

function invokeWithFixture(name) {
  return invokeRecovery(loadFixture(name));
}

const RECOVERED_MARKER = "stderr에서 응답 복구";
const FALLBACK_FAILED_MARKER = "FALLBACK_FAILED stderr_log=";

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
