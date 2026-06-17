import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("resolves a linked git worktree to the canonical project root", () => {
    // worktree 루트에 .git 파일이 있더라도 프로젝트당 CTO lake 는 하나여야 한다.
    const worktree = "/repo/.claude/worktrees/foo";
    const exists = (p) =>
      p === join(worktree, ".git") || p === join("/repo", ".git");
    const fakeGit = (cmd, args) => {
      assert.equal(cmd, "git");
      assert.deepEqual(args, [
        "-C",
        join(worktree, "packages"),
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      return `${join("/repo", ".git")}\n`;
    };
    assert.equal(
      resolveLakeRootDir(join(worktree, "packages"), {
        existsSync: exists,
        execFileSync: fakeGit,
      }),
      "/repo",
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

  it("resolves a real linked worktree to the main checkout root", () => {
    const root = mkdtempSync(join(tmpdir(), "tfx-lake-root-worktree-test-"));
    const main = join(root, "main");
    const linked = join(root, "linked");
    try {
      mkdirSync(main, { recursive: true });
      execFileSync("git", ["init"], {
        cwd: main,
        stdio: ["ignore", "ignore", "ignore"],
      });
      writeFileSync(join(main, "README.md"), "# fixture\n", "utf8");
      execFileSync("git", ["add", "README.md"], {
        cwd: main,
        stdio: ["ignore", "ignore", "ignore"],
      });
      execFileSync(
        "git",
        [
          "-c",
          "user.email=tfx@example.invalid",
          "-c",
          "user.name=TFX Test",
          "commit",
          "-m",
          "init",
        ],
        { cwd: main, stdio: ["ignore", "ignore", "ignore"] },
      );
      execFileSync("git", ["worktree", "add", linked, "-b", "linked"], {
        cwd: main,
        stdio: ["ignore", "ignore", "ignore"],
      });
      const nested = join(linked, "packages", "triflux");
      mkdirSync(nested, { recursive: true });

      assert.equal(resolveLakeRootDir(nested), realpathSync(main));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
