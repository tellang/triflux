// BUG-I regression — extractDirtyFiles filters EXPECTED_WORKTREE_DELETIONS
// so F6 no_commit_guard does not trip on #34 L2 intentional .claude-plugin
// removal. See hub/team/worktree-lifecycle.mjs prepareWorktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDirtyFiles,
  EXPECTED_WORKTREE_DELETIONS,
} from "../../hub/team/worktree-lifecycle.mjs";

test("extractDirtyFiles: empty/null/undefined input returns empty array", () => {
  assert.deepStrictEqual(extractDirtyFiles(""), []);
  assert.deepStrictEqual(extractDirtyFiles(null), []);
  assert.deepStrictEqual(extractDirtyFiles(undefined), []);
});

test("extractDirtyFiles: filters EXPECTED_WORKTREE_DELETIONS (BUG-I #129)", () => {
  const raw =
    " D .claude-plugin/marketplace.json\n D .claude-plugin/plugin.json";
  assert.deepStrictEqual(
    extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS),
    [],
  );
});

test("extractDirtyFiles: passes through genuine dirty paths", () => {
  const raw = " M src/foo.js\n?? new.txt";
  assert.deepStrictEqual(
    extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS),
    ["src/foo.js", "new.txt"],
  );
});

test("extractDirtyFiles: mixed input — only expected deletions filtered", () => {
  const raw =
    " D .claude-plugin/marketplace.json\n" +
    " M hub/team/foo.mjs\n" +
    " D .claude-plugin/plugin.json\n" +
    "?? untracked.md";
  assert.deepStrictEqual(
    extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS),
    ["hub/team/foo.mjs", "untracked.md"],
  );
});

test("extractDirtyFiles: expected path MODIFIED is NOT filtered (Codex review #134)", () => {
  const raw = " M .claude-plugin/plugin.json";
  assert.deepStrictEqual(
    extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS),
    [".claude-plugin/plugin.json"],
  );
});

test("extractDirtyFiles: expected path UNTRACKED is NOT filtered (Codex review #134)", () => {
  const raw = "?? .claude-plugin/plugin.json";
  assert.deepStrictEqual(
    extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS),
    [".claude-plugin/plugin.json"],
  );
});

test("extractDirtyFiles: rename 'R  old -> new' passes through (edge case)", () => {
  const raw = "R  old/file.md -> new/file.md\n M submodule";
  assert.deepStrictEqual(
    extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS),
    ["old/file.md -> new/file.md", "submodule"],
  );
});

test("extractDirtyFiles: staged deletion 'D ' of expected path IS filtered", () => {
  const raw = "D  .claude-plugin/marketplace.json";
  assert.deepStrictEqual(
    extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS),
    [],
  );
});
