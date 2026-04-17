import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseFlags } from "../../hub/team/swarm-cli.mjs";

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
