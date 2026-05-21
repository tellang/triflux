import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function deriveDaemonPaths({
  configDir,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  tmpRoot = "/tmp",
} = {}) {
  if (!configDir) throw new Error("configDir is required");
  const resolvedConfigDir = path.resolve(configDir);
  const hash = crypto.createHash("sha256").update(resolvedConfigDir).digest("hex").slice(0, 8);
  const daemonDir = path.join(tmpRoot, `cc-daemon-${uid}`, hash);
  return {
    configDir,
    resolvedConfigDir,
    hash,
    daemonDir,
    controlSock: path.join(daemonDir, "control.sock"),
    rendezvousDir: path.join(daemonDir, "rv"),
    ptyDir: path.join(daemonDir, "pty"),
    spareDir: path.join(daemonDir, "spare"),
    rosterPath: path.join(configDir, "daemon", "roster.json"),
    sessionsDir: path.join(configDir, "sessions"),
  };
}

export function parseJsonLine(text) {
  const line = text.split("\n").find((entry) => entry.trim().length > 0);
  if (!line) throw new Error("empty JSON-line response");
  return JSON.parse(line);
}

export function sendControlRequest(sockPath, request, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let data = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error(`Timed out waiting for ${sockPath}`)));
    socket.on("error", finish);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      try {
        finish(null, parseJsonLine(data));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("close", () => {
      if (!settled && data.length > 0) {
        try {
          finish(null, parseJsonLine(data));
        } catch (error) {
          finish(error);
        }
      } else if (!settled) {
        finish(new Error("daemon closed the control socket without a response"));
      }
    });
  });
}

export function buildIsolatedDaemonEnv(configDir, baseEnv = process.env) {
  const allowed = [
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "__CF_USER_TEXT_ENCODING",
  ];
  const env = {};
  for (const key of allowed) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return {
    ...env,
    HOME: configDir,
    CLAUDE_CONFIG_DIR: configDir,
  };
}

export function buildPtyDataFrame(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.writeUInt8(0, 4);
  payload.copy(frame, 5);
  return frame;
}

export function buildPtyControlFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.writeUInt8(1, 4);
  payload.copy(frame, 5);
  return frame;
}

export function decodePtyFrames(buffer) {
  const { frames, rest } = extractPtyFrames(buffer);
  if (rest.length !== 0) throw new Error(`trailing partial PTY frame: ${rest.length} bytes`);
  return frames;
}

export function extractPtyFrames(buffer) {
  const frames = [];
  let rest = Buffer.from(buffer);
  while (rest.length >= 5) {
    const length = rest.readUInt32BE(0);
    const frameLength = 5 + length;
    if (rest.length < frameLength) break;
    const kind = rest.readUInt8(4);
    const payload = rest.subarray(5, frameLength);
    if (kind === 0) frames.push({ kind, payload: Buffer.from(payload) });
    else if (kind === 1) frames.push({ kind, ctrl: JSON.parse(payload.toString("utf8")) });
    else throw new Error(`unknown PTY frame kind ${kind}`);
    rest = rest.subarray(frameLength);
  }
  return { frames, rest };
}

export function getProcStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${pid}`);
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim();
}

export function buildRosterEntry({
  short,
  pid,
  procStart,
  cwd,
  startedAt = Date.now(),
  rendezvousSock,
  ptySock,
  messagingSock,
  cliVersion = "2.1.145",
  launchMode = "exec",
}) {
  const sessionId = `${short}-0000-4000-8000-000000000000`;
  const launch =
    launchMode === "prompt"
      ? { mode: "prompt", args: ["--", "tfx fake native worker"] }
      : { mode: "exec", cmd: "/bin/sleep", args: ["60"] };
  const dispatch = {
    proto: 1,
    short,
    sessionId,
    createdAt: startedAt,
    source: "shell",
    cwd,
    launch,
    env: {},
    isolation: "none",
    respawnFlags: [],
    seed: {
      intent: "tfx fake native worker",
      name: "tfx fake native worker",
    },
    cols: 120,
    rows: 40,
  };
  return {
    pid,
    procStart,
    sessionId,
    rendezvousSock,
    ...(ptySock ? { ptySock } : {}),
    ...(messagingSock ? { messagingSock } : {}),
    cliVersion,
    startedAt,
    attempt: 1,
    cwd,
    dispatch,
  };
}

export async function writeRoster(rosterPath, workers) {
  await fs.mkdir(path.dirname(rosterPath), { recursive: true });
  await fs.writeFile(
    rosterPath,
    `${JSON.stringify({ proto: 1, supervisorPid: 0, updatedAt: Date.now(), workers }, null, 2)}\n`,
  );
}
