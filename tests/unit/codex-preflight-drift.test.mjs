import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { detectWorkdirDrift } from "../../hub/codex-preflight.mjs";

const tempDirs = [];

function makeWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-drift-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("detectWorkdirDrift — workdir config drift detection (#116-D)", () => {
  it("returns no warnings when workdir is falsy", () => {
    const result = detectWorkdirDrift(undefined, "");
    assert.deepEqual(result, { warnings: [] });
  });

  it("returns no warnings when no .codex/config.toml and both AGENTS.md/CLAUDE.md absent", () => {
    const workdir = makeWorkdir();
    const result = detectWorkdirDrift(workdir, 'approval_policy = "never"\n');
    assert.deepEqual(result, { warnings: [] });
  });

  it("warns when local .codex/config.toml overrides approval_policy", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, ".codex"), { recursive: true });
    writeFileSync(
      join(workdir, ".codex", "config.toml"),
      'approval_policy = "on-request"\n',
    );
    const result = detectWorkdirDrift(workdir, 'approval_policy = "never"\n');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /approval_policy='on-request'/u);
    assert.match(result.warnings[0], /global='never'/u);
  });

  it("warns when local sandbox_mode differs from global", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, ".codex"), { recursive: true });
    writeFileSync(
      join(workdir, ".codex", "config.toml"),
      'sandbox_mode = "read-only"\n',
    );
    const result = detectWorkdirDrift(
      workdir,
      'sandbox_mode = "workspace-write"\n',
    );
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /sandbox_mode='read-only'/u);
  });

  it("warns for each differing key separately", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, ".codex"), { recursive: true });
    writeFileSync(
      join(workdir, ".codex", "config.toml"),
      [
        'approval_policy = "on-request"',
        'sandbox_mode = "read-only"',
        'model = "gpt-5-mini"',
      ].join("\n"),
    );
    const result = detectWorkdirDrift(
      workdir,
      [
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        'model = "gpt-5"',
      ].join("\n"),
    );
    assert.equal(result.warnings.length, 3);
    const joined = result.warnings.join("\n");
    assert.match(joined, /approval_policy/u);
    assert.match(joined, /sandbox_mode/u);
    assert.match(joined, /model/u);
  });

  it("does not warn when local and global agree on value", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, ".codex"), { recursive: true });
    writeFileSync(
      join(workdir, ".codex", "config.toml"),
      'approval_policy = "never"\n',
    );
    const result = detectWorkdirDrift(workdir, 'approval_policy = "never"\n');
    assert.deepEqual(result, { warnings: [] });
  });

  it("warns when AGENTS.md present but CLAUDE.md absent", () => {
    const workdir = makeWorkdir();
    writeFileSync(join(workdir, "AGENTS.md"), "# agents\n");
    const result = detectWorkdirDrift(workdir, "");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /AGENTS\.md/u);
    assert.match(result.warnings[0], /CLAUDE\.md/u);
  });

  it("warns when CLAUDE.md present but AGENTS.md absent", () => {
    const workdir = makeWorkdir();
    writeFileSync(join(workdir, "CLAUDE.md"), "# claude\n");
    const result = detectWorkdirDrift(workdir, "");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /CLAUDE\.md but not AGENTS\.md/u);
  });

  it("does not warn when both AGENTS.md and CLAUDE.md are present", () => {
    const workdir = makeWorkdir();
    writeFileSync(join(workdir, "AGENTS.md"), "# agents\n");
    writeFileSync(join(workdir, "CLAUDE.md"), "# claude\n");
    const result = detectWorkdirDrift(workdir, "");
    assert.deepEqual(result, { warnings: [] });
  });

  it("combines config drift + instruction-file asymmetry in one result", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, ".codex"), { recursive: true });
    writeFileSync(
      join(workdir, ".codex", "config.toml"),
      'approval_policy = "on-request"\n',
    );
    writeFileSync(join(workdir, "AGENTS.md"), "# agents\n");
    const result = detectWorkdirDrift(workdir, 'approval_policy = "never"\n');
    assert.equal(result.warnings.length, 2);
    const joined = result.warnings.join("\n");
    assert.match(joined, /approval_policy/u);
    assert.match(joined, /AGENTS\.md/u);
  });
});
