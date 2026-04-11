import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_LOCAL_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LOCAL_TIMEOUT_MS = 30_000;
const DEFAULT_REMOTE_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 90_000;

function normalizeSessionId(sessionId) {
  if (sessionId == null) return "";
  return String(sessionId).trim();
}

function cloneSession(session) {
  return {
    ...session,
    dirtyFiles: Array.isArray(session.dirtyFiles) ? [...session.dirtyFiles] : [],
  };
}

function sanitizeSession(raw, fallbackSessionId = "") {
  const sessionId = normalizeSessionId(raw?.sessionId ?? fallbackSessionId);
  if (!sessionId) return null;

  return {
    sessionId,
    host: typeof raw?.host === "string" ? raw.host : "local",
    worktreePath: typeof raw?.worktreePath === "string" ? raw.worktreePath : "",
    branch: typeof raw?.branch === "string" ? raw.branch : "",
    dirtyFiles: Array.isArray(raw?.dirtyFiles) ? [...raw.dirtyFiles] : [],
    taskSummary: typeof raw?.taskSummary === "string" ? raw.taskSummary : "",
    lastHeartbeat:
      typeof raw?.lastHeartbeat === "number" ? raw.lastHeartbeat : Date.now(),
    status:
      raw?.status === "stale" || raw?.status === "expired"
        ? raw.status
        : "active",
    isRemote: Boolean(raw?.isRemote),
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
  } = opts;

  const sessions = new Map();
  const monitors = new Map();
  const staleCallbacks = new Set();
  const removedCallbacks = new Set();

  function now() {
    return Date.now();
  }

  function intervalFor(session) {
    return session.isRemote
      ? remoteHeartbeatIntervalMs
      : localHeartbeatIntervalMs;
  }

  function timeoutFor(session) {
    return session.isRemote ? remoteTimeoutMs : localTimeoutMs;
  }

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
    emitter?.emit("synapse.session.stale", { sessionId: session.sessionId, session: clone });
    for (const callback of staleCallbacks) {
      try {
        callback(clone);
      } catch {
        /* no-op */
      }
    }
  }

  function notifyRemoved(session) {
    const clone = cloneSession(session);
    emitter?.emit("synapse.session.removed", { sessionId: session.sessionId, session: clone });
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
      if (elapsedMs > timeoutFor(current) && current.status !== "stale") {
        current.status = "stale";
        persist();
        notifyStale(current);
      }
    }, intervalFor(session));

    if (typeof timer.unref === "function") timer.unref();
    monitors.set(sessionId, timer);
  }

  restore();
  for (const sessionId of sessions.keys()) {
    startMonitor(sessionId);
  }

  function register(meta) {
    const sessionId = normalizeSessionId(meta?.sessionId);
    if (!sessionId || sessions.has(sessionId)) {
      return { ok: false, sessionId };
    }

    const session = sanitizeSession(
      {
        ...meta,
        sessionId,
        status: "active",
        lastHeartbeat: now(),
      },
      sessionId,
    );

    sessions.set(sessionId, session);
    startMonitor(sessionId);
    persist();

    emitter?.emit("synapse.session.started", { sessionId, session: cloneSession(session) });
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

    session.lastHeartbeat = now();
    session.status = "active";

    if (partialMeta && typeof partialMeta === "object") {
      if (typeof partialMeta.host === "string") session.host = partialMeta.host;
      if (typeof partialMeta.worktreePath === "string") {
        session.worktreePath = partialMeta.worktreePath;
      }
      if (typeof partialMeta.branch === "string") session.branch = partialMeta.branch;
      if (Array.isArray(partialMeta.dirtyFiles)) {
        session.dirtyFiles = [...partialMeta.dirtyFiles];
      }
      if (typeof partialMeta.taskSummary === "string") {
        session.taskSummary = partialMeta.taskSummary;
      }
      if (typeof partialMeta.isRemote === "boolean") {
        session.isRemote = partialMeta.isRemote;
      }
    }

    if (session.isRemote !== wasRemote) {
      startMonitor(normalized);
    }

    persist();
    emitter?.emit("synapse.session.heartbeat", { sessionId: normalized, partial: partialMeta });
    return true;
  }

  function getActive() {
    return [...sessions.values()]
      .filter((session) => session.status === "active")
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

  function onStale(callback) {
    if (typeof callback !== "function") return;
    staleCallbacks.add(callback);
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
    for (const sessionId of monitors.keys()) {
      stopMonitor(sessionId);
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
    onStale,
    onRemoved,
    snapshot,
    destroy,
  });
}
