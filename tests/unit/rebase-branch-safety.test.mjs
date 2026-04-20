// BUG-J regression — rebaseShardOntoIntegration must not mutate the caller's
// branch when its internal checkout fails. Previous behavior: on checkout
// failure the catch block ran `git reset --hard backupCommit` on whatever
// HEAD pointed at, silently rewinding the caller's branch to integrationBranch's
// backup (observed 2026-04-20 during BUG-F probe).
//
// These tests spin up a disposable git repo in tmpdir to exercise the real
// lifecycle without mocking execFile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { rebaseShardOntoIntegration } from "../../hub/team/worktree-lifecycle.mjs";

const execFile = promisify(execFileCb);

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Triflux Test",
      GIT_AUTHOR_EMAIL: "test@triflux.local",
      GIT_COMMITTER_NAME: "Triflux Test",
      GIT_COMMITTER_EMAIL: "test@triflux.local",
    },
  });
  return stdout.trim();
}

async function withTempRepo(fn) {
  const repo = await mkdtemp(join(tmpdir(), "tfx-bug-j-"));
  const aux = await mkdtemp(join(tmpdir(), "tfx-bug-j-wt-"));
  try {
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
    await fn({ repo, aux });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(aux, { recursive: true, force: true });
  }
}

test("rebaseShardOntoIntegration: checkout failure does not rewind caller branch (BUG-J)", async () => {
  await withTempRepo(async ({ repo, aux }) => {
    // Caller branch with a unique commit — this must survive the failure.
    await git(repo, ["checkout", "-q", "-b", "caller"]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "caller work"]);
    const callerSha = await git(repo, ["rev-parse", "HEAD"]);

    // integrationBranch held by a separate worktree → main repo cannot
    // checkout it, forcing the catch block to run while current HEAD is
    // still on `caller`.
    await git(repo, [
      "worktree",
      "add",
      "--quiet",
      aux,
      "-b",
      "swarm/r/merge",
      "main",
    ]);

    // shardBranch exists but is empty relative to integration (no commits
    // to pick). The failure we care about is the checkout, not cherry-pick.
    await git(repo, ["branch", "swarm/r/shard", "main"]);

    const result = await rebaseShardOntoIntegration({
      shardBranch: "swarm/r/shard",
      integrationBranch: "swarm/r/merge",
      rootDir: repo,
    });

    assert.equal(result.ok, false, "should report failure");

    const afterSha = await git(repo, ["rev-parse", "caller"]);
    assert.equal(
      afterSha,
      callerSha,
      "caller branch must not be reset to integrationBranch's backup",
    );

    const currentBranch = await git(repo, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    assert.equal(
      currentBranch,
      "caller",
      "current HEAD must be restored to caller branch",
    );
  });
});

test("rebaseShardOntoIntegration: ref-only rollback leaves integrationBranch at backup (BUG-J)", async () => {
  await withTempRepo(async ({ repo, aux }) => {
    await git(repo, ["checkout", "-q", "-b", "caller"]);
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "caller work"]);

    await git(repo, [
      "worktree",
      "add",
      "--quiet",
      aux,
      "-b",
      "swarm/r/merge",
      "main",
    ]);
    const backupSha = await git(repo, ["rev-parse", "swarm/r/merge"]);

    await git(repo, ["branch", "swarm/r/shard", "main"]);

    await rebaseShardOntoIntegration({
      shardBranch: "swarm/r/shard",
      integrationBranch: "swarm/r/merge",
      rootDir: repo,
    });

    // integrationBranch ref should remain at its backup commit (either
    // unchanged because we never got to mutate it, or explicitly rolled
    // back via `branch -f`).
    const afterMergeSha = await git(repo, ["rev-parse", "swarm/r/merge"]);
    assert.equal(
      afterMergeSha,
      backupSha,
      "integrationBranch must still point at backup commit",
    );
  });
});

test("rebaseShardOntoIntegration: cherry-pick conflict rewinds integrationBranch, preserves caller (BUG-J reset path)", async () => {
  // Covers the `currentBranch === integrationBranch` branch of the catch
  // block — the only case that actually runs `git reset --hard backupCommit`.
  // Codex review of PR #135 flagged missing coverage here (2026-04-20).
  await withTempRepo(async ({ repo }) => {
    // Base file on main.
    await writeFile(join(repo, "file.txt"), "base content\n");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-q", "-m", "base file"]);

    // integrationBranch — modifies file.txt one way.
    await git(repo, ["checkout", "-q", "-b", "swarm/r/merge"]);
    await writeFile(join(repo, "file.txt"), "integration line\n");
    await git(repo, ["commit", "-q", "-am", "integration mod"]);
    const integrationBackupSha = await git(repo, ["rev-parse", "HEAD"]);

    // shardBranch — modifies same file.txt differently (conflict material).
    await git(repo, ["checkout", "-q", "-b", "swarm/r/shard", "main"]);
    await writeFile(join(repo, "file.txt"), "shard line\n");
    await git(repo, ["commit", "-q", "-am", "shard mod"]);

    // Caller has its own commit.
    await git(repo, ["checkout", "-q", "-b", "caller", "main"]);
    await writeFile(join(repo, "caller.txt"), "caller work\n");
    await git(repo, ["add", "caller.txt"]);
    await git(repo, ["commit", "-q", "-m", "caller work"]);
    const callerSha = await git(repo, ["rev-parse", "HEAD"]);

    const result = await rebaseShardOntoIntegration({
      shardBranch: "swarm/r/shard",
      integrationBranch: "swarm/r/merge",
      rootDir: repo,
    });

    assert.equal(result.ok, false, "should fail — cherry-pick conflict");

    // integrationBranch ref rewound to its backup (reset --hard path).
    const afterMergeSha = await git(repo, ["rev-parse", "swarm/r/merge"]);
    assert.equal(
      afterMergeSha,
      integrationBackupSha,
      "integrationBranch rewound to backup after cherry-pick conflict",
    );

    // Caller branch ref untouched.
    const afterCallerSha = await git(repo, ["rev-parse", "caller"]);
    assert.equal(
      afterCallerSha,
      callerSha,
      "caller branch SHA preserved across conflict path",
    );

    // HEAD restored to caller by the finally block.
    const currentBranch = await git(repo, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    assert.equal(
      currentBranch,
      "caller",
      "HEAD restored to caller after rollback",
    );
  });
});

test("rebaseShardOntoIntegration: happy path cherry-picks shard commits (regression guard)", async () => {
  await withTempRepo(async ({ repo }) => {
    // Shard branch with a real file commit we expect to land on integration.
    await git(repo, ["checkout", "-q", "-b", "swarm/r/shard", "main"]);
    await writeFile(join(repo, "shard.txt"), "shard content\n");
    await git(repo, ["add", "shard.txt"]);
    await git(repo, ["commit", "-q", "-m", "shard feature"]);
    const shardSha = await git(repo, ["rev-parse", "HEAD"]);

    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["branch", "swarm/r/merge", "main"]);

    // Caller on main.
    const callerBefore = await git(repo, ["rev-parse", "main"]);

    const result = await rebaseShardOntoIntegration({
      shardBranch: "swarm/r/shard",
      integrationBranch: "swarm/r/merge",
      rootDir: repo,
    });

    assert.equal(result.ok, true, "happy path should succeed");

    // integrationBranch advanced past its base by one cherry-picked commit.
    const mergeSha = await git(repo, ["rev-parse", "swarm/r/merge"]);
    assert.notEqual(
      mergeSha,
      callerBefore,
      "integrationBranch advanced past base",
    );
    const mergeSubject = await git(repo, [
      "log",
      "-1",
      "--format=%s",
      "swarm/r/merge",
    ]);
    assert.equal(mergeSubject, "shard feature");

    // Cherry-pick preserves the tree; sha differs but subject matches.
    assert.notEqual(
      await git(repo, ["rev-parse", "swarm/r/merge"]),
      shardSha,
      "cherry-pick creates a new commit sha",
    );

    // Caller branch (main) untouched.
    assert.equal(
      await git(repo, ["rev-parse", "main"]),
      callerBefore,
      "main stays at base after happy path",
    );
    assert.equal(
      await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "main",
      "HEAD restored to caller",
    );
  });
});
