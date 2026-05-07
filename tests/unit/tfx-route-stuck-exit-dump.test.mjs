import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = "scripts/tfx-route.sh";

describe("tfx-route stuck-exit STDOUT_LOG dump (PR #225 pattern)", () => {
  it("emits STDOUT_LOG content via EXIT trap when main never reached the normal dump", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-stuck-dump-"));
    const stdoutLog = join(dir, "stdout.log");
    const codexOutput =
      "수정, 커밋, push, PR 생성까지 완료했습니다.\n" +
      "PR: https://github.com/tellang/triflux/pull/225\n" +
      "Branch: fix/208-opus-pricing\n";
    writeFileSync(stdoutLog, codexOutput);

    const res = spawnSync(
      "bash",
      [SCRIPT, "--inert-self-test", "stuck-exit-dump", stdoutLog],
      {
        encoding: "utf-8",
        timeout: 10_000,
      },
    );

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}`);
    assert.ok(
      (res.stdout || "").includes("Branch: fix/208-opus-pricing"),
      `expected stdout to include codex output, got ${JSON.stringify(res.stdout)}`,
    );
    assert.match(
      res.stderr || "",
      /\[tfx-route\] EMERGENCY STDOUT DUMP wrapper main never reached normal dump \(\d+B/,
      `expected EMERGENCY marker on stderr, got ${JSON.stringify(res.stderr)}`,
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT double-emit when main flow already set _TFX_STDOUT_DUMPED=1", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-stuck-dump-"));
    const stdoutLog = join(dir, "stdout.log");
    writeFileSync(stdoutLog, "this content must not appear in stdout\n");

    const res = spawnSync(
      "bash",
      [SCRIPT, "--inert-self-test", "normal-exit-no-dump", stdoutLog],
      {
        encoding: "utf-8",
        timeout: 10_000,
      },
    );

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}`);
    assert.equal(
      res.stdout || "",
      "",
      `expected empty stdout, got ${JSON.stringify(res.stdout)}`,
    );
    assert.ok(
      !(res.stderr || "").includes("EMERGENCY STDOUT DUMP"),
      `expected no EMERGENCY marker, got ${JSON.stringify(res.stderr)}`,
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT emit when STDOUT_LOG is empty even if main never dumped", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-stuck-dump-"));
    const stdoutLog = join(dir, "stdout.log");
    writeFileSync(stdoutLog, "");

    const res = spawnSync(
      "bash",
      [SCRIPT, "--inert-self-test", "stuck-exit-dump", stdoutLog],
      {
        encoding: "utf-8",
        timeout: 10_000,
      },
    );

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}`);
    assert.equal(
      res.stdout || "",
      "",
      `expected empty stdout for empty STDOUT_LOG, got ${JSON.stringify(res.stdout)}`,
    );
    assert.ok(
      !(res.stderr || "").includes("EMERGENCY STDOUT DUMP"),
      `expected no EMERGENCY marker for empty file, got ${JSON.stringify(res.stderr)}`,
    );

    rmSync(dir, { recursive: true, force: true });
  });
});
