// tests/unit/worktree-lifecycle.test.mjs — worktree-lifecycle 테스트 (Wave 5)
// 실제 temp git repo를 사용하여 worktree 생성/정리를 검증한다.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  cleanupWorktree,
  ensureWorktree,
  prepareIntegrationBranch,
  pruneOrphanWorktrees,
  pruneWorktree,
  rebaseShardOntoIntegration,
} from "../../hub/team/worktree-lifecycle.mjs";

function makeTmpRepo() {
  const dir = join(tmpdir(), `tfx-wt-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const g = (args) =>
    execFileSync("git", args, { cwd: dir, windowsHide: true });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "test@test.com"]);
  g(["config", "user.name", "Test"]);
  // initial commit (worktree requires at least one commit)
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: dir,
    windowsHide: true,
  });
  return dir;
}

describe("worktree-lifecycle", () => {
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

  it("W-01: ensureWorktree — 올바른 경로/브랜치 생성 + 멱등성", async () => {
    const result = await ensureWorktree({
      slug: "auth-refactor",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });

    // 경로 포맷: {rootDir}/.codex-swarm/wt-{slug}
    assert.ok(result.worktreePath.includes(".codex-swarm/wt-auth-refactor"));
    // 브랜치 포맷: swarm/{runId}/{slug}
    assert.equal(result.branchName, "swarm/test-run/auth-refactor");
    // 디렉토리 존재
    assert.ok(existsSync(result.worktreePath.replace(/\//g, "\\")));

    // 멱등성: 재호출 시 같은 결과
    const result2 = await ensureWorktree({
      slug: "auth-refactor",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });
    assert.equal(result2.worktreePath, result.worktreePath);
    assert.equal(result2.branchName, result.branchName);
  });

  it("W-02: prepareIntegrationBranch — integration 브랜치 생성", async () => {
    const result = await prepareIntegrationBranch({
      runId: "test-run",
      baseBranch: "main",
      rootDir: repoDir,
    });

    assert.equal(result.integrationBranch, "swarm/test-run/merge");
    assert.ok(result.baseCommit); // 40-char SHA

    // 브랜치 존재 확인
    const branches = execFileSync(
      "git",
      ["branch", "--list", result.integrationBranch],
      { cwd: repoDir, windowsHide: true },
    )
      .toString()
      .trim();
    assert.ok(branches.includes("swarm/test-run/merge"));

    // 멱등성: 재호출 시 에러 없음 (branch -f로 리셋)
    const result2 = await prepareIntegrationBranch({
      runId: "test-run",
      baseBranch: "main",
      rootDir: repoDir,
    });
    assert.equal(result2.integrationBranch, result.integrationBranch);
  });

  it("W-03: pruneWorktree — worktree + 브랜치 정리", async () => {
    // 먼저 worktree 생성
    const wt = await ensureWorktree({
      slug: "cleanup-test",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });
    assert.ok(existsSync(wt.worktreePath.replace(/\//g, "\\")));

    // prune
    await pruneWorktree({
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      rootDir: repoDir,
    });

    // worktree 디렉토리 제거됨
    assert.equal(existsSync(wt.worktreePath.replace(/\//g, "\\")), false);

    // 브랜치도 삭제됨
    const branches = execFileSync("git", ["branch", "--list", wt.branchName], {
      cwd: repoDir,
      windowsHide: true,
    })
      .toString()
      .trim();
    assert.equal(branches, "");
  });

  it("W-04: ensureWorktree — .claude-plugin 디렉토리가 자동 제거된다 (#34 L2)", async () => {
    // main 브랜치에 .claude-plugin/ 생성 후 커밋
    const pluginDir = join(repoDir, ".claude-plugin");
    mkdirSync(pluginDir, { recursive: true });
    const pluginJson = join(pluginDir, "plugin.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pluginJson, '{"name":"triflux"}');
    execFileSync("git", ["add", ".claude-plugin"], {
      cwd: repoDir,
      windowsHide: true,
    });
    execFileSync("git", ["commit", "-m", "add plugin"], {
      cwd: repoDir,
      windowsHide: true,
    });

    // worktree 생성
    const wt = await ensureWorktree({
      slug: "plugin-test",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });

    // .claude-plugin이 worktree에서 제거됨
    const wtPluginDir = join(
      wt.worktreePath.replace(/\//g, "\\"),
      ".claude-plugin",
    );
    assert.equal(
      existsSync(wtPluginDir),
      false,
      ".claude-plugin should be removed from worktree",
    );

    // 원본 repo에서는 여전히 존재
    assert.ok(
      existsSync(pluginDir),
      ".claude-plugin should still exist in main repo",
    );
  });

  it("W-05: pruneOrphanWorktrees — 고아 디렉토리만 정리된다 (#34 L3)", async () => {
    // 정상 worktree 생성
    const wt = await ensureWorktree({
      slug: "valid-wt",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });
    const validPath = wt.worktreePath.replace(/\//g, "\\");
    assert.ok(existsSync(validPath));

    // 고아 디렉토리 수동 생성 (git worktree list에 등록 안 됨)
    const orphanDir = join(repoDir, ".codex-swarm", "wt-orphan-test");
    mkdirSync(orphanDir, { recursive: true });
    assert.ok(existsSync(orphanDir));

    // pruneOrphanWorktrees 실행
    const removed = await pruneOrphanWorktrees({ rootDir: repoDir });

    // 고아만 제거됨
    assert.ok(removed.includes("wt-orphan-test"), "orphan should be removed");
    assert.equal(existsSync(orphanDir), false, "orphan dir should not exist");

    // 정상 worktree는 보존됨
    assert.ok(existsSync(validPath), "valid worktree should still exist");
  });

  it("W-06: pruneOrphanWorktrees — .codex-swarm 없으면 빈 배열 반환", async () => {
    const removed = await pruneOrphanWorktrees({ rootDir: repoDir });
    assert.deepEqual(removed, []);
  });

  it("W-07: cleanupWorktree — main working tree 삭제를 차단한다", async () => {
    await assert.rejects(
      () =>
        cleanupWorktree({
          worktreePath: repoDir,
          branchName: "main",
          rootDir: repoDir,
          force: true,
        }),
      /main working tree/,
    );
  });

  it("W-08 (#127): rebaseShardOntoIntegration — cherry-pick applies shard commits to integration", async () => {
    const { writeFileSync } = await import("node:fs");
    const wt = await ensureWorktree({
      slug: "cp-basic",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });
    const wtPath = wt.worktreePath.replace(/\//g, "\\");

    writeFileSync(join(wtPath, "shard-file.txt"), "shard content\n");
    execFileSync("git", ["add", "shard-file.txt"], {
      cwd: wtPath,
      windowsHide: true,
    });
    execFileSync("git", ["commit", "-m", "shard commit"], {
      cwd: wtPath,
      windowsHide: true,
    });

    const integ = await prepareIntegrationBranch({
      runId: "test-run",
      baseBranch: "main",
      rootDir: repoDir,
    });

    const result = await rebaseShardOntoIntegration({
      shardBranch: wt.branchName,
      integrationBranch: integ.integrationBranch,
      rootDir: repoDir,
    });

    assert.equal(result.ok, true, `cherry-pick should succeed: ${result.error || ""}`);
    assert.ok(result.headCommit, "headCommit should be returned");

    const lsTree = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", integ.integrationBranch],
      { cwd: repoDir, windowsHide: true },
    )
      .toString()
      .trim();
    assert.ok(
      lsTree.split("\n").includes("shard-file.txt"),
      "shard-file.txt must appear in integration tree",
    );
  });

  it("W-10 (#127 BUG-E): rebaseShardOntoIntegration — restores caller HEAD, never escapes to integrationBranch", async () => {
    // 회귀 방지: 함수 호출 후 main repo HEAD 가 integrationBranch 로 새어나가면
    // 사용자의 다음 Edit/commit 이 swarm 임시 브랜치로 silently 들어감
    // (2026-04-20 관찰 — probe + 후속 commit 들이 swarm/.../merge 에 갇혔던 사고).
    const { writeFileSync } = await import("node:fs");
    const wt = await ensureWorktree({
      slug: "head-escape",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });
    const wtPath = wt.worktreePath.replace(/\//g, "\\");
    writeFileSync(join(wtPath, "x.txt"), "x\n");
    execFileSync("git", ["add", "x.txt"], { cwd: wtPath, windowsHide: true });
    execFileSync("git", ["commit", "-m", "x"], { cwd: wtPath, windowsHide: true });

    const integ = await prepareIntegrationBranch({
      runId: "test-run",
      baseBranch: "main",
      rootDir: repoDir,
    });

    const headBefore = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, windowsHide: true },
    )
      .toString()
      .trim();
    assert.equal(headBefore, "main", "precondition: HEAD must be main");

    await rebaseShardOntoIntegration({
      shardBranch: wt.branchName,
      integrationBranch: integ.integrationBranch,
      rootDir: repoDir,
    });

    const headAfter = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, windowsHide: true },
    )
      .toString()
      .trim();
    assert.equal(
      headAfter,
      "main",
      "regression: rebaseShardOntoIntegration must restore caller HEAD",
    );
  });

  it("W-09 (#127): rebaseShardOntoIntegration — succeeds even when shard branch is checked out by worktree", async () => {
    // 회귀 방지: 이전엔 git rebase 가 'branch already used by worktree' 로 실패
    const { writeFileSync } = await import("node:fs");
    const wt = await ensureWorktree({
      slug: "cp-contention",
      runId: "test-run",
      rootDir: repoDir,
      baseBranch: "main",
    });
    const wtPath = wt.worktreePath.replace(/\//g, "\\");

    writeFileSync(join(wtPath, "contention.txt"), "from worker\n");
    execFileSync("git", ["add", "contention.txt"], {
      cwd: wtPath,
      windowsHide: true,
    });
    execFileSync("git", ["commit", "-m", "worker commit"], {
      cwd: wtPath,
      windowsHide: true,
    });

    const integ = await prepareIntegrationBranch({
      runId: "test-run",
      baseBranch: "main",
      rootDir: repoDir,
    });

    // worktree alive 상태 — cleanup 안 함
    const result = await rebaseShardOntoIntegration({
      shardBranch: wt.branchName,
      integrationBranch: integ.integrationBranch,
      rootDir: repoDir,
    });

    assert.equal(
      result.ok,
      true,
      `cherry-pick must not fail with worktree alive: ${result.error || ""}`,
    );
    assert.ok(
      !/already used by worktree/i.test(result.error || ""),
      "regression: rebase-style 'already used by worktree' must not appear",
    );
  });
});
