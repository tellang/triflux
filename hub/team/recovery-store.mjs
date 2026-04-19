// hub/team/recovery-store.mjs — Best-effort preservation of worker changes
// before a dirty worktree is removed. Uses file-based `.patch` + JSON manifest
// instead of git stash (git-preflight flags stash-pop/worktree-remove as risky).

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_RECOVERY_DIR = ".codex-swarm/recovery";

function git(args, cwd) {
  return new Promise((res) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          res({ ok: false, stderr: stderr?.toString() || err.message });
        } else {
          res({ ok: true, stdout });
        }
      },
    );
  });
}

function manifestPath(recoveryDir) {
  return join(recoveryDir, "manifest.json");
}

function readManifestFile(recoveryDir) {
  const path = manifestPath(recoveryDir);
  if (!existsSync(path)) return { entries: [] };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) return parsed;
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeManifestFile(recoveryDir, data) {
  writeFileSync(manifestPath(recoveryDir), JSON.stringify(data, null, 2));
}

/**
 * Preserve an uncommitted worker patch before the worktree is removed.
 *
 * Contract:
 *  - Never throws.
 *  - Dirty worktree  → write {recoveryDir}/{shardId}.patch, append manifest entry.
 *  - Clean worktree  → return {ok: true, skipped: true}, no files written.
 *  - Missing/invalid → return {ok: false, reason}, no throw.
 *
 * Patch captures `git diff HEAD` output (unified diff) — this covers both
 * staged and unstaged changes relative to the shard's base commit.
 *
 * @param {object} opts
 * @param {string} opts.worktreePath     — absolute path to the worker worktree
 * @param {string} opts.shardId          — shard identifier (used for filename)
 * @param {string} [opts.recoveryDir]    — default: `<worktreePath>/.codex-swarm/recovery`
 *                                         when running inside worktree root;
 *                                         callers typically pass repo-root relative path.
 * @returns {Promise<
 *   | { ok: true, patchPath: string, manifestPath: string }
 *   | { ok: true, skipped: true }
 *   | { ok: false, reason: string }
 * >}
 */
export async function preserveWorktreePatch(opts = {}) {
  const { worktreePath, shardId } = opts;

  if (!worktreePath || typeof worktreePath !== "string") {
    return { ok: false, reason: "missing_worktree_path" };
  }
  if (!shardId || typeof shardId !== "string") {
    return { ok: false, reason: "missing_shard_id" };
  }
  if (!existsSync(worktreePath)) {
    return { ok: false, reason: "worktree_path_not_found" };
  }

  const recoveryDir = opts.recoveryDir
    ? resolve(opts.recoveryDir)
    : resolve(worktreePath, DEFAULT_RECOVERY_DIR);

  // Quickly classify dirty vs clean. `git status --porcelain` is safe and fast.
  const status = await git(["status", "--porcelain"], worktreePath);
  if (!status.ok) {
    return { ok: false, reason: `git_status_failed: ${status.stderr}` };
  }

  if (status.stdout.trim().length === 0) {
    return { ok: true, skipped: true };
  }

  // Dirty — capture diff.
  const diff = await git(["diff", "HEAD"], worktreePath);
  if (!diff.ok) {
    return { ok: false, reason: `git_diff_failed: ${diff.stderr}` };
  }

  try {
    mkdirSync(recoveryDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `mkdir_failed: ${err.message}` };
  }

  const safeShardId = shardId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const patchPath = join(recoveryDir, `${safeShardId}.patch`);
  try {
    writeFileSync(patchPath, diff.stdout);
  } catch (err) {
    return { ok: false, reason: `patch_write_failed: ${err.message}` };
  }

  const manifest = readManifestFile(recoveryDir);
  manifest.entries.push({
    shard: shardId,
    patch: patchPath,
    timestamp: new Date().toISOString(),
  });
  try {
    writeManifestFile(recoveryDir, manifest);
  } catch (err) {
    return { ok: false, reason: `manifest_write_failed: ${err.message}` };
  }

  return { ok: true, patchPath, manifestPath: manifestPath(recoveryDir) };
}

/**
 * Read the recovery manifest. Returns {entries: []} if missing or invalid.
 * @param {string} recoveryDir
 * @returns {{ entries: Array<{ shard: string, patch: string, timestamp: string }> }}
 */
export function readManifest(recoveryDir) {
  if (!recoveryDir || typeof recoveryDir !== "string") {
    return { entries: [] };
  }
  return readManifestFile(resolve(recoveryDir));
}

export const RECOVERY_DEFAULTS = Object.freeze({
  dir: DEFAULT_RECOVERY_DIR,
});
