// hub/team/swarm-locks.mjs — File-level lease lock manager for swarm execution
// Prevents multiple workers from writing to the same file simultaneously.
// Lock state is kept in-memory (single-process hypervisor) with optional
// JSON persistence to .triflux/swarm-locks.json for crash recovery.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const LOCK_TTL_MS = 10 * 60_000; // 10 minutes default TTL

// Distribution-critical paths. A swarm worker that modifies these without
// having them explicitly listed in its shard lease is almost certainly a
// recovery-patch fallout (worker exited before commit, hypervisor saved
// patch with destructive `+++ /dev/null` deletions). Block by default;
// override via validateChanges options.sensitiveDeny.
//
// Paths use POSIX separators (matches normalizePath output).
const SENSITIVE_PATH_PREFIXES = [
  ".claude-plugin/",
  "bin/",
  ".github/workflows/",
];
const SENSITIVE_PATH_FILES = [
  ".gitignore",
  ".npmignore",
  "package.json",
  "package-lock.json",
  "biome.json",
];

/**
 * Swarm lock manager factory.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — repository root for relative path normalization
 * @param {string} [opts.persistPath] — JSON file path for crash recovery persistence
 * @param {number} [opts.ttlMs=600000] — lock TTL in ms (auto-expire stale locks)
 * @returns {SwarmLockManager}
 */
export function createSwarmLocks(opts = {}) {
  const { repoRoot = process.cwd(), persistPath, ttlMs = LOCK_TTL_MS } = opts;

  /** @type {Map<string, LockEntry>} normalized relative path → lock */
  const locks = new Map();

  // ── helpers ──────────────────────────────────────────────────

  function normalizePath(filePath) {
    const abs = resolve(repoRoot, filePath);
    return relative(repoRoot, abs).replace(/\\/g, "/");
  }

  function now() {
    return Date.now();
  }

  function normalizeLeaseType(leaseType) {
    return leaseType === "shared-read" ? "shared-read" : "exclusive";
  }

  function normalizeSessionMeta(sessionMeta) {
    return sessionMeta ?? null;
  }

  function normalizeEntry(entry) {
    return {
      workerId: entry.workerId,
      acquiredAt: entry.acquiredAt,
      leaseType: normalizeLeaseType(entry.leaseType),
      sessionMeta: normalizeSessionMeta(entry.sessionMeta),
    };
  }

  function hasConflict(existing, requesterId, requestedLeaseType) {
    if (!existing || existing.workerId === requesterId) return false;
    if (
      existing.leaseType === "shared-read" &&
      requestedLeaseType === "shared-read"
    ) {
      return false;
    }
    return true;
  }

  function isExpired(entry) {
    return now() - entry.acquiredAt > ttlMs;
  }

  function pruneExpired() {
    for (const [path, entry] of locks) {
      if (isExpired(entry)) locks.delete(path);
    }
  }

  // ── persistence ─────────────────────────────────────────────

  function persist() {
    if (!persistPath) return;
    try {
      mkdirSync(dirname(persistPath), { recursive: true });
      const data = Object.fromEntries(
        [...locks].map(([k, v]) => [k, { ...v }]),
      );
      writeFileSync(persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
  }

  function restore() {
    if (!persistPath || !existsSync(persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(persistPath, "utf8"));
      const ts = now();
      for (const [path, entry] of Object.entries(data)) {
        if (ts - entry.acquiredAt <= ttlMs) {
          locks.set(path, normalizeEntry(entry));
        }
      }
    } catch {
      /* corrupted file — start fresh */
    }
  }

  // restore on creation
  restore();

  // ── public API ──────────────────────────────────────────────

  /**
   * Acquire file leases for a worker.
   * @param {string} workerId — worker/shard identifier
   * @param {string[]} files — file paths to lock
   * @param {{ leaseType?: "exclusive" | "shared-read", sessionMeta?: { sessionId: string, host: string, taskSummary: string } }} [opts]
   * @returns {{ ok: boolean, acquired: string[], conflicts: Array<{ file: string, holder: string }> }}
   */
  function acquire(workerId, files, opts = {}) {
    pruneExpired();

    const leaseType = normalizeLeaseType(opts.leaseType);
    const sessionMeta = normalizeSessionMeta(opts.sessionMeta);
    const normalized = files.map((f) => normalizePath(f));
    const conflicts = [];
    const toAcquire = [];
    const allowedSharedRead = [];

    for (let i = 0; i < normalized.length; i++) {
      const path = normalized[i];
      const existing = locks.get(path);

      if (!existing || isExpired(existing)) {
        toAcquire.push(path);
        continue;
      }

      if (hasConflict(existing, workerId, leaseType)) {
        conflicts.push({ file: files[i], holder: existing.workerId });
      } else {
        if (
          !(
            existing.workerId !== workerId &&
            existing.leaseType === "shared-read" &&
            leaseType === "shared-read"
          )
        ) {
          toAcquire.push(path);
        } else {
          allowedSharedRead.push(path);
        }
      }
    }

    if (conflicts.length > 0) {
      return { ok: false, acquired: [], conflicts };
    }

    const ts = now();
    for (const path of toAcquire) {
      locks.set(path, { workerId, acquiredAt: ts, leaseType, sessionMeta });
    }

    persist();
    return {
      ok: true,
      acquired: [...toAcquire, ...allowedSharedRead],
      conflicts: [],
    };
  }

  /**
   * Release all locks held by a worker.
   * @param {string} workerId
   * @returns {number} number of locks released
   */
  function release(workerId) {
    let count = 0;
    for (const [path, entry] of locks) {
      if (entry.workerId === workerId) {
        locks.delete(path);
        count += 1;
      }
    }
    if (count > 0) persist();
    return count;
  }

  /**
   * Check if a file write would violate any lease.
   * @param {string} workerId — the worker attempting the write
   * @param {string} filePath — the file being written
   * @param {"exclusive" | "shared-read"} [leaseType="exclusive"] — requested lease type
   * @returns {{ allowed: boolean, holder?: string }}
   */
  function check(workerId, filePath, leaseType = "exclusive") {
    pruneExpired();
    const path = normalizePath(filePath);
    const entry = locks.get(path);
    const normalizedLeaseType = normalizeLeaseType(leaseType);

    if (!entry || isExpired(entry)) return { allowed: true };
    if (!hasConflict(entry, workerId, normalizedLeaseType))
      return { allowed: true };
    return { allowed: false, holder: entry.workerId };
  }

  /**
   * Validate a set of changed files against the lease map.
   * Returns all violations found.
   *
   * Beyond the basic cross-lease check, when `options.ownLease` is supplied
   * (the caller's known lease set), this also flags out-of-lease writes to
   * distribution-critical paths — e.g. recovery-patch fallouts where a
   * worker's recorded diff carries `+++ /dev/null` deletions of files like
   * `.claude-plugin/marketplace.json` (regression of #115 / #34).
   *
   * `options.ownLease` is opt-in to preserve existing callers; when omitted,
   * legacy behavior (cross-lease check only) is kept.
   *
   * @param {string} workerId
   * @param {string[]} changedFiles
   * @param {{ ownLease?: string[], sensitiveDeny?: { prefixes?: string[], files?: string[] } }} [options]
   * @returns {Array<{ file: string, holder?: string, kind: "other-lease" | "sensitive-out-of-lease" }>}
   */
  function validateChanges(workerId, changedFiles, options = {}) {
    pruneExpired();
    const violations = [];
    const ownLeaseSet = Array.isArray(options.ownLease)
      ? new Set(options.ownLease.map((path) => normalizePath(path)))
      : null;
    const sensitivePrefixes =
      options.sensitiveDeny?.prefixes ?? SENSITIVE_PATH_PREFIXES;
    const sensitiveFiles = new Set(
      options.sensitiveDeny?.files ?? SENSITIVE_PATH_FILES,
    );

    for (const file of changedFiles) {
      const path = normalizePath(file);
      const entry = locks.get(path);

      if (entry && entry.workerId !== workerId && !isExpired(entry)) {
        violations.push({ file, holder: entry.workerId, kind: "other-lease" });
        continue;
      }

      // Sensitive-path guard only runs when caller supplied ownLease.
      // We only flag when the worker did NOT explicitly lease the file —
      // an explicit lease means the shard intentionally owns it.
      if (ownLeaseSet && !ownLeaseSet.has(path)) {
        const isSensitive =
          sensitiveFiles.has(path) ||
          sensitivePrefixes.some((prefix) => path.startsWith(prefix));
        if (isSensitive) {
          violations.push({ file, kind: "sensitive-out-of-lease" });
        }
      }
    }

    return violations;
  }

  /**
   * Get snapshot of all active locks.
   * @returns {Array<{ file: string, workerId: string, acquiredAt: number, leaseType: "exclusive" | "shared-read", sessionMeta: { sessionId: string, host: string, taskSummary: string } | null }>}
   */
  function snapshot() {
    pruneExpired();
    return [...locks].map(([file, entry]) => ({
      file,
      workerId: entry.workerId,
      acquiredAt: entry.acquiredAt,
      leaseType: normalizeLeaseType(entry.leaseType),
      sessionMeta: normalizeSessionMeta(entry.sessionMeta),
    }));
  }

  /**
   * Release all locks.
   */
  function releaseAll() {
    locks.clear();
    persist();
  }

  return Object.freeze({
    acquire,
    release,
    check,
    validateChanges,
    snapshot,
    releaseAll,
    get size() {
      return locks.size;
    },
  });
}
