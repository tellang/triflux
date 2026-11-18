import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const VALID_SESSION_ROLES = new Set(["lead", "communication"]);

export function leadRoleDir(env = process.env) {
  let base;
  if (env?.XDG_STATE_HOME) {
    base = env.XDG_STATE_HOME;
  } else if (env?.HOME || env?.TRIFLUX_TEST_HOME) {
    base = join(env.HOME || env.TRIFLUX_TEST_HOME, ".local", "state");
  } else {
    base =
      process.env.XDG_STATE_HOME ||
      join(
        process.env.HOME || process.env.TRIFLUX_TEST_HOME || homedir(),
        ".local",
        "state",
      );
  }
  return join(base, "triflux", "lead-roles");
}

function markerFileName(session) {
  return `${String(session).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function markerFilePath(session, env = process.env) {
  return join(leadRoleDir(env), markerFileName(session));
}

function isValidSessionRole(role) {
  return VALID_SESSION_ROLES.has(role);
}

function readJsonFileSafe(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!isValidSessionRole(parsed.sessionRole)) return null;
    if (typeof parsed.session !== "string" || !parsed.session.trim()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function listMarkerEntries(env = process.env) {
  const dir = leadRoleDir(env);
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = join(dir, name);
    const record = readJsonFileSafe(filePath);
    if (record) entries.push({ filePath, record });
  }
  return entries;
}

function atomicWriteMarker(filePath, dir, payload) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {}
  renameSync(tmpPath, filePath);
}

function normalizeMarkerRecord(record, existing = null) {
  const session = String(record.session ?? existing?.session ?? "").trim();
  const sessionRole = record.sessionRole ?? existing?.sessionRole ?? null;
  if (!session || !isValidSessionRole(sessionRole)) return null;

  const rawCwd = record.cwd ?? existing?.cwd ?? null;
  const role =
    (typeof record.role === "string" && record.role.trim()) ||
    (typeof existing?.role === "string" && existing.role.trim()) ||
    (typeof record.name === "string" && record.name.trim()) ||
    sessionRole;
  const name =
    (typeof record.name === "string" && record.name.trim()) ||
    (typeof existing?.name === "string" && existing.name.trim()) ||
    session;

  return {
    session,
    paneId: record.paneId ?? existing?.paneId ?? null,
    cli: record.cli ?? existing?.cli ?? null,
    sessionRole,
    role,
    name,
    cwd: rawCwd ? resolve(String(rawCwd)) : null,
    conversationId: record.conversationId ?? existing?.conversationId ?? null,
    threadId: record.threadId ?? existing?.threadId ?? null,
    since: record.since || existing?.since || new Date().toISOString(),
    pendingHandoff:
      record.pendingHandoff !== undefined
        ? record.pendingHandoff
        : (existing?.pendingHandoff ?? null),
    notifiedConversationId:
      record.notifiedConversationId !== undefined
        ? record.notifiedConversationId
        : (existing?.notifiedConversationId ?? null),
    notifiedThreadId:
      record.notifiedThreadId !== undefined
        ? record.notifiedThreadId
        : (existing?.notifiedThreadId ?? null),
    notifiedThreshold:
      typeof record.notifiedThreshold === "number"
        ? record.notifiedThreshold
        : typeof existing?.notifiedThreshold === "number"
          ? existing.notifiedThreshold
          : 0,
  };
}

function findMatchingEntry(query = {}, env = process.env) {
  if (!query || typeof query !== "object") return null;
  const entries = listMarkerEntries(env);
  if (!entries.length) return null;

  if (query.paneId) {
    const found = entries.find(
      ({ record }) => record.paneId && record.paneId === query.paneId,
    );
    if (found) return found;
  }

  if (query.session) {
    const found = entries.find(
      ({ record }) => record.session && record.session === query.session,
    );
    if (found) return found;
  }

  if (query.conversationId) {
    const found = entries.find(
      ({ record }) =>
        record.conversationId && record.conversationId === query.conversationId,
    );
    if (found) return found;
  }

  if (query.threadId) {
    const found = entries.find(
      ({ record }) => record.threadId && record.threadId === query.threadId,
    );
    if (found) return found;
  }

  if (!query.paneId && !query.session && query.cli && query.cwd) {
    const targetCwd = resolve(String(query.cwd));
    const found = entries.find(
      ({ record }) =>
        record.cli === query.cli &&
        record.cwd &&
        resolve(String(record.cwd)) === targetCwd,
    );
    if (found) return found;
  }

  return null;
}

export function writeLeadMarker(record, { env = process.env } = {}) {
  if (!record || typeof record !== "object") return null;
  if (!isValidSessionRole(record.sessionRole)) return null;
  const session = String(record.session ?? "").trim();
  if (!session) return null;

  const dir = leadRoleDir(env);
  const filePath = markerFilePath(session, env);
  const existing = existsSync(filePath) ? readJsonFileSafe(filePath) : null;
  const normalized = normalizeMarkerRecord(record, existing);
  if (!normalized) return null;

  atomicWriteMarker(filePath, dir, normalized);
  return normalized;
}

export function readLeadMarker(query = {}, { env = process.env } = {}) {
  const match = findMatchingEntry(query, env);
  return match ? match.record : null;
}

export function updateLeadMarker(query, patch, { env = process.env } = {}) {
  if (!patch || typeof patch !== "object") return null;
  const match = findMatchingEntry(query, env);
  if (!match) return null;

  const { filePath, record: existing } = match;
  const merged = {
    ...existing,
    ...patch,
    session: existing.session,
    sessionRole: isValidSessionRole(patch.sessionRole)
      ? patch.sessionRole
      : existing.sessionRole,
  };
  if (merged.cwd) {
    merged.cwd = resolve(String(merged.cwd));
  }
  atomicWriteMarker(filePath, leadRoleDir(env), merged);
  return merged;
}

export function removeLeadMarker(
  { session, paneId } = {},
  { env = process.env } = {},
) {
  let removed = false;
  if (session) {
    const directPath = markerFilePath(session, env);
    if (existsSync(directPath)) {
      try {
        rmSync(directPath, { force: true });
        removed = true;
      } catch {}
    }
  }

  const entries = listMarkerEntries(env);
  for (const { filePath, record } of entries) {
    const matchSession = session && record.session === session;
    const matchPane = paneId && record.paneId && record.paneId === paneId;
    if (matchSession || matchPane) {
      try {
        rmSync(filePath, { force: true });
        removed = true;
      } catch {}
    }
  }
  return removed;
}
