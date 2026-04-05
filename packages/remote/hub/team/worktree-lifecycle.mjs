// hub/team/worktree-lifecycle.mjs — Git worktree lifecycle management
// Replaces shell commands in tfx-codex-swarm Step 5 + merge-worktree Phase 6.
// Convention: .codex-swarm/wt-{slug} paths, swarm/{runId}/{slug} branches.
// Remote support: host option → SSH-based git operations via remote-session.mjs.

import { execFile } from 'node:child_process';
import { resolve, normalize } from 'node:path';
import { mkdir, rm, access } from 'node:fs/promises';
import { remoteGit } from './remote-session.mjs';

const SWARM_ROOT = '.codex-swarm';
const SLEEP_MS = 2000; // WT race-guard (MEMORY.md: wt-attach-spacing)

function git(args, cwd) {
  return new Promise((res, rej) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `git ${args[0]} failed: ${stderr?.trim() || err.message}`;
        rej(new Error(msg));
      } else {
        res(stdout.trim());
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Normalize path for Windows compatibility. */
function normPath(p) {
  return normalize(p).replace(/\\/g, '/');
}

/**
 * Create a worktree for a shard.
 *
 * @param {object} opts
 * @param {string} opts.slug — shard identifier (e.g. "issue-42" or "auth-refactor")
 * @param {string} opts.runId — swarm run ID
 * @param {string} [opts.rootDir=process.cwd()] — repo root
 * @param {string} [opts.baseBranch='main'] — base branch to branch from
 * @param {string} [opts.host] — SSH host for remote worktree creation
 * @param {object} [opts.remoteEnv] — remote environment from probeRemoteEnv()
 * @returns {Promise<{ worktreePath: string, branchName: string, remote: boolean }>}
 */
export async function ensureWorktree({ slug, runId, rootDir = process.cwd(), baseBranch = 'main', host, remoteEnv }) {
  const branchName = `swarm/${runId}/${slug}`;

  // ── Remote path: SSH-based worktree creation ──
  if (host && remoteEnv) {
    const remoteRoot = rootDir.replace(/\\/g, '/');
    const remoteWtDir = `${remoteRoot}/${SWARM_ROOT}/wt-${slug}`;

    try { remoteGit(host, remoteEnv, ['worktree', 'prune'], remoteRoot); } catch { /* best-effort */ }

    try {
      remoteGit(host, remoteEnv, ['worktree', 'add', remoteWtDir, '-b', branchName, baseBranch], remoteRoot);
    } catch {
      try {
        remoteGit(host, remoteEnv, ['worktree', 'add', remoteWtDir, branchName], remoteRoot);
      } catch { /* already exists — acceptable */ }
    }

    return { worktreePath: remoteWtDir, branchName, remote: true };
  }

  // ── Local path (existing logic) ──
  const wtDir = resolve(rootDir, SWARM_ROOT, `wt-${slug}`);

  await mkdir(resolve(rootDir, SWARM_ROOT), { recursive: true });

  // Check if worktree already exists
  try {
    await access(wtDir);
    await git(['rev-parse', '--is-inside-work-tree'], wtDir);
    return { worktreePath: normPath(wtDir), branchName, remote: false };
  } catch {
    // Doesn't exist or invalid — create fresh
  }

  try {
    await git(['worktree', 'prune'], rootDir);
  } catch { /* best-effort */ }

  await sleep(SLEEP_MS);

  try {
    await git(['worktree', 'add', wtDir, '-b', branchName, baseBranch], rootDir);
  } catch {
    await git(['worktree', 'add', wtDir, branchName], rootDir);
  }

  return { worktreePath: normPath(wtDir), branchName, remote: false };
}

/**
 * Create a temporary integration branch for merge operations.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.baseBranch
 * @param {string} [opts.rootDir=process.cwd()]
 * @returns {Promise<{ integrationBranch: string, baseCommit: string }>}
 */
export async function prepareIntegrationBranch({ runId, baseBranch, rootDir = process.cwd() }) {
  const integrationBranch = `swarm/${runId}/merge`;

  // Record base commit for rollback
  const baseCommit = await git(['rev-parse', baseBranch], rootDir);

  // Create integration branch from base
  try {
    await git(['branch', integrationBranch, baseBranch], rootDir);
  } catch {
    // Branch may already exist — reset to base
    await git(['branch', '-f', integrationBranch, baseBranch], rootDir);
  }

  return { integrationBranch, baseCommit };
}

/**
 * Rebase a shard branch onto the integration branch.
 * Uses rebase + fast-forward only (no merge commits).
 *
 * @param {object} opts
 * @param {string} opts.shardBranch — the shard's branch name
 * @param {string} opts.integrationBranch — target integration branch
 * @param {string} [opts.rootDir=process.cwd()]
 * @returns {Promise<{ ok: boolean, headCommit?: string, error?: string }>}
 */
export async function rebaseShardOntoIntegration({ shardBranch, integrationBranch, rootDir = process.cwd() }) {
  // Backup integration HEAD for rollback
  const backupCommit = await git(['rev-parse', integrationBranch], rootDir);

  try {
    // Rebase shard onto integration
    await git(['rebase', integrationBranch, shardBranch], rootDir);

    // Fast-forward integration to include shard changes
    await git(['checkout', integrationBranch], rootDir);
    await git(['merge', '--ff-only', shardBranch], rootDir);

    const headCommit = await git(['rev-parse', 'HEAD'], rootDir);
    return { ok: true, headCommit };
  } catch (err) {
    // Abort rebase and restore integration branch
    try { await git(['rebase', '--abort'], rootDir); } catch { /* already clean */ }
    try { await git(['checkout', integrationBranch], rootDir); } catch { /* best-effort */ }
    try { await git(['reset', '--hard', backupCommit], rootDir); } catch { /* best-effort */ }

    return { ok: false, error: err.message };
  }
}

/**
 * Remove a worktree and its branch.
 * Follows WT race-guard: sleep between operations.
 *
 * @param {object} opts
 * @param {string} opts.worktreePath
 * @param {string} [opts.branchName] — optional branch to delete
 * @param {string} [opts.rootDir=process.cwd()]
 * @param {boolean} [opts.force=false]
 */
export async function pruneWorktree({ worktreePath, branchName, rootDir = process.cwd(), force = false }) {
  const forceFlag = force ? '--force' : '';

  // Remove worktree (with retry for Windows file handle issues — E5)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await git(['worktree', 'remove', worktreePath, ...(forceFlag ? [forceFlag] : [])], rootDir);
      break;
    } catch (err) {
      if (attempt === 2) {
        // Last resort: rm the directory and prune
        try { await rm(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      await sleep(SLEEP_MS);
    }
  }

  // Prune stale worktree references
  await sleep(SLEEP_MS);
  try { await git(['worktree', 'prune'], rootDir); } catch { /* best-effort */ }

  // Delete branch if specified
  if (branchName) {
    try { await git(['branch', '-D', branchName], rootDir); } catch { /* may not exist */ }
  }
}
