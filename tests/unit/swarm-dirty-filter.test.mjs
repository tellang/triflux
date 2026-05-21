// BUG-I regression — extractDirtyFiles filters only explicitly expected
// deletions. .claude-plugin metadata must stay visible because Codex workers
// require it inside swarm worktrees.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_WORKTREE_DELETIONS,
  extractDirtyFiles,
} from "../../hub/team/worktree-lifecycle.mjs";

test("extractDirtyFiles: empty/null/undefined input returns empty array", () => {
  assert.deepStrictEqual(extractDirtyFiles(""), []);
  assert.deepStrictEqual(extractDirtyFiles(null), []);
  assert.deepStrictEqual(extractDirtyFiles(undefined), []);
});

test("extractDirtyFiles: .claude-plugin deletions are dirty regressions", () => {
  const raw =
    " D .claude-plugin/marketplace.json\n D .claude-plugin/plugin.json";
  assert.deepStrictEqual(extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS), [
    ".claude-plugin/marketplace.json",
    ".claude-plugin/plugin.json",
  ]);
});

test("extractDirtyFiles: passes through genuine dirty paths", () => {
  const raw = " M src/foo.js\n?? new.txt";
  assert.deepStrictEqual(extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS), [
    "src/foo.js",
    "new.txt",
  ]);
});

test("extractDirtyFiles: mixed input preserves .claude-plugin deletions", () => {
  const raw =
    " D .claude-plugin/marketplace.json\n" +
    " M hub/team/foo.mjs\n" +
    " D .claude-plugin/plugin.json\n" +
    "?? untracked.md";
  assert.deepStrictEqual(extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS), [
    ".claude-plugin/marketplace.json",
    "hub/team/foo.mjs",
    ".claude-plugin/plugin.json",
    "untracked.md",
  ]);
});

test("extractDirtyFiles: expected path MODIFIED is NOT filtered (Codex review #134)", () => {
  const raw = " M .claude-plugin/plugin.json";
  assert.deepStrictEqual(extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS), [
    ".claude-plugin/plugin.json",
  ]);
});

test("extractDirtyFiles: expected path UNTRACKED is NOT filtered (Codex review #134)", () => {
  const raw = "?? .claude-plugin/plugin.json";
  assert.deepStrictEqual(extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS), [
    ".claude-plugin/plugin.json",
  ]);
});

test("extractDirtyFiles: rename 'R  old -> new' passes through (edge case)", () => {
  const raw = "R  old/file.md -> new/file.md\n M submodule";
  assert.deepStrictEqual(extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS), [
    "old/file.md -> new/file.md",
    "submodule",
  ]);
});

test("extractDirtyFiles: staged .claude-plugin deletion is dirty", () => {
  const raw = "D  .claude-plugin/marketplace.json";
  assert.deepStrictEqual(extractDirtyFiles(raw, EXPECTED_WORKTREE_DELETIONS), [
    ".claude-plugin/marketplace.json",
  ]);
});
