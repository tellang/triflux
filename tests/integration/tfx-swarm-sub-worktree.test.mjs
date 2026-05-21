import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureWorktree } from "../../hub/team/worktree-lifecycle.mjs";

function makeRepoWithPluginMetadata() {
  const repoDir = join(
    tmpdir(),
    `tfx-swarm-sub-worktree-${process.pid}-${Date.now()}`,
  );
  mkdirSync(repoDir, { recursive: true });
  const git = (args) =>
    execFileSync("git", args, { cwd: repoDir, windowsHide: true });

  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(repoDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(repoDir, ".claude-plugin", "plugin.json"),
    '{"name":"triflux"}',
  );
  writeFileSync(
    join(repoDir, ".claude-plugin", "marketplace.json"),
    '{"plugins":[]}',
  );
  writeFileSync(join(repoDir, "README.md"), "# fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  return repoDir;
}

test("tfx swarm sub-worktree preserves .claude-plugin metadata without sparse checkout", {
  timeout: 30_000,
}, async () => {
  const repoDir = makeRepoWithPluginMetadata();
  try {
    const wt = await ensureWorktree({
      slug: "codex-plugin",
      runId: "issue-315",
      rootDir: repoDir,
      baseBranch: "main",
    });

    assert.ok(
      existsSync(join(wt.worktreePath, ".claude-plugin", "plugin.json")),
      "sub-worktree should preserve .claude-plugin/plugin.json",
    );
    assert.ok(
      existsSync(join(wt.worktreePath, ".claude-plugin", "marketplace.json")),
      "sub-worktree should preserve .claude-plugin/marketplace.json",
    );

    assert.throws(
      () =>
        execFileSync("git", ["sparse-checkout", "list"], {
          cwd: wt.worktreePath,
          windowsHide: true,
          stdio: "pipe",
        }),
      /this worktree is not sparse|not a sparse checkout|sparse checkout is not enabled/i,
      "sub-worktree should not use sparse checkout",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
