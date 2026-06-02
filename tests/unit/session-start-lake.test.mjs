import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const HOOK = join(process.cwd(), "hooks", "session-start-lake.mjs");

function runHook(payload, cwd = process.cwd()) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function parseOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "expected hook JSON on stdout");
  return JSON.parse(result.stdout);
}

describe("session-start-lake hook", () => {
  let sandboxDir;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-session-lake-"));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("emits SessionStart additionalContext from the current lake brief", () => {
    const lakeDir = join(sandboxDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(
      join(lakeDir, "current.md"),
      "# CTO North Star\n\nShip the hook.",
      "utf8",
    );

    const result = runHook({
      hook_event_name: "SessionStart",
      cwd: sandboxDir,
    });

    const output = parseOutput(result);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /# CTO North Star/,
    );
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /Ship the hook\./,
    );
  });

  it("is a silent no-op when the current lake brief is missing", () => {
    const result = runHook({
      hook_event_name: "SessionStart",
      cwd: sandboxDir,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("caps injected lake context to 2KB", () => {
    const lakeDir = join(sandboxDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(join(lakeDir, "current.md"), "x".repeat(3000), "utf8");

    const result = runHook({
      hook_event_name: "SessionStart",
      cwd: sandboxDir,
    });

    const output = parseOutput(result);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(Buffer.byteLength(context, "utf8"), 2048);
    assert.equal(context, "x".repeat(2048));
  });
});
