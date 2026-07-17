// hub/team/worktree-lifecycle.mjs — Git worktree lifecycle management
// Replaces shell commands in tfx-codex-swarm Step 5 + merge-worktree Phase 6.
// Convention: .codex-swarm/wt-{slug} paths, swarm/{runId}/{slug} branches.
// Remote support: host option → SSH-based git operations via remote-session.mjs.

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, relative, resolve } from "node:path";
import { remoteGit, validateHost } from "./remote-session.mjs";

const SWARM_ROOT = ".codex-swarm";
const SLEEP_MS = 2000; // WT race-guard (MEMORY.md: wt-attach-spacing)

// Tracked files intentionally removed from swarm worktrees. Keep this list
// narrow: .claude-plugin metadata must be preserved for Codex worker startup.
export const EXPECTED_WORKTREE_DELETIONS = Object.freeze([]);

/**
 * Parse `git status --short` output into a dirty-file list. Filters out paths
 * in `expectedDeletions` only when the XY status code indicates a deletion
 * (X='D' or Y='D'). Modifications / additions / untracked of the same paths
 * remain dirty — otherwise a worker could silently corrupt those files and
 * bypass F6 no_commit_guard (Codex review #134 round 2).
 *
 * git status --short XY codes reference:
 *   ' D' unstaged delete, 'D ' staged delete, 'DD' both — filtered if path
 *     is in expectedDeletions.
 *   ' M'/'M '/'MM' modify, '??' untracked, 'A ' add, 'R ' rename — kept.
 *
 * @param {string} rawStatus — stdout of `git status --short`
 * @param {string[]} [expectedDeletions=EXPECTED_WORKTREE_DELETIONS] — paths eligible for deletion-only skip
 * @returns {string[]} — remaining dirty paths after filtering
 */
export function extractDirtyFiles(
  rawStatus,
  expectedDeletions = EXPECTED_WORKTREE_DELETIONS,
) {
  const skip = new Set(expectedDeletions);
  const out = [];
  for (const raw of String(rawStatus ?? "").split(/\r?\n/)) {
    if (raw.length < 3) continue;
    const xy = raw.slice(0, 2);
    const path = raw.slice(2).trim();
    if (!path) continue;
    const isDeletion = xy.includes("D");
    if (isDeletion && skip.has(path)) continue;
    out.push(path);
  }
  return out;
}

function git(args, cwd) {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Triflux",
          GIT_AUTHOR_EMAIL:
            process.env.GIT_AUTHOR_EMAIL || "triflux@example.invalid",
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Triflux",
          GIT_COMMITTER_EMAIL:
            process.env.GIT_COMMITTER_EMAIL || "triflux@example.invalid",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = `git ${args[0]} failed: ${stderr?.trim() || err.message}`;
          rej(new Error(msg));
        } else {
          res(stdout.trim());
        }
      },
    );
  });
}

/**
 * Best-effort shutdown for the Git fsmonitor daemon attached to a worktree.
 * Missing or already-stopped daemons are treated as successful no-ops because
 * cleanup should not be blocked by watcher state.
 *
 * @param {string} worktreePath
 * @param {(args: string[], cwd: string) => Promise<string>} [gitImpl=git]
 * @returns {Promise<{ ok: boolean, stopped: boolean, reason?: 'not_running', error?: string }>}
 */
async function stopFsmonitorDaemon(worktreePath, gitImpl = git) {
  try {
    await gitImpl(["fsmonitor--daemon", "stop"], worktreePath);
    return { ok: true, stopped: true };
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (
      /not running|not watching|fsmonitor--daemon is not running/iu.test(msg)
    ) {
      return { ok: true, stopped: false, reason: "not_running" };
    }
    return { ok: false, stopped: false, error: msg };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Normalize path for Windows compatibility. */
function normPath(p) {
  return normalize(p).replace(/\\/g, "/");
}

async function normExistingPath(p) {
  try {
    return normPath(await realpath(p));
  } catch {
    return normPath(p);
  }
}

function resolveCleanupTarget(worktreePath, rootDir) {
  const resolvedRoot = resolve(rootDir);
  const resolvedWorktree = resolve(worktreePath);
  const normalizedRoot = normPath(resolvedRoot).replace(/\/+$/u, "");
  const normalizedWorktree = normPath(resolvedWorktree).replace(/\/+$/u, "");

  if (normalizedWorktree === normalizedRoot) {
    throw new Error("refusing to cleanup the main working tree");
  }

  const rel = normPath(relative(resolvedRoot, resolvedWorktree));
  if (
    !rel ||
    rel === "." ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.includes("/../")
  ) {
    throw new Error(
      `refusing to cleanup path outside rootDir: ${worktreePath}`,
    );
  }

  const allowed =
    rel.startsWith(".codex-swarm/wt-") || rel.startsWith(".triflux/");
  if (!allowed) {
    throw new Error(`refusing to cleanup unsafe path: ${worktreePath}`);
  }

  return {
    resolvedRoot,
    resolvedWorktree,
    normalizedWorktree,
  };
}

async function branchExists(branchName, rootDir, gitImpl = git) {
  if (!branchName) return false;
  try {
    const listed = await gitImpl(["branch", "--list", branchName], rootDir);
    return listed.trim().length > 0;
  } catch {
    return false;
  }
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
export async function ensureWorktree({
  slug,
  runId,
  rootDir = process.cwd(),
  baseBranch = "main",
  host,
  remoteEnv,
}) {
  const branchName = `swarm/${runId}/${slug}`;

  // ── Remote path: SSH-based worktree creation ──
  if (host && remoteEnv) {
    const remoteRoot = rootDir.replace(/\\/g, "/");
    const remoteWtDir = `${remoteRoot}/${SWARM_ROOT}/wt-${slug}`;

    try {
      remoteGit(host, remoteEnv, ["worktree", "prune"], remoteRoot);
    } catch {
      /* best-effort */
    }

    try {
      remoteGit(
        host,
        remoteEnv,
        ["worktree", "add", remoteWtDir, "-b", branchName, baseBranch],
        remoteRoot,
      );
    } catch {
      try {
        remoteGit(
          host,
          remoteEnv,
          ["worktree", "add", remoteWtDir, branchName],
          remoteRoot,
        );
      } catch {
        /* already exists — acceptable */
      }
    }

    return { worktreePath: remoteWtDir, branchName, remote: true };
  }

  // ── Local path (existing logic) ──
  const wtDir = resolve(rootDir, SWARM_ROOT, `wt-${slug}`);

  await mkdir(resolve(rootDir, SWARM_ROOT), { recursive: true });

  // Check if worktree already exists
  try {
    await access(wtDir);
    await git(["rev-parse", "--is-inside-work-tree"], wtDir);
    return { worktreePath: normPath(wtDir), branchName, remote: false };
  } catch {
    // Doesn't exist or invalid — create fresh
  }

  try {
    await git(["worktree", "prune"], rootDir);
  } catch {
    /* best-effort */
  }

  await sleep(SLEEP_MS);

  try {
    await git(
      ["worktree", "add", wtDir, "-b", branchName, baseBranch],
      rootDir,
    );
  } catch {
    await git(["worktree", "add", wtDir, branchName], rootDir);
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
export async function prepareIntegrationBranch({
  runId,
  baseBranch,
  rootDir = process.cwd(),
}) {
  const integrationBranch = `swarm/${runId}/merge`;

  // Record base commit for rollback
  const baseCommit = await git(["rev-parse", baseBranch], rootDir);

  // Create integration branch from base
  try {
    await git(["branch", integrationBranch, baseBranch], rootDir);
  } catch {
    // Branch may already exist — reset to base
    await git(["branch", "-f", integrationBranch, baseBranch], rootDir);
  }

  return { integrationBranch, baseCommit };
}

/**
 * Rebase a shard branch onto the integration branch.
 * Uses rebase + fast-forward only (no merge commits).
 *
 * Synapse v1: when a `preflight` checker + `sessionContext` are provided,
 * the rebase is pre-flighted against active sessions' dirty files/leases.
 * Blocked rebases return `{ ok: false, preflight: decision }` without touching
 * any branch. If preflight is omitted, behavior is unchanged.
 *
 * @param {object} opts
 * @param {string} opts.shardBranch — the shard's branch name
 * @param {string} opts.integrationBranch — target integration branch
 * @param {string} [opts.rootDir=process.cwd()]
 * @param {{ checkRebase: Function } | null} [opts.preflight=null] — git-preflight instance
 * @param {{ sessionId: string, workerId?: string } | null} [opts.sessionContext=null]
 * @returns {Promise<{ ok: boolean, headCommit?: string, strategy?: string, commits?: number, notes?: string, fallbackReason?: string, error?: string, preflight?: object }>}
 */
export async function rebaseShardOntoIntegration({
  shardBranch,
  integrationBranch,
  rootDir = process.cwd(),
  preflight = null,
  sessionContext = null,
}) {
  // Synapse v1 pre-flight: bail out before mutating branches when another
  // session claims overlapping files.
  if (preflight && sessionContext) {
    const decision = preflight.checkRebase(
      { branch: integrationBranch },
      sessionContext,
    );
    if (!decision.allowed) {
      return {
        ok: false,
        error: `git-preflight blocked rebase: ${decision.reason || "overlap"}`,
        preflight: decision,
      };
    }
  }

  // #127 BUG-E accident history: this function used to checkout the
  // integration branch in rootDir, leak rootDir HEAD, and redirect later user
  // edits/commits into swarm/.../merge. Integration now happens exclusively in
  // a disposable worktree, so rootDir HEAD never moves and needs no restore.
  //
  // #129 BUG-J accident history: checkout failure was followed by a blind
  // reset --hard (or branch -f rollback) against rootDir, which rewound the
  // caller branch. Rollback now resets only the disposable worktree; there is
  // no rootDir reset path and therefore no stash-create last-resort path.
  const backupCommit = await git(["rev-parse", integrationBranch], rootDir);

  let shaList = [];
  let ffError = null;
  let integrationWorktreeAdded = false;
  const integrationWorktree = await mkdtemp(
    join(tmpdir(), "tfx-swarm-integration-"),
  );

  try {
    const log = await git(
      [
        "log",
        "--reverse",
        "--format=%H",
        `${integrationBranch}..${shardBranch}`,
      ],
      rootDir,
    );
    shaList = log
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    await git(
      ["worktree", "add", "--quiet", integrationWorktree, integrationBranch],
      rootDir,
    );
    integrationWorktreeAdded = true;

    try {
      await git(["merge", "--ff-only", shardBranch], integrationWorktree);
      const headCommit = await git(["rev-parse", "HEAD"], integrationWorktree);
      return {
        ok: true,
        headCommit,
        strategy: "auto-ff",
        commits: shaList.length,
        notes: "linear (merge --ff-only)",
      };
    } catch (err) {
      ffError = err;
      try {
        await git(["merge", "--abort"], integrationWorktree);
      } catch {
        /* ff-only usually leaves no merge state */
      }
      try {
        // Safe destructive operation: this cwd is the disposable integration
        // worktree, never rootDir. It restores the integration ref before the
        // cherry-pick fallback without touching user files.
        await git(["reset", "--hard", backupCommit], integrationWorktree);
      } catch {
        /* fallback below will report if cherry-pick also fails */
      }
    }

    // #127: cherry-pick fallback instead of branch merge. Rebase/ff paths can
    // fail when histories diverge or a shard branch is checked out by a swarm
    // worktree. Cherry-pick reads commits without moving the shard branch ref.
    for (const sha of shaList) {
      await git(["cherry-pick", sha], integrationWorktree);
    }

    const headCommit = await git(["rev-parse", "HEAD"], integrationWorktree);
    return {
      ok: true,
      headCommit,
      strategy: "cherry-pick",
      commits: shaList.length,
      fallbackReason: ffError?.message || null,
      notes: ffError
        ? `auto-ff failed: ${ffError.message}`
        : "cherry-pick fallback",
    };
  } catch (err) {
    if (integrationWorktreeAdded) {
      try {
        await git(["cherry-pick", "--abort"], integrationWorktree);
      } catch {
        /* already clean */
      }
      try {
        // #129 rollback is now local to the disposable integration worktree.
        await git(["reset", "--hard", backupCommit], integrationWorktree);
      } catch {
        /* best-effort */
      }
    }

    return {
      ok: false,
      error: err.message,
      strategy: "failed",
      commits: shaList.length,
      fallbackReason: ffError?.message || null,
    };
  } finally {
    if (integrationWorktreeAdded) {
      try {
        await git(
          ["worktree", "remove", "--force", integrationWorktree],
          rootDir,
        );
      } catch {
        await rm(integrationWorktree, { recursive: true, force: true });
        try {
          await git(["worktree", "prune"], rootDir);
        } catch {
          /* best-effort metadata cleanup */
        }
      }
    } else {
      await rm(integrationWorktree, { recursive: true, force: true });
    }
  }
}

/**
 * Safely remove a worktree directory and delete its branch.
 * Refuses to touch the main working tree or paths outside known swarm state.
 *
 * @param {object} opts
 * @param {string} opts.worktreePath
 * @param {string} [opts.branchName]
 * @param {string} [opts.rootDir=process.cwd()]
 * @param {boolean} [opts.force=false]
 */
export async function cleanupWorktree({
  worktreePath,
  branchName,
  rootDir = process.cwd(),
  force = false,
  _git = git,
}) {
  const { resolvedWorktree } = resolveCleanupTarget(worktreePath, rootDir);
  const fsmonitorStop = await stopFsmonitorDaemon(resolvedWorktree, _git);
  const forceArgs = force ? ["--force"] : [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await _git(
        ["worktree", "remove", ...forceArgs, resolvedWorktree],
        rootDir,
      );
      break;
    } catch (_err) {
      if (attempt === 2) {
        try {
          await rm(resolvedWorktree, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      await sleep(SLEEP_MS);
    }
  }

  await sleep(SLEEP_MS);
  try {
    await _git(["worktree", "prune"], rootDir);
  } catch {
    /* best-effort */
  }

  if (branchName && (await branchExists(branchName, rootDir, _git))) {
    try {
      await _git(["branch", "-D", branchName], rootDir);
    } catch {
      /* branch may already be gone */
    }
  }

  return { ok: true, fsmonitorStop };
}

/**
 * Remove a worktree and its branch.
 * Follows WT race-guard: sleep between operations.
 *
 * Synapse v1: when `preflight` + `sessionContext` are provided, the removal
 * is pre-flighted against active sessions — blocked if another session is
 * still registered to this worktree path.
 *
 * @param {object} opts
 * @param {string} opts.worktreePath
 * @param {string} [opts.branchName] — optional branch to delete
 * @param {string} [opts.rootDir=process.cwd()]
 * @param {boolean} [opts.force=false]
 * @param {{ checkWorktreeRemove: Function } | null} [opts.preflight=null]
 * @param {{ sessionId: string, workerId?: string } | null} [opts.sessionContext=null]
 */
export async function pruneWorktree({
  worktreePath,
  branchName,
  rootDir = process.cwd(),
  force = false,
  preflight = null,
  sessionContext = null,
}) {
  if (preflight && sessionContext) {
    const decision = preflight.checkWorktreeRemove(
      { worktreePath },
      sessionContext,
    );
    if (!decision.allowed) {
      return {
        ok: false,
        error: `git-preflight blocked worktree-remove: ${decision.reason || "active_worktree"}`,
        preflight: decision,
      };
    }
  }

  const cleanupResult = await cleanupWorktree({
    worktreePath,
    branchName,
    rootDir,
    force,
  });

  return { ok: true, fsmonitorStop: cleanupResult.fsmonitorStop };
}

/**
 * #34 L3: Detect and remove orphan worktree directories.
 * Compares .codex-swarm/wt-* directories against `git worktree list`.
 * Directories not registered as worktrees are removed.
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir=process.cwd()]
 * @returns {Promise<string[]>} removed directory names
 */
export async function pruneOrphanWorktrees({ rootDir = process.cwd() } = {}) {
  const swarmDir = resolve(rootDir, SWARM_ROOT);
  const removed = [];

  let entries;
  try {
    entries = await readdir(swarmDir);
  } catch {
    return removed; // .codex-swarm/ doesn't exist → nothing to clean
  }

  const wtDirs = entries.filter((e) => e.startsWith("wt-"));
  if (wtDirs.length === 0) return removed;

  // Get registered worktree paths from git
  let registeredPaths;
  try {
    const raw = await git(["worktree", "list", "--porcelain"], rootDir);
    registeredPaths = new Set(
      await Promise.all(
        raw
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => normExistingPath(l.slice("worktree ".length))),
      ),
    );
  } catch {
    return removed; // git worktree list failed → don't remove anything
  }

  for (const dir of wtDirs) {
    const fullPath = resolve(swarmDir, dir);
    const normalized = await normExistingPath(fullPath);
    if (!registeredPaths.has(normalized)) {
      try {
        await stopFsmonitorDaemon(fullPath).catch(() => null);
        await rm(fullPath, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        /* best-effort */
      }
    }
  }

  // Prune stale git references
  if (removed.length > 0) {
    try {
      await git(["worktree", "prune"], rootDir);
    } catch {
      /* best-effort */
    }
  }

  return removed;
}

/**
 * Fetch a remote shard's branch to the local repo via SSH.
 * Workaround for hosts that cannot push to GitHub (e.g. Ultra4).
 *
 * Flow: add temp remote → fetch branch → remove remote.
 *
 * @param {object} opts
 * @param {string} opts.host — SSH host (e.g. "ultra4")
 * @param {string} opts.sshUser — SSH user (e.g. "SSAFY")
 * @param {string} opts.remoteRepoPath — absolute path on remote (e.g. "/c/Users/SSAFY/Desktop/Projects/cli/triflux")
 * @param {string} opts.branchName — branch to fetch (e.g. "swarm/run123/auth")
 * @param {string} [opts.rootDir=process.cwd()] — local repo root
 * @returns {Promise<{ ok: boolean, localRef?: string, error?: string }>}
 */
export async function fetchRemoteShard({
  host,
  sshUser,
  remoteRepoPath,
  branchName,
  rootDir = process.cwd(),
}) {
  validateHost(host);

  const remoteName = `_swarm-${host}-${Date.now()}`;
  const sshUrl = `ssh://${sshUser}@${host}${remoteRepoPath}`;

  try {
    await git(["remote", "add", remoteName, sshUrl], rootDir);

    await git(["fetch", remoteName, branchName, "--no-tags"], rootDir);

    const localRef = `${remoteName}/${branchName}`;
    const headCommit = await git(["rev-parse", `FETCH_HEAD`], rootDir);

    return { ok: true, localRef, headCommit };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      await git(["remote", "remove", remoteName], rootDir);
    } catch {
      /* cleanup */
    }
  }
}
