import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRegisterScopeMetadata,
  DEFAULT_ROLE_SCOPE,
  deriveRepoRootFromCwd,
  repoScopeHash,
  shortHash,
} from "../../hub/lib/repo-scope.mjs";

test("shortHash is deterministic djb2 base36", () => {
  assert.equal(shortHash("/Users/me/proj"), shortHash("/Users/me/proj"));
  assert.notEqual(shortHash("/a"), shortHash("/b"));
  assert.equal(shortHash(""), (5381 >>> 0).toString(36));
});

test("deriveRepoRootFromCwd strips worktree suffixes", () => {
  assert.equal(
    deriveRepoRootFromCwd("/Users/me/proj/.worktrees/feat-x"),
    "/Users/me/proj",
  );
  assert.equal(
    deriveRepoRootFromCwd("/Users/me/proj/.claude/worktrees/feat-x/sub"),
    "/Users/me/proj",
  );
  assert.equal(
    deriveRepoRootFromCwd("/Users/me/proj/.codex-swarm/wt-1/x"),
    "/Users/me/proj",
  );
  assert.equal(deriveRepoRootFromCwd("/Users/me/proj"), "/Users/me/proj");
});

test("repoScopeHash matches cto/status repoRootHash convention", () => {
  const cwd = "/Users/me/proj/.worktrees/feat-x";
  assert.equal(repoScopeHash(cwd), shortHash(deriveRepoRootFromCwd(cwd)));
});

test("two worktrees of the same repo share one scope", () => {
  assert.equal(
    repoScopeHash("/Users/me/proj/.worktrees/a"),
    repoScopeHash("/Users/me/proj/.claude/worktrees/b"),
  );
});

test("repoScopeHash collapses empty cwd to global sentinel", () => {
  assert.equal(repoScopeHash(""), DEFAULT_ROLE_SCOPE);
  assert.equal(repoScopeHash(null), DEFAULT_ROLE_SCOPE);
});

test("buildRegisterScopeMetadata stamps cwd, repo_root, repoRootHash", () => {
  const meta = buildRegisterScopeMetadata("/Users/me/proj/.worktrees/feat-x");
  assert.equal(meta.repo_root, "/Users/me/proj");
  assert.equal(
    meta.repoRootHash,
    repoScopeHash("/Users/me/proj/.worktrees/feat-x"),
  );
  assert.equal(meta.cwd, "/Users/me/proj/.worktrees/feat-x");
});

test("buildRegisterScopeMetadata uses global sentinel when cwd missing", () => {
  assert.equal(buildRegisterScopeMetadata("").repoRootHash, DEFAULT_ROLE_SCOPE);
});
