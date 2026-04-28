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

  it("1차 codex marker: extracts content after last 'codex' line", () => {
    const { stdout, stderr, exit } = invokeWithFixture("path1-codex-marker.stderr.log");
    assert.equal(exit, 0);
    assert.match(
      stdout,
      /This is the actual response content from path 1/,
      "1차 should preserve real response content",
    );
    assert.match(stdout, /And ends here without tokens marker/);
    assert.doesNotMatch(
      stdout,
      /^OpenAI Codex/m,
      "header before 'codex' marker must not leak into stdout",
    );
    assert.doesNotMatch(
      stdout,
      /^workdir:/m,
      "header before 'codex' marker must not leak into stdout",
    );
    assert.ok(
      stderr.includes(RECOVERED_MARKER),
      `expected '복구' marker; stderr=${stderr}`,
    );
  });

  it("2차 node parser: filters skip patterns when codex marker absent", () => {
    const { stdout, stderr, exit } = invokeWithFixture("path2-node-parser.stderr.log");
    assert.equal(exit, 0);
    assert.match(
      stdout,
      /This is the path 2 response content extracted by node parser/,
      "2차 should preserve content lines that don't match skip regex",
    );
    assert.match(stdout, /It survives the skip filter/);
    assert.doesNotMatch(stdout, /^mcp:/m, "skip regex must drop mcp: lines");
    assert.doesNotMatch(stdout, /^workdir:/m, "skip regex must drop workdir: lines");
    assert.doesNotMatch(stdout, /^tokens used/m, "skip regex must drop tokens used line");
    assert.doesNotMatch(stdout, /^EXIT:/m, "skip regex must drop EXIT: line");
    assert.ok(
      stderr.includes(RECOVERED_MARKER),
      `expected '복구' marker; stderr=${stderr}`,
    );
  });

  it("3차 stderr tail: dumps everything before 'tokens used' when 1·2차 fail", () => {
    const { stdout, stderr, exit } = invokeWithFixture("path3-stderr-tail.stderr.log");
    assert.equal(exit, 0);
    // 3차 dumps lines that 2차 would have filtered, distinguishing it from 2차.
    assert.match(stdout, /^mcp: connected/m, "3차 retains mcp: line that 2차 would filter");
    assert.match(stdout, /^workdir:/m, "3차 retains workdir: line that 2차 would filter");
    assert.match(stdout, /^reasoning high/m, "3차 retains reasoning line");
    assert.doesNotMatch(
      stdout,
      /^tokens used/m,
      "3차 awk exits at 'tokens used' before buffering it",
    );
    assert.ok(
      stderr.includes(RECOVERED_MARKER),
      `expected '복구' marker; stderr=${stderr}`,
    );
  });
});
