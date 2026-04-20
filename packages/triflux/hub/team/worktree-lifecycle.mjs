// hub/team/worktree-lifecycle.mjs — Git worktree lifecycle management
// Replaces shell commands in tfx-codex-swarm Step 5 + merge-worktree Phase 6.
// Convention: .codex-swarm/wt-{slug} paths, swarm/{runId}/{slug} branches.
// Remote support: host option → SSH-based git operations via remote-session.mjs.

import { execFile } from "node:child_process";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";
import { remoteGit, validateHost } from "./remote-session.mjs";

const SWARM_ROOT = ".codex-swarm";
const SLEEP_MS = 2000; // WT race-guard (MEMORY.md: wt-attach-spacing)

// BUG-I: prepareWorktree 가 #34 L2 의도로 worktree 에서 rm 하는 tracked paths.
// swarm-hypervisor 의 commit_evidence dirty 판정에서 이 경로들을 filter 해야
// "의도된 삭제" 가 F6 no_commit_guard 를 잘못 trip 하는 것을 막을 수 있다.
export const EXPECTED_WORKTREE_DELETIONS = Object.freeze([
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
]);

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
      { cwd, windowsHide: true, timeout: 30_000 },
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Normalize path for Windows compatibility. */
function normPath(p) {
  return normalize(p).replace(/\\/g, "/");
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

async function branchExists(branchName, rootDir) {
  if (!branchName) return false;
  try {
    const listed = await git(["branch", "--list", branchName], rootDir);
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

  // #34 L2: worktree에 복사된 .claude-plugin 제거 (하네스가 PLUGIN_ROOT를 오인하는 것 방지)
  const pluginDir = join(wtDir, ".claude-plugin");
  try {
    await rm(pluginDir, { recursive: true, force: true });
  } catch {
    /* absent → ok */
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
 * @returns {Promise<{ ok: boolean, headCommit?: string, error?: string, preflight?: object }>}
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

  // #127 BUG-E: capture caller's branch BEFORE any checkout. Without
  // restoring it in finally, this function leaks main repo HEAD onto
  // integrationBranch and every subsequent Edit/commit lands on the swarm
  // temp branch silently (observed 2026-04-20: probe + edits + commits all
  // ended up on swarm/.../merge while user thought they were on main).
  let originalBranch = null;
  try {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir);
    if (head && head !== "HEAD") originalBranch = head;
  } catch {
    /* detached HEAD or unknown — skip restore */
  }

  // Backup integration HEAD for rollback
  const backupCommit = await git(["rev-parse", integrationBranch], rootDir);

  // #127: cherry-pick instead of rebase. Rebase fails when shardBranch is
  // already checked out by a swarm worktree ("branch already used by worktree").
  // Cherry-pick reads the shard's commits without touching its branch ref,
  // so worktree contention disappears. Memory: feedback_swarm_cherry_pick.
  try {
    const log = await git(
      ["log", "--reverse", "--format=%H", `${integrationBranch}..${shardBranch}`],
      rootDir,
    );
    const shaList = log.split("\n").map((s) => s.trim()).filter(Boolean);

    await git(["checkout", integrationBranch], rootDir);

    for (const sha of shaList) {
      await git(["cherry-pick", sha], rootDir);
    }

    const headCommit = await git(["rev-parse", "HEAD"], rootDir);
    return { ok: true, headCommit };
  } catch (err) {
    try {
      await git(["cherry-pick", "--abort"], rootDir);
    } catch {
      /* already clean */
    }

    // #129 BUG-J: Roll back integrationBranch without mutating whatever
    // branch HEAD currently points at. The previous implementation did a
    // blind `reset --hard backupCommit` on current HEAD — if the earlier
    // `git checkout integrationBranch` inside the try block failed (e.g.
    // integrationBranch was already checked out by a swarm worktree) the
    // caller's branch silently rewound to integrationBranch's backup commit.
    // Observed 2026-04-20: fix branch tree lost to main HEAD during swarm
    // probe, requiring `git merge --ff-only origin/<branch>` recovery.
    let currentBranch = null;
    try {
      const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir);
      if (head && head !== "HEAD") currentBranch = head;
    } catch {
      /* detached — fall through to ref-only update */
    }

    if (currentBranch === integrationBranch) {
      // HEAD is on integrationBranch — reset advances this branch only.
      try {
        await git(["reset", "--hard", backupCommit], rootDir);
      } catch {
        /* best-effort */
      }
    } else {
      // HEAD is elsewhere (originalBranch, detached, or another branch).
      // Update the integrationBranch ref directly; never touch current HEAD.
      try {
        await git(["branch", "-f", integrationBranch, backupCommit], rootDir);
      } catch {
        /* best-effort: branch may be checked out in another worktree */
      }
    }

    return { ok: false, error: err.message };
  } finally {
    // Always restore caller's branch. Skip if originalBranch is null
    // (detached HEAD case) or already on target.
    if (originalBranch) {
      try {
        await git(["checkout", originalBranch], rootDir);
      } catch {
        /* best-effort — caller will see HEAD on integrationBranch */
      }
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
}) {
  const { resolvedWorktree } = resolveCleanupTarget(worktreePath, rootDir);
  const forceArgs = force ? ["--force"] : [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await git(
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
    await git(["worktree", "prune"], rootDir);
  } catch {
    /* best-effort */
  }

  if (branchName && (await branchExists(branchName, rootDir))) {
    try {
      await git(["branch", "-D", branchName], rootDir);
    } catch {
      /* branch may already be gone */
    }
  }
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

  await cleanupWorktree({
    worktreePath,
    branchName,
    rootDir,
    force,
  });

  return { ok: true };
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
      raw
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => normPath(l.slice("worktree ".length))),
    );
  } catch {
    return removed; // git worktree list failed → don't remove anything
  }

  for (const dir of wtDirs) {
    const fullPath = resolve(swarmDir, dir);
    const normalized = normPath(fullPath);
    if (!registeredPaths.has(normalized)) {
      try {
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
