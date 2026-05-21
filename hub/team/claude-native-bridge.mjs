import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  buildDaemonExecDispatchPayload,
  killDaemonJob,
  sendClaudeControlRequest,
  waitForDaemonJobPid,
} from "./claude-daemon-control.mjs";
import {
  buildClaudeSessionProjection,
  removeClaudeSessionProjection,
  writeClaudeSessionProjection,
} from "./claude-session-projection.mjs";

const DEFAULT_ROWS = 40;
const DEFAULT_COLS = 120;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const ROSTER_LOCK_STALE_MS = 30_000;
const ROSTER_LOCK_TIMEOUT_MS = 5_000;
const ROSTER_LOCK_RETRY_MS = 10;

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
    daemonDir,
    controlSock: path.join(daemonDir, "control.sock"),
    rendezvousDir: path.join(daemonDir, "rv"),
    ptyDir: path.join(daemonDir, "pty"),
    rosterPath: path.join(resolvedConfigDir, "daemon", "roster.json"),
    sessionsDir: path.join(resolvedConfigDir, "sessions"),
    jobsDir: path.join(resolvedConfigDir, "jobs"),
  };
}

export function getProcStart(pid = process.pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`invalid pid: ${pid}`);
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim();
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
    else if (kind === 1) {
      frames.push({ kind, ctrl: JSON.parse(payload.toString("utf8")) });
    } else {
      throw new Error(`unknown PTY frame kind ${kind}`);
    }
    rest = rest.subarray(frameLength);
  }
  return { frames, rest };
}

function trimTranscript(buffer) {
  if (buffer.length <= MAX_TRANSCRIPT_BYTES) return buffer;
  return buffer.subarray(buffer.length - MAX_TRANSCRIPT_BYTES);
}

function listen(server, sockPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function readRoster(rosterPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(rosterPath, "utf8"));
    return {
      proto: parsed.proto || 1,
      supervisorPid: parsed.supervisorPid || 0,
      updatedAt: parsed.updatedAt || Date.now(),
      workers:
        parsed.workers && typeof parsed.workers === "object"
          ? { ...parsed.workers }
          : {},
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { proto: 1, supervisorPid: 0, updatedAt: Date.now(), workers: {} };
  }
}

async function writeRoster(rosterPath, roster) {
  await fs.mkdir(path.dirname(rosterPath), { recursive: true });
  const tmpPath = `${rosterPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const next = { ...roster, proto: 1, updatedAt: Date.now() };
  await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, rosterPath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRosterLock(rosterPath) {
  await fs.mkdir(path.dirname(rosterPath), { recursive: true });
  const lockPath = `${rosterPath}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - startedAt > ROSTER_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for roster lock: ${lockPath}`);
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > ROSTER_LOCK_STALE_MS) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await sleep(ROSTER_LOCK_RETRY_MS);
    }
  }
}

async function withRosterLock(rosterPath, fn) {
  const release = await acquireRosterLock(rosterPath);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function mergeRosterWorkers(rosterPath, workers) {
  return withRosterLock(rosterPath, async () => {
    const roster = await readRoster(rosterPath);
    roster.workers = { ...roster.workers, ...workers };
    await writeRoster(rosterPath, roster);
    return roster;
  });
}

export async function removeRosterWorkers(rosterPath, shorts) {
  return withRosterLock(rosterPath, async () => {
    const roster = await readRoster(rosterPath);
    let changed = false;
    for (const short of shorts) {
      if (Object.hasOwn(roster.workers, short)) {
        delete roster.workers[short];
        changed = true;
      }
    }
    if (changed) await writeRoster(rosterPath, roster);
    return changed;
  });
}

export async function removeClaudeJobState(jobsDir, short) {
  if (!short) return;
  await fs.rm(path.join(jobsDir, short), { recursive: true, force: true });
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildSwarmShardBridgeCommand({ displayName, sessionId }) {
  const banner = `${displayName} native bridge active (${sessionId})`;
  return `printf '%s\\n' ${shellSingleQuote(banner)}; while true; do sleep 3600; done`;
}

function isLocalHost(host) {
  const value = String(host || "local").toLowerCase();
  return value === "local" || value === "localhost" || value === "127.0.0.1";
}

function deriveSwarmShort({ sessionId, shardName, host }) {
  return crypto
    .createHash("sha256")
    .update(`${sessionId}:${shardName}:${host || "local"}`)
    .digest("hex")
    .slice(0, 8);
}

export async function registerSwarmShard({
  sessionId,
  cli = "codex",
  role = "worker",
  shardName,
  cwd = process.cwd(),
  host = "local",
  configDir = resolveClaudeConfigDir(),
  tmpRoot = "/tmp",
  _deps = {},
} = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!shardName) throw new Error("shardName is required");

  const warn = _deps.warn || ((message) => console.warn(message));
  if (!isLocalHost(host)) {
    warn(
      `[native-bridge] remote shard ${shardName}@${host}: skipping local registration; remote launcher must register on that host`,
    );
    return {
      ok: true,
      skipped: true,
      host,
      sessionId,
      shardName,
      close() {},
    };
  }

  const derivePaths = _deps.deriveClaudeDaemonPaths || deriveClaudeDaemonPaths;
  const buildPayload =
    _deps.buildDaemonExecDispatchPayload || buildDaemonExecDispatchPayload;
  const sendControl =
    _deps.sendClaudeControlRequest || sendClaudeControlRequest;
  const waitForPid = _deps.waitForDaemonJobPid || waitForDaemonJobPid;
  const readProcStart = _deps.getProcStart || getProcStart;
  const buildProjection =
    _deps.buildClaudeSessionProjection || buildClaudeSessionProjection;
  const writeProjection =
    _deps.writeClaudeSessionProjection || writeClaudeSessionProjection;
  const removeProjection =
    _deps.removeClaudeSessionProjection || removeClaudeSessionProjection;
  const removeJobStateImpl = _deps.removeClaudeJobState || removeClaudeJobState;
  const killJob = _deps.killDaemonJob || killDaemonJob;
  const accessControlSock = _deps.accessControlSock || fs.access;

  const paths = derivePaths({ configDir, tmpRoot });
  const sessionsDir =
    paths.sessionsDir || path.join(paths.configDir || configDir, "sessions");
  const jobsDir =
    paths.jobsDir || path.join(paths.configDir || configDir, "jobs");
  const short = deriveSwarmShort({ sessionId, shardName, host });
  const displayName = `Triflux swarm ${shardName}`;
  const command = buildSwarmShardBridgeCommand({ displayName, sessionId });
  const payload = buildPayload({
    short,
    cwd,
    command,
    name: displayName,
  });

  await accessControlSock(paths.controlSock);
  const dispatch = await sendControl(
    paths.controlSock,
    {
      proto: 1,
      op: "dispatch",
      d: payload,
      timeoutMs: 1000,
    },
    { timeoutMs: 1000 },
  );
  if (dispatch?.ok !== true) {
    throw new Error(
      `Claude daemon dispatch failed for swarm shard ${shardName}`,
    );
  }

  const job = await waitForPid(paths.controlSock, short, { timeoutMs: 1000 });
  const pid = job.pid;
  const projection = buildProjection({
    pid,
    procStart: readProcStart(pid),
    sessionId: payload.sessionId,
    short,
    cwd,
    name: displayName,
    agent: cli,
    startedAt: job.startedAt || Date.now(),
    updatedAt: Date.now(),
  });
  const sessionProjectionPath = await writeProjection(sessionsDir, projection);
  let closed = false;

  return {
    ok: true,
    skipped: false,
    host: "local",
    sessionId: payload.sessionId,
    swarmSessionId: sessionId,
    shardName,
    cli,
    role,
    short,
    displayName,
    controlSock: paths.controlSock,
    sessionProjectionPath,
    async close() {
      if (closed) return;
      closed = true;
      await removeProjection(sessionProjectionPath).catch(() => {});
      await killJob(paths.controlSock, short).catch(() => {});
      await removeJobStateImpl(jobsDir, short).catch(() => {});
    },
  };
}

export function buildNativeWorkerRosterEntry({
  short,
  pid = process.pid,
  procStart,
  cwd = process.cwd(),
  startedAt = Date.now(),
  rendezvousSock,
  ptySock,
  sessionId = crypto.randomUUID(),
  cliVersion = "triflux-native-bridge",
  name = "Triflux native worker",
  prompt = "",
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
}) {
  if (!short) throw new Error("short is required");
  if (!rendezvousSock) throw new Error("rendezvousSock is required");
  if (!ptySock) throw new Error("ptySock is required");
  return {
    pid,
    procStart: procStart || getProcStart(pid),
    sessionId,
    rendezvousSock,
    ptySock,
    cliVersion,
    startedAt,
    attempt: 1,
    cwd,
    dispatch: {
      proto: 1,
      short,
      sessionId,
      createdAt: startedAt,
      source: "shell",
      cwd,
      launch: { mode: "prompt", args: ["--", prompt || name] },
      env: {},
      isolation: "none",
      respawnFlags: [],
      seed: {
        intent: prompt || name,
        name,
      },
      cols,
      rows,
    },
  };
}

export async function startNativeWorkerFacade({
  short,
  rvSock,
  ptySock,
  pid = process.pid,
  version = "triflux-native-bridge",
  initialDetail = "pending",
  onKill,
} = {}) {
  if (!short) throw new Error("short is required");
  if (!rvSock) throw new Error("rvSock is required");
  if (!ptySock) throw new Error("ptySock is required");

  await fs.mkdir(path.dirname(rvSock), { recursive: true });
  await fs.mkdir(path.dirname(ptySock), { recursive: true });
  await fs.rm(rvSock, { force: true }).catch(() => {});
  await fs.rm(ptySock, { force: true }).catch(() => {});

  const rvSockets = new Set();
  const ptySockets = new Set();
  const events = [];
  let state = { state: "running", tempo: "idle", detail: initialDetail };
  let transcript = Buffer.alloc(0);
  let closed = false;

  const writeJsonLine = (socket, message) => {
    socket.write(`${JSON.stringify(message)}\n`);
  };
  const broadcastState = (patch = {}) => {
    state = { ...state, ...patch };
    for (const socket of rvSockets) {
      writeJsonLine(socket, { type: "heartbeat" });
      writeJsonLine(socket, { type: "state", patch: state });
    }
  };
  const broadcastPty = (frame) => {
    for (const socket of ptySockets) socket.write(frame);
  };
  const appendOutput = (value) => {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    transcript = trimTranscript(Buffer.concat([transcript, payload]));
    broadcastPty(buildPtyDataFrame(payload));
  };

  const rvServer = net.createServer((socket) => {
    rvSockets.add(socket);
    events.push({ type: "rv-connect" });
    socket.setEncoding("utf8");
    socket.once("close", () => rvSockets.delete(socket));
    writeJsonLine(socket, { type: "heartbeat" });
    writeJsonLine(socket, { type: "state", patch: state });
    socket.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          events.push({ type: "rv-error", message: error.message });
          continue;
        }
        events.push({ type: "rv-message", message });
        if (message.type === "shutdown") {
          writeJsonLine(socket, { type: "shutting-down" });
          socket.end();
          if (typeof onKill === "function") onKill({ source: "rv", message });
        } else if (message.type === "repaint") {
          writeJsonLine(socket, { type: "repaint-done" });
        } else if (message.type === "reply") {
          broadcastState({
            tempo: "idle",
            detail: `reply:${String(message.text || "").slice(0, 120)}`,
          });
        } else {
          writeJsonLine(socket, { type: "ack", requestType: message.type });
        }
      }
    });
  });

  const ptyServer = net.createServer((socket) => {
    ptySockets.add(socket);
    events.push({ type: "pty-connect" });
    socket.once("close", () => ptySockets.delete(socket));
    socket.write(buildPtyControlFrame({ t: "hello", replPid: pid, version }));
    if (transcript.length > 0) socket.write(buildPtyDataFrame(transcript));
    socket.write(buildPtyControlFrame({ t: "live" }));
    let ptyBuffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        const result = extractPtyFrames(Buffer.concat([ptyBuffer, chunk]));
        ptyBuffer = result.rest;
        for (const frame of result.frames) {
          events.push({
            type: "pty-frame",
            frame:
              frame.kind === 1
                ? frame.ctrl
                : { kind: 0, bytes: frame.payload.length },
          });
          if (frame.kind === 0) appendOutput(frame.payload);
          else if (frame.ctrl.t === "resize") {
            socket.write(buildPtyControlFrame({ t: "live" }));
          } else if (frame.ctrl.t === "kill") {
            socket.write(
              buildPtyControlFrame({
                t: "exit",
                code: 0,
                signal: frame.ctrl.sig,
              }),
            );
            socket.end();
            if (typeof onKill === "function") {
              onKill({ source: "pty", message: frame.ctrl });
            }
          }
        }
      } catch (error) {
        events.push({ type: "pty-error", message: error.message });
        socket.destroy(error);
      }
    });
  });

  try {
    await listen(rvServer, rvSock);
    await listen(ptyServer, ptySock);
  } catch (error) {
    await Promise.all([closeServer(rvServer), closeServer(ptyServer)]);
    await fs.rm(rvSock, { force: true }).catch(() => {});
    await fs.rm(ptySock, { force: true }).catch(() => {});
    throw error;
  }

  return {
    short,
    rvSock,
    ptySock,
    getEvents() {
      return events.slice();
    },
    update(patch) {
      if (closed) return;
      broadcastState(patch);
    },
    writeOutput(value) {
      if (closed) return;
      appendOutput(value);
    },
    async close({ exitCode = 0 } = {}) {
      if (closed) return;
      closed = true;
      broadcastPty(buildPtyControlFrame({ t: "exit", code: exitCode }));
      for (const socket of rvSockets) socket.destroy();
      for (const socket of ptySockets) socket.destroy();
      await Promise.all([closeServer(rvServer), closeServer(ptyServer)]);
      await fs.rm(rvSock, { force: true }).catch(() => {});
      await fs.rm(ptySock, { force: true }).catch(() => {});
    },
  };
}

export async function startClaudeNativeBridge({
  sessionName,
  assignments,
  configDir = resolveClaudeConfigDir(),
  cwd = process.cwd(),
  pid,
  procStart,
  tmpRoot = os.tmpdir(),
  onKill,
} = {}) {
  if (!sessionName) throw new Error("sessionName is required");
  const paths = deriveClaudeDaemonPaths({ configDir, tmpRoot: "/tmp" });
  void tmpRoot; // UDS sockets must stay short on macOS; use /tmp below.
  const socketHash = crypto
    .createHash("sha256")
    .update(`${configDir}:${sessionName}:${process.pid}:${Date.now()}`)
    .digest("hex")
    .slice(0, 10);
  const socketRoot = path.join("/tmp", `tfx-cn-${socketHash}`);
  await fs.mkdir(socketRoot, { recursive: true });
  const startedAt = Date.now();
  const facades = [];
  const sentinels = [];
  const rosterWorkers = {};
  const byPaneName = new Map();

  try {
    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index] || {};
      const paneName = `worker-${index + 1}`;
      const cli = assignment.cli || "codex";
      const role = assignment.role || paneName;
      const short = crypto
        .createHash("sha256")
        .update(`${sessionName}:${index}:${startedAt}:${crypto.randomUUID()}`)
        .digest("hex")
        .slice(0, 8);
      const sentinel =
        pid == null
          ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
              stdio: "ignore",
            })
          : null;
      if (sentinel) {
        sentinel.unref();
        sentinels.push(sentinel);
      }
      const workerPid = pid || sentinel?.pid;
      if (!workerPid) throw new Error("native bridge sentinel pid unavailable");
      const rvSock = path.join(socketRoot, `${short}.rv.sock`);
      const ptySock = path.join(socketRoot, `${short}.pty.sock`);
      const facade = await startNativeWorkerFacade({
        short,
        rvSock,
        ptySock,
        pid: workerPid,
        initialDetail: `${cli}:${role}:pending`,
        onKill,
      });
      const workerCwd = assignment.cwd || assignment.workdir || cwd;
      rosterWorkers[short] = buildNativeWorkerRosterEntry({
        short,
        pid: workerPid,
        procStart: procStart || getProcStart(workerPid),
        cwd: workerCwd,
        startedAt,
        rendezvousSock: rvSock,
        ptySock,
        name: `Triflux ${cli} ${role}`,
        prompt: assignment.prompt || "",
      });
      facades.push(facade);
      byPaneName.set(paneName, { facade, cli, role, short });
    }

    await mergeRosterWorkers(paths.rosterPath, rosterWorkers);
  } catch (error) {
    await Promise.all(facades.map((facade) => facade.close()));
    for (const sentinel of sentinels) {
      try {
        sentinel.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await fs.rm(socketRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    rosterPath: paths.rosterPath,
    controlSock: paths.controlSock,
    workers: Object.keys(rosterWorkers),
    handleProgress(event) {
      const worker = byPaneName.get(event?.paneName);
      if (!worker) return;
      if (event.type === "worker_added" || event.type === "dispatched") {
        worker.facade.update({
          state: "running",
          tempo: "busy",
          detail: `${worker.cli}:${worker.role}:${event.type}`,
        });
      } else if (event.type === "progress") {
        const lastLine =
          String(event.snapshot || "")
            .split("\n")
            .filter((line) => line.trim())
            .pop() || "";
        worker.facade.update({
          state: "running",
          tempo: "busy",
          detail: lastLine.slice(0, 160) || `${worker.cli}:running`,
        });
        if (lastLine) worker.facade.writeOutput(`${lastLine}\r\n`);
      } else if (event.type === "completed") {
        const ok = event.matched && event.exitCode === 0;
        worker.facade.update({
          state: "running",
          tempo: "idle",
          detail: ok ? `${worker.cli}:completed` : `${worker.cli}:failed`,
        });
        worker.facade.writeOutput(
          `triflux ${worker.cli} ${ok ? "completed" : "failed"} exit=${event.exitCode ?? "null"}\r\n`,
        );
      }
    },
    completeWorker(result) {
      const worker = byPaneName.get(result?.paneName);
      if (!worker) return;
      worker.facade.writeOutput(
        `\r\n${String(result.output || "").slice(0, 4096)}\r\n`,
      );
      worker.facade.update({
        state: "running",
        tempo: "idle",
        detail:
          result.matched && result.exitCode === 0
            ? `${worker.cli}:handoff-ready`
            : `${worker.cli}:needs-attention`,
      });
    },
    async close() {
      await Promise.all(facades.map((facade) => facade.close()));
      await removeRosterWorkers(paths.rosterPath, Object.keys(rosterWorkers));
      for (const sentinel of sentinels) {
        if (sentinel.exitCode !== null || sentinel.signalCode !== null) {
          continue;
        }
        try {
          sentinel.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      await fs.rm(socketRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
