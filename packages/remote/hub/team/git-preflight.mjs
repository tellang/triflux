// hub/team/git-preflight.mjs — Pre-flight safety check for dangerous git ops.
// Blocks checkout/rebase/cherry-pick/reset/stash-pop/worktree-remove when they
// would conflict with other active Synapse sessions' dirty files or claimed
// leases. Fail-open by default: if registry/locks are unavailable, allow the op
// with a warning (worktree isolation is the baseline safety net).

/**
 * Factory for git pre-flight check.
 *
 * @param {object} opts
 * @param {{ getActive: () => Array<object> }} opts.registry — synapse-registry duck type
 * @param {{ snapshot: () => Array<object> }} opts.locks — swarm-locks duck type
 * @param {boolean} [opts.failOpen=true] — allow op when registry/locks throw or are missing
 * @param {(level: string, msg: string, data?: object) => void} [opts.logger] — optional logger
 * @returns {{
 *   check: Function,
 *   checkRebase: Function,
 *   checkCheckout: Function,
 *   checkCherryPick: Function,
 *   checkReset: Function,
 *   checkStashPop: Function,
 *   checkWorktreeRemove: Function,
 * }}
 */
export function createGitPreflight(opts = {}) {
  const { registry, locks, failOpen = true, logger = null } = opts;

  function log(level, msg, data) {
    if (logger) {
      try {
        logger(level, msg, data);
      } catch {
        /* logger failure is non-fatal */
      }
      return;
    }
    if (level === "warn") {
      console.warn(`[git-preflight] ${msg}`, data ?? "");
    } else if (level === "error") {
      console.error(`[git-preflight] ${msg}`, data ?? "");
    }
  }

  // ── helpers ──────────────────────────────────────────────

  function safeGetActive() {
    try {
      const value = registry?.getActive?.();
      if (!Array.isArray(value)) return null;
      return value;
    } catch (err) {
      log("warn", "registry.getActive threw", { error: err?.message });
      return null;
    }
  }

  function safeSnapshot() {
    try {
      const value = locks?.snapshot?.();
      if (!Array.isArray(value)) return null;
      return value;
    } catch (err) {
      log("warn", "locks.snapshot threw", { error: err?.message });
      return null;
    }
  }

  function failOpenDecision(reason) {
    log("warn", "hub unavailable, failing open", { reason });
    return { allowed: true, reason: "hub_unavailable_fail_open" };
  }

  function normalizeFiles(list) {
    if (!Array.isArray(list)) return new Set();
    return new Set(
      list
        .filter((f) => typeof f === "string" && f.length > 0)
        .map((f) => f.replace(/\\/g, "/")),
    );
  }

  function otherActiveSessions(active, sessionId) {
    return active.filter((s) => s && s.sessionId && s.sessionId !== sessionId);
  }

  function otherLeases(snapshot, workerId) {
    return snapshot.filter(
      (entry) => entry && entry.workerId && entry.workerId !== workerId,
    );
  }

  function buildConflict(file, session, holder) {
    return {
      file,
      activeSession: session?.sessionId ?? holder ?? "unknown",
      activeTask: session?.taskSummary ?? "",
      ...(holder ? { leaseHolder: holder } : {}),
    };
  }

  function recommend(conflicts) {
    if (!conflicts.length) return "";
    const first = conflicts[0];
    const owner = first.leaseHolder || first.activeSession;
    const task = first.activeTask ? ` Active task: '${first.activeTask}'` : "";
    return `Wait for '${owner}' to finish, or coordinate via HITL.${task}`;
  }

  function blockedDecision(op, conflicts, extraReason) {
    return {
      allowed: false,
      reason: extraReason || "overlap_with_active_session",
      conflicts,
      recommendation: recommend(conflicts),
      op,
    };
  }

  function allowedDecision() {
    return { allowed: true };
  }

  // ── shared scanners ─────────────────────────────────────

  function findDirtyFileConflicts(sessionId, workerId) {
    const active = safeGetActive();
    const snapshot = safeSnapshot();

    if (active == null || snapshot == null) {
      return failOpen ? { fallOpen: true } : { fallOpen: false, conflicts: [] };
    }

    const conflicts = [];
    const seen = new Set();

    for (const session of otherActiveSessions(active, sessionId)) {
      const dirty = normalizeFiles(session.dirtyFiles);
      for (const file of dirty) {
        if (seen.has(file)) continue;
        seen.add(file);
        conflicts.push(buildConflict(file, session));
      }
    }

    for (const lease of otherLeases(snapshot, workerId)) {
      if (lease.leaseType && lease.leaseType !== "exclusive") continue;
      const file = typeof lease.file === "string" ? lease.file : null;
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const sessionMeta = lease.sessionMeta || null;
      conflicts.push(
        buildConflict(
          file,
          sessionMeta
            ? {
                sessionId: sessionMeta.sessionId || lease.workerId,
                taskSummary: sessionMeta.taskSummary || "",
              }
            : null,
          lease.workerId,
        ),
      );
    }

    return { conflicts };
  }

  function findTargetFileConflicts(targetFiles, sessionId, workerId) {
    const active = safeGetActive();
    const snapshot = safeSnapshot();

    if (active == null || snapshot == null) {
      return failOpen ? { fallOpen: true } : { fallOpen: false, conflicts: [] };
    }

    const targets = normalizeFiles(targetFiles);
    if (targets.size === 0) return { conflicts: [] };

    const conflicts = [];
    const seen = new Set();

    for (const session of otherActiveSessions(active, sessionId)) {
      const dirty = normalizeFiles(session.dirtyFiles);
      for (const file of dirty) {
        if (!targets.has(file) || seen.has(file)) continue;
        seen.add(file);
        conflicts.push(buildConflict(file, session));
      }
    }

    for (const lease of otherLeases(snapshot, workerId)) {
      if (lease.leaseType && lease.leaseType !== "exclusive") continue;
      const file = typeof lease.file === "string" ? lease.file : null;
      if (!file || !targets.has(file) || seen.has(file)) continue;
      seen.add(file);
      const sessionMeta = lease.sessionMeta || null;
      conflicts.push(
        buildConflict(
          file,
          sessionMeta
            ? {
                sessionId: sessionMeta.sessionId || lease.workerId,
                taskSummary: sessionMeta.taskSummary || "",
              }
            : null,
          lease.workerId,
        ),
      );
    }

    return { conflicts };
  }

  // ── public API ──────────────────────────────────────────

  /**
   * Core pre-flight check.
   *
   * @param {"checkout"|"rebase"|"cherry-pick"|"reset"|"stash-pop"|"worktree-remove"} op
   * @param {{ targetFiles?: string[], branch?: string, ref?: string, worktreePath?: string }} args
   * @param {{ sessionId: string, workerId?: string }} sessionContext
   * @returns {{ allowed: boolean, reason?: string, conflicts?: object[], recommendation?: string, op?: string }}
   */
  function check(op, args = {}, sessionContext = {}) {
    const sessionId = sessionContext.sessionId || "";
    const workerId = sessionContext.workerId || sessionId;

    switch (op) {
      case "checkout":
      case "rebase":
      case "reset":
      case "stash-pop": {
        const res = findDirtyFileConflicts(sessionId, workerId);
        if (res.fallOpen) return failOpenDecision(op);
        if (res.conflicts.length > 0) return blockedDecision(op, res.conflicts);
        return allowedDecision();
      }
      case "cherry-pick": {
        const targets = Array.isArray(args.targetFiles) ? args.targetFiles : [];
        const res = findTargetFileConflicts(targets, sessionId, workerId);
        if (res.fallOpen) return failOpenDecision(op);
        if (res.conflicts.length > 0) return blockedDecision(op, res.conflicts);
        return allowedDecision();
      }
      case "worktree-remove": {
        const active = safeGetActive();
        if (active == null) return failOpenDecision(op);
        const target =
          typeof args.worktreePath === "string"
            ? args.worktreePath.replace(/\\/g, "/")
            : "";
        if (!target) return allowedDecision();
        const conflicts = [];
        for (const session of otherActiveSessions(active, sessionId)) {
          const sessionPath =
            typeof session.worktreePath === "string"
              ? session.worktreePath.replace(/\\/g, "/")
              : "";
          if (sessionPath && sessionPath === target) {
            conflicts.push({
              file: target,
              activeSession: session.sessionId,
              activeTask: session.taskSummary || "",
            });
          }
        }
        if (conflicts.length > 0) {
          return blockedDecision(op, conflicts, "active_worktree");
        }
        return allowedDecision();
      }
      default:
        return allowedDecision();
    }
  }

  return Object.freeze({
    check,
    checkRebase: (args, ctx) => check("rebase", args, ctx),
    checkCheckout: (args, ctx) => check("checkout", args, ctx),
    checkCherryPick: (args, ctx) => check("cherry-pick", args, ctx),
    checkReset: (args, ctx) => check("reset", args, ctx),
    checkStashPop: (args, ctx) => check("stash-pop", args, ctx),
    checkWorktreeRemove: (args, ctx) => check("worktree-remove", args, ctx),
  });
}
