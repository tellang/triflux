import fs from "node:fs/promises";
import path from "node:path";

// 실제 bridge ID 가 없으면 만들어 내지 않는다. 추정 ID 는 붙을 수 있는 세션처럼 보이게 한다.
export function normalizeClaudeBridgeSessionId(bridgeSessionId) {
  const value = String(bridgeSessionId || "").trim();
  if (value.startsWith("cse_")) return `session_${value.slice(4)}`;
  return value;
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
  const bridge = normalizeClaudeBridgeSessionId(bridgeSessionId);
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
    ...(bridge ? { bridgeSessionId: bridge } : {}),
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

export async function removeClaudeSessionProjection(sessionPath) {
  await fs.rm(sessionPath, { force: true });
}
