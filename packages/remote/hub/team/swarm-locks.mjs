// hub/team/swarm-locks.mjs — File-level lease lock manager for swarm execution
// Prevents multiple workers from writing to the same file simultaneously.
// Lock state is kept in-memory (single-process hypervisor) with optional
// JSON persistence to .triflux/swarm-locks.json for crash recovery.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const LOCK_TTL_MS = 10 * 60_000; // 10 minutes default TTL

/**
 * Swarm lock manager factory.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — repository root for relative path normalization
 * @param {string} [opts.persistPath] — JSON file path for crash recovery persistence
 * @param {number} [opts.ttlMs=600000] — lock TTL in ms (auto-expire stale locks)
 * @returns {SwarmLockManager}
 */
export function createSwarmLocks(opts = {}) {
  const {
    repoRoot = process.cwd(),
    persistPath,
    ttlMs = LOCK_TTL_MS,
  } = opts;

  /** @type {Map<string, LockEntry>} normalized relative path → lock */
  const locks = new Map();

  // ── helpers ──────────────────────────────────────────────────

  function normalizePath(filePath) {
    const abs = resolve(repoRoot, filePath);
    return relative(repoRoot, abs).replace(/\\/g, '/');
  }

  function now() {
    return Date.now();
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
      writeFileSync(persistPath, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* best-effort */ }
  }

  function restore() {
    if (!persistPath || !existsSync(persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(persistPath, 'utf8'));
      const ts = now();
      for (const [path, entry] of Object.entries(data)) {
        if (ts - entry.acquiredAt <= ttlMs) {
          locks.set(path, entry);
        }
      }
    } catch { /* corrupted file — start fresh */ }
  }

  // restore on creation
  restore();

  // ── public API ──────────────────────────────────────────────

  /**
   * Acquire file leases for a worker.
   * @param {string} workerId — worker/shard identifier
   * @param {string[]} files — file paths to lock
   * @returns {{ ok: boolean, acquired: string[], conflicts: Array<{ file: string, holder: string }> }}
   */
  function acquire(workerId, files) {
    pruneExpired();

    const normalized = files.map((f) => normalizePath(f));
    const conflicts = [];
    const toAcquire = [];

    for (let i = 0; i < normalized.length; i++) {
      const path = normalized[i];
      const existing = locks.get(path);

      if (existing && existing.workerId !== workerId && !isExpired(existing)) {
        conflicts.push({ file: files[i], holder: existing.workerId });
      } else {
        toAcquire.push(path);
      }
    }

    if (conflicts.length > 0) {
      return { ok: false, acquired: [], conflicts };
    }

    const ts = now();
    for (const path of toAcquire) {
      locks.set(path, { workerId, acquiredAt: ts });
    }

    persist();
    return { ok: true, acquired: toAcquire, conflicts: [] };
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
   * @returns {{ allowed: boolean, holder?: string }}
   */
  function check(workerId, filePath) {
    pruneExpired();
    const path = normalizePath(filePath);
    const entry = locks.get(path);

    if (!entry || isExpired(entry)) return { allowed: true };
    if (entry.workerId === workerId) return { allowed: true };
    return { allowed: false, holder: entry.workerId };
  }

  /**
   * Validate a set of changed files against the lease map.
   * Returns all violations found.
   * @param {string} workerId
   * @param {string[]} changedFiles
   * @returns {Array<{ file: string, holder: string }>}
   */
  function validateChanges(workerId, changedFiles) {
    pruneExpired();
    const violations = [];

    for (const file of changedFiles) {
      const path = normalizePath(file);
      const entry = locks.get(path);

      if (entry && entry.workerId !== workerId && !isExpired(entry)) {
        violations.push({ file, holder: entry.workerId });
      }
    }

    return violations;
  }

  /**
   * Get snapshot of all active locks.
   * @returns {Array<{ file: string, workerId: string, acquiredAt: number }>}
   */
  function snapshot() {
    pruneExpired();
    return [...locks].map(([file, entry]) => ({
      file,
      workerId: entry.workerId,
      acquiredAt: entry.acquiredAt,
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
    get size() { return locks.size; },
  });
}
