import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveLakeRootDir } from "../../cto/lake-root.mjs";

describe("resolveLakeRootDir", () => {
  it("returns cwd when .git is directly present", () => {
    const exists = (p) => p === join("/repo", ".git");
    assert.equal(resolveLakeRootDir("/repo", { existsSync: exists }), "/repo");
  });

  it("walks up to the nearest .git toplevel from a subdir", () => {
    const exists = (p) => p === join("/repo", ".git");
    assert.equal(
      resolveLakeRootDir("/repo/packages/triflux", { existsSync: exists }),
      "/repo",
    );
  });

  it("stops at a git worktree (.git file) instead of the main repo", () => {
    // worktree 루트에 .git 파일이 있으므로 거기서 멈춘다 (lake 격리 유지).
    const worktree = "/repo/.claude/worktrees/foo";
    const exists = (p) =>
      p === join(worktree, ".git") || p === join("/repo", ".git");
    assert.equal(
      resolveLakeRootDir(join(worktree, "packages"), { existsSync: exists }),
      worktree,
    );
  });

  it("falls back to cwd when no .git is found", () => {
    const exists = () => false;
    assert.equal(
      resolveLakeRootDir("/tmp/not-a-repo/sub", { existsSync: exists }),
      "/tmp/not-a-repo/sub",
    );
  });

  it("handles empty or non-string input", () => {
    const exists = () => false;
    assert.equal(resolveLakeRootDir("", { existsSync: exists }), "");
    assert.equal(resolveLakeRootDir(undefined, { existsSync: exists }), "");
    assert.equal(resolveLakeRootDir(null, { existsSync: exists }), "");
    // truthy 비문자열도 "" 로 — 객체/숫자/배열을 그대로 누설하지 않는다.
    assert.equal(resolveLakeRootDir({}, { existsSync: exists }), "");
    assert.equal(resolveLakeRootDir(123, { existsSync: exists }), "");
    assert.equal(resolveLakeRootDir(["/x"], { existsSync: exists }), "");
  });

  it("terminates on a relative path without infinite loop", () => {
    const exists = () => false;
    // dirname 이 "." 에 도달하면 parent === dir 로 루프가 종료되고 cwd fallback.
    assert.equal(
      resolveLakeRootDir("foo/bar", { existsSync: exists }),
      "foo/bar",
    );
  });

  it("does not throw when opts is null", () => {
    // opts?.existsSync 가 null 을 안전하게 처리하고 실제 fs fallback 을 쓴다.
    assert.doesNotThrow(() =>
      resolveLakeRootDir("/nonexistent/deep/path", null),
    );
  });

  it("resolves a real repo toplevel from a nested dir", () => {
    const root = mkdtempSync(join(tmpdir(), "tfx-lake-root-test-"));
    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      const nested = join(root, "packages", "triflux");
      mkdirSync(nested, { recursive: true });
      assert.equal(resolveLakeRootDir(nested), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
