import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertTtyForSwarm,
  cmdSwarmRun,
  formatIntegrationReport,
  parseFlags,
} from "../../hub/team/swarm-cli.mjs";

describe("swarm-cli parseFlags — --base", () => {
  it("default baseBranch is 'main' when --base omitted", () => {
    const { flags, positional } = parseFlags(["docs/prd/foo.md"]);
    assert.equal(flags.baseBranch, "main");
    assert.equal(flags.nativeBridge, true);
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

  it("parseFlags accepts --no-native-bridge-ui and rejects conflicting native bridge flags", () => {
    const { flags, positional } = parseFlags([
      "docs/prd/native-bridge.md",
      "--no-native-bridge-ui",
      "--unknown-flag",
    ]);

    assert.equal(flags.nativeBridge, false);
    assert.deepEqual(positional, ["docs/prd/native-bridge.md"]);
    assert.throws(
      () =>
        parseFlags([
          "docs/prd/native-bridge.md",
          "--native-bridge-ui",
          "--no-native-bridge-ui",
        ]),
      /conflicting native bridge flags/,
    );
  });
});

describe("swarm-cli assertTtyForSwarm — #116-C non-TTY policy (v10.15+: warn-and-proceed)", () => {
  it("passes silently when stdout is TTY", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: true,
      stdinIsTTY: false,
      env: {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.optIn, false);
    assert.deepEqual(result.warnings, []);
  });

  it("passes silently when stdin is TTY (e.g. piped stdout only)", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: true,
      env: {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  it("proceeds with warning when both stdout and stdin are non-TTY (default)", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.optIn, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /#116-C/);
    assert.match(result.warnings[0], /TFX_BLOCK_NON_TTY_SWARM=1/);
  });

  it("opts in silently when TFX_ALLOW_NON_TTY_SWARM=1 (compat — warning suppressed)", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { TFX_ALLOW_NON_TTY_SWARM: "1" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.optIn, true);
    assert.deepEqual(result.warnings, []);
  });

  it("still proceeds with default warning when TFX_ALLOW_NON_TTY_SWARM is non-'1'", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { TFX_ALLOW_NON_TTY_SWARM: "true" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.optIn, true);
    assert.equal(result.warnings.length, 1);
  });

  it("fails-fast with #116-C reason when TFX_BLOCK_NON_TTY_SWARM=1 opt-out", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { TFX_BLOCK_NON_TTY_SWARM: "1" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.optIn, false);
    assert.match(result.reason, /#116-C/);
    assert.match(result.reason, /TFX_BLOCK_NON_TTY_SWARM=1/);
  });

  it("opt-out takes precedence over opt-in (BLOCK wins over ALLOW)", () => {
    const result = assertTtyForSwarm({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { TFX_BLOCK_NON_TTY_SWARM: "1", TFX_ALLOW_NON_TTY_SWARM: "1" },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /TFX_BLOCK_NON_TTY_SWARM=1/);
  });
});

describe("swarm-cli integration report", () => {
  it("renders explicit strategy, final sha, notes, and recovery count", () => {
    const report = formatIntegrationReport([
      {
        shard: "shard-1",
        strategy: "auto-ff",
        commits: 3,
        finalSha: "a1b2c3d4",
        notes: "linear (merge --ff-only)",
      },
      {
        shard: "shard-2",
        strategy: "cherry-pick",
        commits: 2,
        finalSha: "e4f5g6h7",
        notes: "auto-ff failed: diverged",
      },
      {
        shard: "shard-3",
        strategy: "failed",
        commits: null,
        finalSha: null,
        notes: "conflict in pkg.json",
        recoveryPatch: ".codex-swarm/recovery/shard-3.patch",
      },
    ]);

    assert.match(report, /=== INTEGRATION REPORT ===/u);
    assert.match(report, /shard-1\s+auto-ff\s+3\s+a1b2c3/u);
    assert.match(report, /shard-2\s+cherry-pick\s+2\s+e4f5g6/u);
    assert.match(
      report,
      /shard-3\s+failed\s+-\s+-\s+conflict in pkg\.json; recovery: \.codex-swarm\/recovery\/shard-3\.patch/u,
    );
    assert.match(report, /TOTAL: 2\/3 integrated, 1 recovery patch saved\./u);
  });
});

describe("swarm-cli run preflight gate", () => {
  it("blocks before hypervisor creation when preflight is no-go", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = process.cwd();
    const previousExitCode = process.exitCode;
    const previousStderrWrite = process.stderr.write;
    const tmp = mkdtempSync(join(tmpdir(), `tfx-swarm-cli-${process.pid}-`));
    const prdPath = join(tmp, "prd.md");
    writeFileSync(prdPath, "# PRD\n", "utf8");
    let stderr = "";

    process.exitCode = undefined;
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) callback();
      return true;
    };

    try {
      process.chdir(tmp);
      await cmdSwarmRun([prdPath], {
        deps: {
          runSwarmPreflight: () => ({
            ok: false,
            verdict: "no-go",
            prdPath,
            repoRoot: tmp,
            checks: { plan: { ok: true }, leases: { ok: false } },
            errors: ["blocked before launch"],
            warnings: [],
            plan: { totalShards: 1 },
            leaseTable: [],
          }),
          createSwarmHypervisor: () => {
            throw new Error("hypervisor should not be created");
          },
        },
      });
    } finally {
      process.chdir(cwd);
      process.stderr.write = previousStderrWrite;
      process.exitCode = previousExitCode;
    }

    assert.match(stderr, /SWARM PREFLIGHT: NO-GO/u);
    assert.match(stderr, /blocked before launch/u);
  });
});
