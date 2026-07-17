import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  formatPreflightReport,
  runSwarmPreflight,
} from "../../hub/team/swarm-preflight.mjs";

function makeTmpDir() {
  const repoRoot = mkdtempSync(
    join(tmpdir(), `tfx-swarm-preflight-${process.pid}-`),
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "base"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Triflux Test",
      GIT_AUTHOR_EMAIL: "test@triflux.local",
      GIT_COMMITTER_NAME: "Triflux Test",
      GIT_COMMITTER_EMAIL: "test@triflux.local",
    },
  });
  return repoRoot;
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

  it("returns NO-GO with file names when tracked rootDir changes overlap leases", () => {
    const repoRoot = makeTmpDir();
    const leasedFile = join(repoRoot, "src", "api.mjs");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(leasedFile, "export const value = 1;\n");
    execFileSync("git", ["add", "src/api.mjs"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "add api"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Triflux Test",
        GIT_AUTHOR_EMAIL: "test@triflux.local",
        GIT_COMMITTER_NAME: "Triflux Test",
        GIT_COMMITTER_EMAIL: "test@triflux.local",
      },
    });
    writeFileSync(leasedFile, "export const value = 2;\n");
    const prdPath = writePrd(
      repoRoot,
      `
## Shard: api
- agent: codex
- files: src/api.mjs
- prompt: Update API.
`,
    );

    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => "/usr/bin/true" },
    });

    assert.equal(report.ok, false);
    assert.equal(report.verdict, "no-go");
    assert.deepEqual(report.checks.rootDirtyLease.overlappingFiles, [
      "src/api.mjs",
    ]);
    assert.match(report.errors.join("\n"), /src\/api\.mjs/u);
    assert.match(formatPreflightReport(report), /src\/api\.mjs/u);
  });

  it("keeps GO when tracked rootDir changes do not overlap leases", () => {
    const repoRoot = makeTmpDir();
    writeFileSync(join(repoRoot, "notes.md"), "base\n");
    execFileSync("git", ["add", "notes.md"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "add notes"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Triflux Test",
        GIT_AUTHOR_EMAIL: "test@triflux.local",
        GIT_COMMITTER_NAME: "Triflux Test",
        GIT_COMMITTER_EMAIL: "test@triflux.local",
      },
    });
    writeFileSync(join(repoRoot, "notes.md"), "dirty but unrelated\n");
    const prdPath = writePrd(
      repoRoot,
      `
## Shard: api
- agent: codex
- files: src/api.mjs
- prompt: Update API.
`,
    );

    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: { whichCommand: () => "/usr/bin/true" },
    });

    assert.equal(report.ok, true);
    assert.equal(report.verdict, "go");
    assert.deepEqual(report.checks.rootDirtyLease.dirtyFiles, ["notes.md"]);
    assert.deepEqual(report.checks.rootDirtyLease.overlappingFiles, []);
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

  it("checks gemini, antigravity, and agy shards against the agy worker CLI", () => {
    const repoRoot = makeTmpDir();
    const prdPath = writePrd(
      repoRoot,
      `
## Shard: gemini-worker
- agent: gemini
- files: src/gemini.mjs
- prompt: Run Gemini alias.

## Shard: antigravity-worker
- agent: antigravity
- files: src/antigravity.mjs
- prompt: Run Antigravity.

## Shard: agy-worker
- agent: agy
- files: src/agy.mjs
- prompt: Run agy.
`,
    );
    const checkedCommands = [];
    const report = runSwarmPreflight(prdPath, {
      repoRoot,
      deps: {
        whichCommand: (command) => {
          checkedCommands.push(command);
          return command === "agy" ? "/usr/local/bin/agy" : null;
        },
      },
    });

    assert.equal(report.ok, true);
    assert.deepEqual(checkedCommands, ["agy"]);
    assert.deepEqual(report.checks.workerCli.present, [
      {
        shard: "gemini-worker",
        agent: "gemini",
        command: "agy",
        path: "/usr/local/bin/agy",
      },
      {
        shard: "antigravity-worker",
        agent: "antigravity",
        command: "agy",
        path: "/usr/local/bin/agy",
      },
      {
        shard: "agy-worker",
        agent: "agy",
        command: "agy",
        path: "/usr/local/bin/agy",
      },
    ]);
    assert.deepEqual(report.checks.workerCli.missing, []);
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
