import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { rebaseShardOntoIntegration } from "../../hub/team/worktree-lifecycle.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Triflux Test",
      GIT_AUTHOR_EMAIL: "test@triflux.local",
      GIT_COMMITTER_NAME: "Triflux Test",
      GIT_COMMITTER_EMAIL: "test@triflux.local",
    },
  }).trim();
}

function makeRepo() {
  const repo = mkdtempSync(
    join(tmpdir(), `tfx-integration-safety-${process.pid}-`),
  );
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "shared.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

function removeRepo(repo) {
  rmSync(repo, { recursive: true, force: true });
}

test("dirty leased rootDir file survives the historical ff-failure path", async () => {
  const repo = makeRepo();
  try {
    git(repo, ["checkout", "-q", "-b", "swarm/run/merge", "main"]);
    writeFileSync(join(repo, "integration.txt"), "integration content\n");
    git(repo, ["add", "integration.txt"]);
    git(repo, ["commit", "-q", "-m", "diverge integration"]);

    git(repo, ["checkout", "-q", "-b", "swarm/run/shard", "main"]);
    writeFileSync(join(repo, "shared.txt"), "shard\n");
    git(repo, ["commit", "-q", "-am", "shard change"]);

    git(repo, ["checkout", "-q", "main"]);
    // shared.txt represents a rootDir tracked change that is also leased by
    // the shard. The old rootDir merge failed here, then reset --hard erased it.
    writeFileSync(join(repo, "shared.txt"), "root dirty lease overlap\n");
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const statusBefore = git(repo, ["status", "--porcelain"]);

    const result = await rebaseShardOntoIntegration({
      shardBranch: "swarm/run/shard",
      integrationBranch: "swarm/run/merge",
      rootDir: repo,
    });

    assert.equal(result.ok, true);
    assert.equal(result.strategy, "cherry-pick");
    assert.equal(
      readFileSync(join(repo, "shared.txt"), "utf8"),
      "root dirty lease overlap\n",
    );
    assert.equal(git(repo, ["status", "--porcelain"]), statusBefore);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(git(repo, ["show", "swarm/run/merge:shared.txt"]), "shard");
  } finally {
    removeRepo(repo);
  }
});

test("fast-forward updates only the integration ref", async () => {
  const repo = makeRepo();
  try {
    git(repo, ["checkout", "-q", "-b", "swarm/run/shard"]);
    writeFileSync(join(repo, "shard.txt"), "shard content\n");
    git(repo, ["add", "shard.txt"]);
    git(repo, ["commit", "-q", "-m", "shard feature"]);
    const shardCommit = git(repo, ["rev-parse", "HEAD"]);

    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["branch", "swarm/run/merge", "main"]);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const indexBefore = git(repo, ["write-tree"]);
    const statusBefore = git(repo, ["status", "--porcelain"]);

    const result = await rebaseShardOntoIntegration({
      shardBranch: "swarm/run/shard",
      integrationBranch: "swarm/run/merge",
      rootDir: repo,
    });

    assert.equal(result.ok, true);
    assert.equal(result.strategy, "auto-ff");
    assert.equal(git(repo, ["rev-parse", "swarm/run/merge"]), shardCommit);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(git(repo, ["write-tree"]), indexBefore);
    assert.equal(git(repo, ["status", "--porcelain"]), statusBefore);
    assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "base\n");
  } finally {
    removeRepo(repo);
  }
});

test("cherry-pick fallback leaves rootDir HEAD, index, and working tree untouched", async () => {
  const repo = makeRepo();
  try {
    git(repo, ["checkout", "-q", "-b", "swarm/run/merge"]);
    writeFileSync(join(repo, "integration.txt"), "integration content\n");
    git(repo, ["add", "integration.txt"]);
    git(repo, ["commit", "-q", "-m", "integration base"]);

    git(repo, ["checkout", "-q", "-b", "swarm/run/shard", "main"]);
    writeFileSync(join(repo, "shard.txt"), "shard content\n");
    git(repo, ["add", "shard.txt"]);
    git(repo, ["commit", "-q", "-m", "shard feature"]);

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "shared.txt"), "root remains dirty\n");
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const indexBefore = git(repo, ["write-tree"]);
    const statusBefore = git(repo, ["status", "--porcelain"]);

    const result = await rebaseShardOntoIntegration({
      shardBranch: "swarm/run/shard",
      integrationBranch: "swarm/run/merge",
      rootDir: repo,
    });

    assert.equal(result.ok, true);
    assert.equal(result.strategy, "cherry-pick");
    assert.equal(
      git(repo, ["show", "swarm/run/merge:integration.txt"]),
      "integration content",
    );
    assert.equal(
      git(repo, ["show", "swarm/run/merge:shard.txt"]),
      "shard content",
    );
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(git(repo, ["write-tree"]), indexBefore);
    assert.equal(git(repo, ["status", "--porcelain"]), statusBefore);
    assert.equal(
      readFileSync(join(repo, "shared.txt"), "utf8"),
      "root remains dirty\n",
    );
  } finally {
    removeRepo(repo);
  }
});
