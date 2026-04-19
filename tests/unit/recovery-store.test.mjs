// tests/unit/recovery-store.test.mjs — recovery-store 유닛 테스트

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  preserveWorktreePatch,
  readManifest,
} from "../../hub/team/recovery-store.mjs";

function makeTmpRepo() {
  const dir = join(tmpdir(), `tfx-recovery-store-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, windowsHide: true };
  execFileSync("git", ["init", "-b", "main"], opts);
  execFileSync("git", ["config", "user.email", "test@test.com"], opts);
  execFileSync("git", ["config", "user.name", "Test"], opts);
  writeFileSync(join(dir, "README.md"), "# seed\n");
  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-m", "init"], opts);
  return dir;
}

describe("recovery-store", () => {
  let repoDir;

  beforeEach(() => {
    repoDir = makeTmpRepo();
  });

  afterEach(() => {
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("captures dirty worktree to patch file + manifest entry", async () => {
    writeFileSync(join(repoDir, "README.md"), "# changed\n");
    writeFileSync(join(repoDir, "new.txt"), "brand new\n");
    execFileSync("git", ["add", "new.txt"], {
      cwd: repoDir,
      windowsHide: true,
    });

    const recoveryDir = join(repoDir, ".codex-swarm", "recovery");
    const result = await preserveWorktreePatch({
      worktreePath: repoDir,
      shardId: "worker-a",
      recoveryDir,
    });

    assert.equal(result.ok, true, "preservation should succeed on dirty tree");
    assert.equal(result.skipped, undefined);
    assert.ok(result.patchPath, "patchPath must be returned");

    const patchContent = readFileSync(result.patchPath, "utf8");
    assert.ok(
      patchContent.includes("README.md"),
      "patch should reference modified file",
    );
    assert.ok(
      patchContent.includes("new.txt"),
      "patch should reference staged new file",
    );

    const manifest = readManifest(recoveryDir);
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].shard, "worker-a");
    assert.equal(manifest.entries[0].patch, result.patchPath);
    assert.match(
      manifest.entries[0].timestamp,
      /^\d{4}-\d{2}-\d{2}T/,
      "timestamp should be ISO-8601",
    );
  });

  it("skips clean worktree without writing any files", async () => {
    const recoveryDir = join(repoDir, ".codex-swarm", "recovery");
    const result = await preserveWorktreePatch({
      worktreePath: repoDir,
      shardId: "worker-clean",
      recoveryDir,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(
      existsSync(recoveryDir),
      false,
      "no recovery dir should be created for clean tree",
    );
    assert.deepEqual(readManifest(recoveryDir).entries, []);
  });

  it("returns ok:false without throwing on nonexistent worktree path", async () => {
    const missing = join(repoDir, "does-not-exist");
    const result = await preserveWorktreePatch({
      worktreePath: missing,
      shardId: "worker-ghost",
      recoveryDir: join(repoDir, ".codex-swarm", "recovery"),
    });

    assert.equal(result.ok, false);
    assert.ok(result.reason, "reason must be populated on failure");
  });

  it("appends to an existing manifest rather than overwriting", async () => {
    const recoveryDir = join(repoDir, ".codex-swarm", "recovery");

    writeFileSync(join(repoDir, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repoDir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "a"], {
      cwd: repoDir,
      windowsHide: true,
    });
    writeFileSync(join(repoDir, "a.txt"), "a changed\n");
    const first = await preserveWorktreePatch({
      worktreePath: repoDir,
      shardId: "shard-1",
      recoveryDir,
    });
    assert.equal(first.ok, true);

    writeFileSync(join(repoDir, "a.txt"), "a changed again\n");
    const second = await preserveWorktreePatch({
      worktreePath: repoDir,
      shardId: "shard-2",
      recoveryDir,
    });
    assert.equal(second.ok, true);

    const manifest = readManifest(recoveryDir);
    assert.equal(manifest.entries.length, 2);
    assert.deepEqual(
      manifest.entries.map((e) => e.shard),
      ["shard-1", "shard-2"],
    );
  });
});
