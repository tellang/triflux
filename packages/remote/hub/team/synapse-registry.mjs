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
        const staled = { ...current, status: "stale" };
        sessions.set(sessionId, staled);
        schedulePersist();
        setImmediate(() => { if (!destroyed) notifyStale(staled); });
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

    if (sessions.has(sessionId)) {
      console.warn("[synapse-registry] duplicate registration rejected:", sessionId);
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
    const updated = { ...session, lastHeartbeat: now(), status: "active" };

    if (partialMeta && typeof partialMeta === "object") {
      if (typeof partialMeta.host === "string") updated.host = partialMeta.host;
      if (typeof partialMeta.worktreePath === "string") {
        updated.worktreePath = partialMeta.worktreePath;
      }
      if (typeof partialMeta.branch === "string") updated.branch = partialMeta.branch;
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
    }

    sessions.set(normalized, updated);

    if (updated.isRemote !== wasRemote) {
      startMonitor(normalized);
    }

    schedulePersist();
    emitter?.emit("synapse.session.heartbeat", { sessionId: normalized, session: cloneSession(updated), partial: partialMeta });
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
    onStale,
    onRemoved,
    snapshot,
    destroy,
  });
}
