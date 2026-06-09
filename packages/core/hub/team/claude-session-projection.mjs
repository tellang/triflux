import fs from "node:fs/promises";
import path from "node:path";

export function normalizeClaudeBridgeSessionId(bridgeSessionId, short) {
  const value = String(bridgeSessionId || "").trim();
  if (value.startsWith("session_")) return value;
  if (value.startsWith("cse_")) return `session_${value.slice(4)}`;
  if (value) return value;
  return `session_${short}`;
}

export function buildClaudeSessionProjection({
  pid,
  procStart,
  sessionId,
  short,
  cwd,
  name,
  agent,
  startedAt = Date.now(),
  updatedAt = Date.now(),
  status = "busy",
  version = "triflux-native-bridge",
  bridgeSessionId,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid is required");
  if (!procStart) throw new Error("procStart is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!short) throw new Error("short is required");
  if (!cwd) throw new Error("cwd is required");
  if (!name) throw new Error("name is required");
  if (!agent) throw new Error("agent is required");
  return {
    pid,
    sessionId,
    cwd,
    startedAt,
    procStart,
    version,
    peerProtocol: 1,
    kind: "bg",
    entrypoint: "cli",
    name,
    agent,
    jobId: short,
    status,
    updatedAt,
    bridgeSessionId: normalizeClaudeBridgeSessionId(bridgeSessionId, short),
  };
}

export async function writeClaudeSessionProjection(sessionsDir, projection) {
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionPath = path.join(sessionsDir, `${projection.pid}.json`);
  const tmpPath = `${sessionPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(projection)}\n`, "utf8");
  await fs.rename(tmpPath, sessionPath);
  return sessionPath;
}

export async function updateClaudeSessionProjection(sessionPath, patch) {
  const parsed = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  const next = {
    ...parsed,
    ...patch,
    updatedAt: patch.updatedAt || Date.now(),
  };
  await fs.writeFile(sessionPath, `${JSON.stringify(next)}\n`, "utf8");
  return next;
}

function projectionSessionId(projection) {
  return String(
    projection?.sessionId ?? projection?.session_id ?? projection?.id ?? "",
  ).trim();
}

export async function findClaudeSessionProjectionBySessionId(
  sessionsDir,
  sessionId,
) {
  const expected = String(sessionId || "").trim();
  if (!sessionsDir || !expected) return null;
  let entries;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(sessionsDir, entry.name);
    try {
      const projection = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (projectionSessionId(projection) === expected) {
        return { path: filePath, projection };
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

export async function refreshClaudeSessionProjectionCwd({
  sessionsDir,
  sessionId,
  cwd,
  updatedAt = Date.now(),
} = {}) {
  const nextCwd = String(cwd || "").trim();
  if (!nextCwd) return { updated: false, reason: "missing_cwd" };
  const found = await findClaudeSessionProjectionBySessionId(
    sessionsDir,
    sessionId,
  );
  if (!found) return { updated: false, reason: "projection_not_found" };
  const projection = await updateClaudeSessionProjection(found.path, {
    cwd: nextCwd,
    updatedAt,
  });
  return { updated: true, path: found.path, projection };
}

export async function removeClaudeSessionProjection(sessionPath) {
  await fs.rm(sessionPath, { force: true });
}
