import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  formatPreflightReport,
  runSwarmPreflight,
} from "../../hub/team/swarm-preflight.mjs";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), `tfx-swarm-preflight-${process.pid}-`));
}

function writePrd(dir, content) {
  const path = join(dir, "prd.md");
  writeFileSync(path, content, "utf8");
  return path;
}

const OK_PRD = `
# OK PRD

## Shard: api
- agent: codex
- files: src/api.mjs
- mcp: context7
- prompt: Implement API.

## Shard: docs
- agent: gemini
- files: docs/api.md
- depends: api
- prompt: Document API.
`;

describe("swarm-preflight", () => {
  it("returns GO with a lease table for a valid PRD", () => {
    const repoRoot = makeTmpDir();
    const prdPath = writePrd(repoRoot, OK_PRD);
    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => "/usr/bin/true" },
    });

    assert.equal(report.ok, true);
    assert.equal(report.verdict, "go");
    assert.equal(report.plan.totalShards, 2);
    assert.equal(report.leaseTable.length, 2);
    assert.match(report.leaseTable[0].worktreePath, /\.codex-swarm\/wt-api$/u);
  });

  it("returns NO-GO for lease conflicts", () => {
    const repoRoot = makeTmpDir();
    const prdPath = writePrd(
      repoRoot,
      `
## Shard: a
- agent: codex
- files: shared.mjs
- prompt: A.

## Shard: b
- agent: gemini
- files: shared.mjs
- prompt: B.
`,
    );
    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => "/usr/bin/true" },
    });

    assert.equal(report.ok, false);
    assert.equal(report.verdict, "no-go");
    assert.deepEqual(report.checks.leases.conflicts[0], {
      file: "shared.mjs",
      shards: ["a", "b"],
    });
    assert.match(report.errors.join("\n"), /lease conflict/u);
  });

  it("returns NO-GO for explicit missing hosts", () => {
    const repoRoot = makeTmpDir();
    const prdPath = writePrd(
      repoRoot,
      `
## Shard: remote
- agent: codex
- host: missing-host
- files: src/remote.mjs
- prompt: Run remotely.
`,
    );
    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => "/usr/bin/true" },
    });

    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.hosts.missing, [
      { shard: "remote", host: "missing-host" },
    ]);
  });

  it("returns NO-GO for missing local worker CLI", () => {
    const repoRoot = makeTmpDir();
    const prdPath = writePrd(repoRoot, OK_PRD);
    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => null },
    });

    assert.equal(report.ok, false);
    assert.match(report.errors.join("\n"), /missing local worker CLI/u);
  });

  it("warns, but does not block, explicitly leased sensitive files", () => {
    const repoRoot = makeTmpDir();
    const prdPath = writePrd(
      repoRoot,
      `
## Shard: cli
- agent: codex
- files: bin/triflux.mjs
- prompt: Update CLI.
`,
    );
    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => "/usr/bin/true" },
    });

    assert.equal(report.ok, true);
    assert.match(report.warnings.join("\n"), /sensitive path planned lease/u);
  });

  it("reports MCP incompatibilities as blocking", () => {
    const repoRoot = makeTmpDir();
    const prdPath = writePrd(
      repoRoot,
      `
## Shard: research
- agent: codex
- files: notes.md
- mcp: tavily
- prompt: Research.
`,
    );
    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => "/usr/bin/true" },
    });

    assert.equal(report.ok, false);
    assert.match(report.errors.join("\n"), /MCP incompatibility/u);
  });

  it("formats human-readable verdict and blocking errors", () => {
    const output = formatPreflightReport({
      verdict: "no-go",
      prdPath: "/tmp/prd.md",
      plan: { totalShards: 0 },
      leaseTable: [],
      checks: { plan: { ok: false } },
      errors: ["bad PRD"],
      warnings: [],
    });

    assert.match(output, /^SWARM PREFLIGHT: NO-GO/u);
    assert.match(output, /Blocking errors:\n {2}- bad PRD/u);
  });
});
