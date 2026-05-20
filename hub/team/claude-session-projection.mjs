import fs from "node:fs/promises";
import path from "node:path";

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
    bridgeSessionId: `session_${short}`,
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
  const next = { ...parsed, ...patch, updatedAt: patch.updatedAt || Date.now() };
  await fs.writeFile(sessionPath, `${JSON.stringify(next)}\n`, "utf8");
  return next;
}

export async function removeClaudeSessionProjection(sessionPath) {
  await fs.rm(sessionPath, { force: true });
}
