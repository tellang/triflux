import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const HOOK = join(process.cwd(), "hooks", "cto-north-star-brief.mjs");

function runHook(payload, cwd = process.cwd(), env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function parseOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "expected hook JSON on stdout");
  return JSON.parse(result.stdout);
}

describe("cto-north-star-brief hook", () => {
  let sandboxDir;
  let markerPath;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-cto-brief-"));
    markerPath = join(sandboxDir, "last-injected-marker");
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("emits UserPromptSubmit additionalContext when the lake brief changed", () => {
    const lakeDir = join(sandboxDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(
      join(lakeDir, "current.md"),
      "# CTO North Star\n\nShip the brief hook.",
      "utf8",
    );

    const result = runHook(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: sandboxDir,
      },
      process.cwd(),
      { TRIFLUX_CTO_BRIEF_MARKER: markerPath },
    );

    const output = parseOutput(result);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(
      output.hookSpecificOutput.additionalContext,
      "[CTO NORTH STAR]\n# CTO North Star\n\nShip the brief hook.",
    );
  });

  it("emits nothing on a second run when the lake brief is unchanged", () => {
    const lakeDir = join(sandboxDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(join(lakeDir, "current.md"), "stable brief", "utf8");
    const payload = {
      hook_event_name: "UserPromptSubmit",
      cwd: sandboxDir,
    };
    const env = { TRIFLUX_CTO_BRIEF_MARKER: markerPath };

    const first = runHook(payload, process.cwd(), env);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stdout.trim(), "first run should inject the brief");

    const second = runHook(payload, process.cwd(), env);

    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, "");
  });

  it("is a silent no-op when the current lake brief is missing", () => {
    const result = runHook(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: sandboxDir,
      },
      process.cwd(),
      { TRIFLUX_CTO_BRIEF_MARKER: markerPath },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("caps injected north-star context to 2KB including the prefix", () => {
    const lakeDir = join(sandboxDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(join(lakeDir, "current.md"), "x".repeat(3000), "utf8");

    const result = runHook(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: sandboxDir,
      },
      process.cwd(),
      { TRIFLUX_CTO_BRIEF_MARKER: markerPath },
    );

    const output = parseOutput(result);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(Buffer.byteLength(context, "utf8"), 2048);
    assert.match(context, /^\[CTO NORTH STAR\]\n/);
  });
});
