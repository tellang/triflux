// tests/unit/worktree-lifecycle.test.mjs — worktree-lifecycle 테스트 (Wave 5)
// 실제 temp git repo를 사용하여 worktree 생성/정리를 검증한다.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  ensureWorktree,
  prepareIntegrationBranch,
  pruneWorktree,
} from '../../hub/team/worktree-lifecycle.mjs';

function makeTmpRepo() {
  const dir = join(tmpdir(), `tfx-wt-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const g = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'test@test.com']);
  g(['config', 'user.name', 'Test']);
  // initial commit (worktree requires at least one commit)
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, windowsHide: true });
  return dir;
}

describe('worktree-lifecycle', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = makeTmpRepo();
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('W-01: ensureWorktree — 올바른 경로/브랜치 생성 + 멱등성', async () => {
    const result = await ensureWorktree({
      slug: 'auth-refactor',
      runId: 'test-run',
      rootDir: repoDir,
      baseBranch: 'main',
    });

    // 경로 포맷: {rootDir}/.codex-swarm/wt-{slug}
    assert.ok(result.worktreePath.includes('.codex-swarm/wt-auth-refactor'));
    // 브랜치 포맷: swarm/{runId}/{slug}
    assert.equal(result.branchName, 'swarm/test-run/auth-refactor');
    // 디렉토리 존재
    assert.ok(existsSync(result.worktreePath.replace(/\//g, '\\')));

    // 멱등성: 재호출 시 같은 결과
    const result2 = await ensureWorktree({
      slug: 'auth-refactor',
      runId: 'test-run',
      rootDir: repoDir,
      baseBranch: 'main',
    });
    assert.equal(result2.worktreePath, result.worktreePath);
    assert.equal(result2.branchName, result.branchName);
  });

  it('W-02: prepareIntegrationBranch — integration 브랜치 생성', async () => {
    const result = await prepareIntegrationBranch({
      runId: 'test-run',
      baseBranch: 'main',
      rootDir: repoDir,
    });

    assert.equal(result.integrationBranch, 'swarm/test-run/merge');
    assert.ok(result.baseCommit); // 40-char SHA

    // 브랜치 존재 확인
    const branches = execFileSync(
      'git', ['branch', '--list', result.integrationBranch],
      { cwd: repoDir, windowsHide: true },
    ).toString().trim();
    assert.ok(branches.includes('swarm/test-run/merge'));

    // 멱등성: 재호출 시 에러 없음 (branch -f로 리셋)
    const result2 = await prepareIntegrationBranch({
      runId: 'test-run',
      baseBranch: 'main',
      rootDir: repoDir,
    });
    assert.equal(result2.integrationBranch, result.integrationBranch);
  });

  it('W-03: pruneWorktree — worktree + 브랜치 정리', async () => {
    // 먼저 worktree 생성
    const wt = await ensureWorktree({
      slug: 'cleanup-test',
      runId: 'test-run',
      rootDir: repoDir,
      baseBranch: 'main',
    });
    assert.ok(existsSync(wt.worktreePath.replace(/\//g, '\\')));

    // prune
    await pruneWorktree({
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      rootDir: repoDir,
    });

    // worktree 디렉토리 제거됨
    assert.equal(existsSync(wt.worktreePath.replace(/\//g, '\\')), false);

    // 브랜치도 삭제됨
    const branches = execFileSync(
      'git', ['branch', '--list', wt.branchName],
      { cwd: repoDir, windowsHide: true },
    ).toString().trim();
    assert.equal(branches, '');
  });
});
