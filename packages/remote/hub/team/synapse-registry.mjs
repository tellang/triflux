import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_LOCAL_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LOCAL_TIMEOUT_MS = 30_000;
const DEFAULT_REMOTE_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 90_000;
// Interactive (Claude/Codex) sessions idle for long stretches; a 30s local
// timeout produces stale false-positives. 5-minute TTL + an `idle` state
// distinguishes "alive but inactive" from "presumed dead".
const DEFAULT_INTERACTIVE_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 300_000;

const VALID_SESSION_KINDS = new Set(["interactive", "headless"]);

function normalizeSessionId(sessionId) {
  if (sessionId == null) return "";
  return String(sessionId).trim();
}

function normalizeSessionKind(raw) {
  return VALID_SESSION_KINDS.has(raw) ? raw : "headless";
}

// A session is "live" while active OR idle. Idle is an interactive session that
// missed its heartbeat interval but is still under the TTL — alive but inactive,
// not presumed dead. getActive() and querySessions() share this single predicate
// so the liveness contract can't drift: getActive() feeds git-preflight's
// dirty-file conflict guard, so dropping idle there would hide a still-live
// interactive session's claimed paths from that safety check.
function isLiveStatus(status) {
  return status === "active" || status === "idle";
}

// Non-secret co-location fingerprint: a short, stable, non-reversible hash of a
// path so peers can correlate co-located sessions without leaking the raw
// filesystem path (cf. AccountBroker redaction). This is NOT a security boundary
// — the boundary is `cwdLabel` (basename only). Treat the hash as an opaque
// correlation token, not as a secret.
function shortHash(value) {
  const str = String(value ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

// Last path segment of a directory, used as a human-readable label in redacted
// peer projections. Separator-agnostic on purpose: `node:path`.basename() is
// platform-dependent, so on POSIX a Windows path like `C:\Users\Alice\secret`
// would NOT be split and the full path would leak as the label. Splitting on
// either separator redacts both path styles regardless of host platform.
function pathLabel(value) {
  const str = String(value ?? "").replace(/[/\\]+$/, "");
  if (!str) return "";
  const segments = str.split(/[/\\]+/);
  return segments[segments.length - 1] || "";
}

function cloneSession(session) {
  return {
    ...session,
    dirtyFiles: Array.isArray(session.dirtyFiles)
      ? [...session.dirtyFiles]
      : [],
  };
}

function sanitizeSession(raw, fallbackSessionId = "") {
  const sessionId = normalizeSessionId(raw?.sessionId ?? fallbackSessionId);
  if (!sessionId) return null;

  const status =
    raw?.status === "stale" ||
    raw?.status === "expired" ||
    raw?.status === "idle"
      ? raw.status
      : "active";

  return {
    sessionId,
    host: typeof raw?.host === "string" ? raw.host : "local",
    worktreePath: typeof raw?.worktreePath === "string" ? raw.worktreePath : "",
    branch: typeof raw?.branch === "string" ? raw.branch : "",
    dirtyFiles: Array.isArray(raw?.dirtyFiles) ? [...raw.dirtyFiles] : [],
    taskSummary: typeof raw?.taskSummary === "string" ? raw.taskSummary : "",
    lastHeartbeat:
      typeof raw?.lastHeartbeat === "number" ? raw.lastHeartbeat : Date.now(),
    status,
    isRemote: Boolean(raw?.isRemote),
    // Additive fields (peer-discovery). Defaults keep pre-existing persist rows
    // (no cwd/pid/sessionKind) loading cleanly — no persist version bump needed.
    cwd: typeof raw?.cwd === "string" ? raw.cwd : "",
    pid: typeof raw?.pid === "number" ? raw.pid : null,
    sessionKind: normalizeSessionKind(raw?.sessionKind),
  };
}

// Pure redacted projection of a session for the peer-discovery route. Raw
// `cwd`/`pid` and `dirtyFiles` are NEVER exposed; only label/hash + booleans
// computed against the caller's query args (cf. AccountBroker.publicSnapshot).
export function projectPeer(session, query = {}) {
  const cwd = typeof session?.cwd === "string" ? session.cwd : "";
  const worktreePath =
    typeof session?.worktreePath === "string" ? session.worktreePath : "";
  const queryCwd = typeof query?.cwd === "string" ? query.cwd : "";
  const queryWorktree =
    typeof query?.worktree === "string" ? query.worktree : "";

  return {
    sessionId: typeof session?.sessionId === "string" ? session.sessionId : "",
    branch: typeof session?.branch === "string" ? session.branch : "",
    sessionKind: normalizeSessionKind(session?.sessionKind),
    status: typeof session?.status === "string" ? session.status : "active",
    host: typeof session?.host === "string" ? session.host : "local",
    isRemote: Boolean(session?.isRemote),
    sameCwd: Boolean(queryCwd) && cwd === queryCwd,
    sameWorktree: Boolean(queryWorktree) && worktreePath === queryWorktree,
    cwdLabel: pathLabel(cwd),
    cwdHash: cwd ? shortHash(cwd) : "",
    worktreeLabel: pathLabel(worktreePath),
  };
}

export function createSynapseRegistry(opts = {}) {
  const {
    persistPath,
    emitter = null,
    localHeartbeatIntervalMs = DEFAULT_LOCAL_HEARTBEAT_INTERVAL_MS,
    localTimeoutMs = DEFAULT_LOCAL_TIMEOUT_MS,
    remoteHeartbeatIntervalMs = DEFAULT_REMOTE_HEARTBEAT_INTERVAL_MS,
    remoteTimeoutMs = DEFAULT_REMOTE_TIMEOUT_MS,
    interactiveHeartbeatIntervalMs = DEFAULT_INTERACTIVE_HEARTBEAT_INTERVAL_MS,
    interactiveTimeoutMs = DEFAULT_INTERACTIVE_TIMEOUT_MS,
  } = opts;

  const sessions = new Map();
  const monitors = new Map();
  const staleCallbacks = new Set();
  const idleCallbacks = new Set();
  const removedCallbacks = new Set();

  function now() {
    return Date.now();
  }

  function intervalFor(session) {
    if (session.sessionKind === "interactive") {
      return interactiveHeartbeatIntervalMs;
    }
    return session.isRemote
      ? remoteHeartbeatIntervalMs
      : localHeartbeatIntervalMs;
  }

  function timeoutFor(session) {
    if (session.sessionKind === "interactive") return interactiveTimeoutMs;
    return session.isRemote ? remoteTimeoutMs : localTimeoutMs;
  }

  let persistTimer = null;
  let destroyed = false;

  function persist() {
    if (!persistPath) return;
    try {
      mkdirSync(dirname(persistPath), { recursive: true });
      const data = Object.fromEntries(
        [...sessions].map(([k, v]) => [k, cloneSession(v)]),
      );
      writeFileSync(persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
  }

  function schedulePersist() {
    if (destroyed || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!destroyed) persist();
    }, 200);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  function restore() {
    if (!persistPath || !existsSync(persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(persistPath, "utf8"));
      for (const [sessionId, session] of Object.entries(data)) {
        const sanitized = sanitizeSession(session, sessionId);
        if (sanitized) sessions.set(sanitized.sessionId, sanitized);
      }
    } catch {
      /* corrupted file — start fresh */
    }
  }

  function stopMonitor(sessionId) {
    const timer = monitors.get(sessionId);
    if (!timer) return;
    clearInterval(timer);
    monitors.delete(sessionId);
  }

  function notifyStale(session) {
    const clone = cloneSession(session);
    emitter?.emit("synapse.session.stale", {
      sessionId: session.sessionId,
      session: clone,
    });
    for (const callback of staleCallbacks) {
      try {
        callback(clone);
      } catch {
        /* no-op */
      }
    }
  }

  function notifyIdle(session) {
    const clone = cloneSession(session);
    emitter?.emit("synapse.session.idle", {
      sessionId: session.sessionId,
      session: clone,
    });
    for (const callback of idleCallbacks) {
      try {
        callback(clone);
      } catch {
        /* no-op */
      }
    }
  }

  function notifyRemoved(session) {
    const clone = cloneSession(session);
    emitter?.emit("synapse.session.removed", {
      sessionId: session.sessionId,
      session: clone,
    });
    for (const callback of removedCallbacks) {
      try {
        callback(clone);
      } catch {
        /* no-op */
      }
    }
  }

  function startMonitor(sessionId) {
    stopMonitor(sessionId);

    const session = sessions.get(sessionId);
    if (!session) return;

    const timer = setInterval(() => {
      const current = sessions.get(sessionId);
      if (!current) return;

      const elapsedMs = now() - current.lastHeartbeat;
      if (elapsedMs > timeoutFor(current)) {
        if (current.status !== "stale") {
          const staled = { ...current, status: "stale" };
          sessions.set(sessionId, staled);
          schedulePersist();
          setImmediate(() => {
            if (!destroyed) notifyStale(staled);
          });
        }
        return;
      }

      // Interactive sessions that miss the heartbeat interval but are still
      // under the TTL are "alive but inactive" (idle), not "presumed dead".
      if (
        current.sessionKind === "interactive" &&
        current.status === "active" &&
        elapsedMs > intervalFor(current)
      ) {
        const idled = { ...current, status: "idle" };
        sessions.set(sessionId, idled);
        schedulePersist();
        setImmediate(() => {
          if (!destroyed) notifyIdle(idled);
        });
      }
    }, intervalFor(session));

    if (typeof timer.unref === "function") timer.unref();
    monitors.set(sessionId, timer);
  }

  restore();
  for (const sessionId of sessions.keys()) {
    startMonitor(sessionId);
  }

  function register(sessionIdOrMeta, meta = null) {
    const normalizedMeta =
      meta && typeof meta === "object"
        ? { ...meta, sessionId: sessionIdOrMeta }
        : sessionIdOrMeta;
    const sessionId = normalizeSessionId(normalizedMeta?.sessionId);
    if (!sessionId) {
      return { ok: false, sessionId, reason: "invalid_id" };
    }

    // A live row (active/idle) means a concurrent session already holds this id
    // — reject (LOCKED #5). A stale/expired row is a dead remnant of the SAME
    // session resuming: Claude Code re-fires SessionStart with the same
    // session_id on resume/clear/compact, so fall through and re-register
    // (revive) it. Otherwise the resumed-but-live session stays stale forever
    // and vanishes from peer-discovery AND git-preflight's dirty-file guard.
    const existing = sessions.get(sessionId);
    if (existing && isLiveStatus(existing.status)) {
      console.warn(
        "[synapse-registry] duplicate registration rejected:",
        sessionId,
      );
      return { ok: false, sessionId, reason: "duplicate" };
    }

    const session = sanitizeSession(
      {
        ...normalizedMeta,
        sessionId,
        status: "active",
        lastHeartbeat: now(),
      },
      sessionId,
    );

    sessions.set(sessionId, session);
    startMonitor(sessionId);
    persist();

    emitter?.emit("synapse.session.started", {
      sessionId,
      session: cloneSession(session),
    });
    return { ok: true, sessionId };
  }

  function unregister(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    const session = sessions.get(normalized);
    if (!session) return false;

    stopMonitor(normalized);
    sessions.delete(normalized);
    persist();
    notifyRemoved(session);
    return true;
  }

  function heartbeat(sessionId, partialMeta = null) {
    const normalized = normalizeSessionId(sessionId);
    const session = sessions.get(normalized);
    if (!session) return false;

    const wasRemote = session.isRemote;
    const updated = { ...session, lastHeartbeat: now(), status: "active" };

    if (partialMeta && typeof partialMeta === "object") {
      if (typeof partialMeta.host === "string") updated.host = partialMeta.host;
      if (typeof partialMeta.worktreePath === "string") {
        updated.worktreePath = partialMeta.worktreePath;
      }
      if (typeof partialMeta.branch === "string")
        updated.branch = partialMeta.branch;
      if (Array.isArray(partialMeta.dirtyFiles)) {
        updated.dirtyFiles = partialMeta.dirtyFiles.filter(
          (f) => typeof f === "string" && f.length > 0,
        );
      }
      if (typeof partialMeta.taskSummary === "string") {
        updated.taskSummary = partialMeta.taskSummary;
      }
      if (typeof partialMeta.isRemote === "boolean") {
        updated.isRemote = partialMeta.isRemote;
      }
      if (typeof partialMeta.cwd === "string") updated.cwd = partialMeta.cwd;
      if (typeof partialMeta.pid === "number") updated.pid = partialMeta.pid;
      // sessionKind is set at register time and immutable on heartbeat.
    }

    sessions.set(normalized, updated);

    if (updated.isRemote !== wasRemote) {
      startMonitor(normalized);
    }

    schedulePersist();
    emitter?.emit("synapse.session.heartbeat", {
      sessionId: normalized,
      session: cloneSession(updated),
      partial: partialMeta,
    });
    return true;
  }

  function getActive() {
    // Live = active or idle. git-preflight uses this to detect other live
    // sessions whose dirty files would conflict; an idle interactive session is
    // still live (process alive, dirty files on disk) and must stay visible.
    return [...sessions.values()]
      .filter((session) => isLiveStatus(session.status))
      .map((session) => cloneSession(session));
  }

  function getAll() {
    return [...sessions.values()].map((session) => cloneSession(session));
  }

  function getSession(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return null;
    const session = sessions.get(normalized);
    return session ? cloneSession(session) : null;
  }

  // Peer-discovery primitive: returns sessions sharing the caller's cwd OR
  // worktree, excluding the caller's own session. Only live peers (active/idle)
  // are returned — stale/expired rows are presumed dead and omitted.
  //
  // SECURITY: at least one non-empty locator (cwd or worktree) is REQUIRED. An
  // empty filter would otherwise return every active/idle session, turning the
  // redacted peer surface into a full-registry enumeration (session ids/branches/
  // labels/hashes). With no usable locator we return [] rather than leak.
  //
  // Matching is disjunctive (cwd OR worktreePath): a peer in the same worktree
  // but a different subdirectory shares the worktree locator even though its cwd
  // differs, and a conjunctive (AND) match would wrongly drop it.
  function querySessions(filter = {}) {
    const wantCwd = typeof filter?.cwd === "string" ? filter.cwd : "";
    const wantWorktree =
      typeof filter?.worktree === "string" ? filter.worktree : "";
    const excludeId = normalizeSessionId(filter?.excludeSessionId);

    // Require at least one non-empty locator — never enumerate the whole registry.
    if (!wantCwd && !wantWorktree) return [];

    return [...sessions.values()]
      .filter((session) => {
        if (!isLiveStatus(session.status)) {
          return false;
        }
        if (excludeId && session.sessionId === excludeId) return false;
        const cwdMatch = Boolean(wantCwd) && session.cwd === wantCwd;
        const worktreeMatch =
          Boolean(wantWorktree) && session.worktreePath === wantWorktree;
        return cwdMatch || worktreeMatch;
      })
      .map((session) => cloneSession(session));
  }

  function onStale(callback) {
    if (typeof callback !== "function") return;
    staleCallbacks.add(callback);
  }

  function onIdle(callback) {
    if (typeof callback !== "function") return;
    idleCallbacks.add(callback);
  }

  function onRemoved(callback) {
    if (typeof callback !== "function") return;
    removedCallbacks.add(callback);
  }

  function snapshot() {
    return {
      sessions: getAll(),
    };
  }

  function destroy() {
    destroyed = true;
    for (const sessionId of monitors.keys()) {
      stopMonitor(sessionId);
    }
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persist();
  }

  return Object.freeze({
    register,
    unregister,
    heartbeat,
    getActive,
    getAll,
    getSession,
    querySessions,
    onStale,
    onIdle,
    onRemoved,
    snapshot,
    destroy,
  });
}
