import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertTtyForSwarm, parseFlags } from "../../hub/team/swarm-cli.mjs";

describe("swarm-cli parseFlags — --base", () => {
  it("default baseBranch is 'main' when --base omitted", () => {
    const { flags, positional } = parseFlags(["docs/prd/foo.md"]);
    assert.equal(flags.baseBranch, "main");
    assert.deepEqual(positional, ["docs/prd/foo.md"]);
  });

  it("accepts '--base feat/foo'", () => {
    const { flags, positional } = parseFlags([
      "docs/prd/foo.md",
      "--base",
      "feat/foo",
    ]);
    assert.equal(flags.baseBranch, "feat/foo");
    assert.deepEqual(positional, ["docs/prd/foo.md"]);
  });

  it("throws when --base value is missing", () => {
    assert.throws(
      () => parseFlags(["docs/prd/foo.md", "--base"]),
      /--base requires a non-empty branch name/,
    );
  });

  it("throws when --base value contains whitespace", () => {
    assert.throws(
      () => parseFlags(["docs/prd/foo.md", "--base", "feat foo"]),
      /whitespace/,
    );
  });

  it("coexists with other flags (--dry-run + --filter + --base)", () => {
    const { flags, positional } = parseFlags([
      "docs/prd/bar.md",
      "--dry-run",
      "--filter",
      "shard-a",
      "--base",
      "release/v2",
    ]);
    assert.equal(flags.dryRun, true);
    assert.equal(flags.filter, "shard-a");
    assert.equal(flags.baseBranch, "release/v2");
    assert.deepEqual(positional, ["docs/prd/bar.md"]);
  });
});

describe("swarm-cli assertTtyForSwarm — #116-C non-TTY fail-fast", () => {
  it("passes when stdout is TTY", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: true,
      stdinIsTTY: false,
      env: {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.optIn, false);
    assert.deepEqual(result.warnings, []);
  });

  it("passes when stdin is TTY (e.g. piped stdout only)", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: true,
      env: {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  it("fails with #116-C guidance when both stdout and stdin are non-TTY", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.optIn, false);
    assert.match(result.reason, /#116-C/);
    assert.match(result.reason, /TFX_ALLOW_NON_TTY_SWARM=1/);
    assert.match(result.reason, /tmux/);
  });

  it("opts in with warning when TFX_ALLOW_NON_TTY_SWARM=1", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { TFX_ALLOW_NON_TTY_SWARM: "1" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.optIn, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /opt-in/);
  });

  it("does not opt in when TFX_ALLOW_NON_TTY_SWARM is set to other values", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { TFX_ALLOW_NON_TTY_SWARM: "true" },
    });
    assert.equal(result.ok, false);
  });
});
