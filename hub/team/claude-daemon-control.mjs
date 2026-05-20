import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function resolveClaudeConfigDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), ".claude");
}

export function deriveClaudeDaemonPaths({
  configDir = resolveClaudeConfigDir(),
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  tmpRoot = "/tmp",
} = {}) {
  const resolvedConfigDir = path.resolve(configDir);
  const hash = crypto
    .createHash("sha256")
    .update(resolvedConfigDir)
    .digest("hex")
    .slice(0, 8);
  const daemonDir = path.join(tmpRoot, `cc-daemon-${uid}`, hash);
  return {
    configDir: resolvedConfigDir,
    hash,
    daemonDir,
    controlSock: path.join(daemonDir, "control.sock"),
    rosterPath: path.join(resolvedConfigDir, "daemon", "roster.json"),
    sessionsDir: path.join(resolvedConfigDir, "sessions"),
  };
}

export function readFirstJsonLine(text) {
  const line = String(text)
    .split("\n")
    .find((entry) => entry.trim().length > 0);
  if (!line) throw new Error("empty daemon response");
  return JSON.parse(line);
}

export function sendClaudeControlRequest(
  sockPath,
  request,
  { timeoutMs = 6000 } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;
    let data = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs, () => {
      finish(
        new Error(`Timed out waiting for Claude daemon response: ${sockPath}`),
      );
    });
    socket.on("error", finish);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      try {
        finish(null, readFirstJsonLine(data));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("close", () => {
      if (settled) return;
      if (data.length === 0) {
        finish(
          new Error("Claude daemon closed control socket without a response"),
        );
        return;
      }
      try {
        finish(null, readFirstJsonLine(data));
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function buildDaemonExecDispatchPayload({
  short = crypto.randomBytes(4).toString("hex"),
  sessionId,
  cwd = process.cwd(),
  command,
  name,
  createdAt = Date.now(),
  cols = 120,
  rows = 40,
} = {}) {
  if (!command) throw new Error("command is required");
  if (!name) throw new Error("name is required");
  const uuid = crypto.randomUUID();
  const resolvedSessionId = sessionId || `${short}${uuid.slice(8)}`;
  return {
    proto: 1,
    short,
    sessionId: resolvedSessionId,
    createdAt,
    source: "shell",
    cwd,
    launch: {
      mode: "exec",
      cmd: "/bin/zsh",
      args: ["-lc", command],
    },
    env: {},
    isolation: "none",
    respawnFlags: [],
    seed: {
      intent: name,
      name,
    },
    cols,
    rows,
  };
}

export function findDaemonJobByShort(listResponse, short) {
  if (!Array.isArray(listResponse?.jobs)) return null;
  return listResponse.jobs.find((job) => job?.short === short) || null;
}

export async function waitForDaemonJobPid(
  controlSock,
  short,
  { timeoutMs = 5000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await sendClaudeControlRequest(controlSock, {
      proto: 1,
      op: "list",
    });
    const job = findDaemonJobByShort(list, short);
    if (Number.isInteger(job?.pid) && job.pid > 0) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Claude daemon dispatch did not expose a pid for ${short}`);
}

export async function killDaemonJob(controlSock, short) {
  return await sendClaudeControlRequest(controlSock, {
    proto: 1,
    op: "kill",
    short,
  });
}
