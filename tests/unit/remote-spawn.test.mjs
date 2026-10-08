import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { __remoteSpawnTest } from "../../scripts/remote-spawn.mjs";

const REMOTE_SPAWN = fileURLToPath(
  new URL("../../scripts/remote-spawn.mjs", import.meta.url),
);

const {
  buildPromptContext,
  normalizePosixProbeEnv,
  parseArgs,
  rewritePromptPaths,
} = __remoteSpawnTest;

function withTempDir(run) {
  // handoff 와 전송 파일은 cwd 안에 있어야 하므로 임시 디렉터리를 cwd 로 삼는다.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tfx-remote-spawn-")));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return run(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("remote-spawn parseArgs()", () => {
  it("collects repeated --transfer values", () => {
    const parsed = parseArgs([
      "node",
      "remote-spawn.mjs",
      "--host",
      "example-host",
      "--transfer",
      "docs/prd.md",
      "--transfer",
      "docs/spec.md",
      "run",
      "this",
    ]);

    assert.deepEqual(parsed.transferFiles, ["docs/prd.md", "docs/spec.md"]);
    assert.equal(parsed.prompt, "run this");
    assert.equal(parsed.host, "example-host");
  });
});

it("POSIX probe reports health and blocks memory pressure level 4", () => {
  const probe = normalizePosixProbeEnv(
    {
      os: "darwin",
      shell: "zsh",
      home: "/Users/remote",
      claude: "/usr/local/bin/claude",
      memoryPressureLevel: "4",
      memoryFreePct: "12.5",
      loadAvg: "1.2,2.3,3.4",
      diskFreeHome: String(4 * 1024 ** 3),
      codexAuthExists: "true",
      nodeVersion: "v24.0.0",
    },
    { node: [22, 0, 0] },
  );

  assert.equal(probe.ready, false);
  assert.equal(probe.memoryFreePct, 12.5);
  assert.deepEqual(probe.loadAvg, [1.2, 2.3, 3.4]);
  assert.equal(probe.codexAuthExists, true);
  assert.equal(probe.versions.node, "v24.0.0");
  assert.equal(probe.warnings.length, 3);

  const warning = normalizePosixProbeEnv(
    { os: "darwin", home: "/Users/remote", memoryPressureLevel: "2" },
    {},
  );
  assert.equal(warning.ready, true);
  assert.deepEqual(warning.warnings, ["memory pressure level 2"]);
});

describe("remote-spawn buildPromptContext()", () => {
  it("inlines handoff text and dedupes transfer files by resolved path", () => {
    withTempDir((dir) => {
      const handoffPath = join(dir, "handoff.md");
      const transferPath = join(dir, "prd.md");
      writeFileSync(handoffPath, "Read ./prd.md first", "utf8");
      writeFileSync(transferPath, "# PRD", "utf8");

      const transferRelative = join(dir, ".", "prd.md");
      const transferAbsolute = resolve(transferPath);
      const context = buildPromptContext(
        {
          handoff: handoffPath,
          prompt: "then continue",
          transferFiles: [transferRelative, transferAbsolute],
        },
        { includeTransferFiles: true },
      );

      assert.equal(
        context.prompt,
        "Read ./prd.md first\n\n---\n\nthen continue",
      );
      assert.equal(context.transferCandidates.length, 2);
      assert.equal(
        context.transferCandidates[0].localPath,
        resolve(handoffPath),
      );
      assert.equal(
        context.transferCandidates[1].localPath,
        resolve(transferPath),
      );
    });
  });

  it("does not validate transfer files when includeTransferFiles is false", () => {
    withTempDir((dir) => {
      const handoffPath = join(dir, "handoff.md");
      writeFileSync(handoffPath, "local handoff", "utf8");
      const missingTransfer = join(dir, "missing-transfer.md");

      const context = buildPromptContext(
        {
          handoff: handoffPath,
          prompt: null,
          transferFiles: [missingTransfer],
        },
        { includeTransferFiles: false },
      );

      assert.equal(context.prompt, "local handoff");
      assert.equal(context.transferCandidates.length, 1);
      assert.equal(
        context.transferCandidates[0].localPath,
        resolve(handoffPath),
      );
    });
  });
});

describe("remote-spawn rewritePromptPaths()", () => {
  it("rewrites local input and resolved paths to remote staged paths", () => {
    withTempDir((dir) => {
      const handoffPath = join(dir, "handoff.md");
      writeFileSync(handoffPath, "content", "utf8");
      const resolved = resolve(handoffPath);
      const windowsVariant = resolved.replace(/\//g, "\\");

      const remotePath = "/remote/stage/handoff.md";
      const rewritten = rewritePromptPaths(
        `Open ${handoffPath} and ${resolved} and ${windowsVariant}`,
        [{ inputPath: handoffPath, localPath: resolved, remotePath }],
      );

      assert.equal(rewritten.includes(handoffPath), false);
      assert.equal(rewritten.includes(resolved), false);
      assert.equal(rewritten.includes(windowsVariant), false);
      assert.equal(rewritten.includes(remotePath), true);
    });
  });
});

describe("remote-spawn CLI fail-fast", () => {
  it("fails before SSH when transfer file is missing", () => {
    withTempDir((dir) => {
      const missingPath = join(dir, `missing-${Date.now()}.md`);
      const result = spawnSync(
        process.execPath,
        [
          REMOTE_SPAWN,
          "--host",
          "example-host",
          "--transfer",
          missingPath,
          "hello",
        ],
        { cwd: dir, encoding: "utf8" },
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /transfer file not found:/u);
    });
  });

  it("fails before SSH when transfer file exceeds MAX_HANDOFF_BYTES", () => {
    withTempDir((dir) => {
      const largePath = join(dir, "too-large.md");
      writeFileSync(largePath, "x".repeat(1024 * 1024 + 10), "utf8");

      const result = spawnSync(
        process.execPath,
        [
          REMOTE_SPAWN,
          "--host",
          "example-host",
          "--transfer",
          largePath,
          "hello",
        ],
        { cwd: dir, encoding: "utf8" },
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /transfer file too large:/u);
    });
  });
});
