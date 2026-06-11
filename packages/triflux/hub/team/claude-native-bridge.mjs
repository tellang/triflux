import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  buildDaemonExecDispatchPayload,
  deriveClaudeDaemonPaths,
  dispatchClaudeDaemonJob,
  getProcStart,
  killDaemonJob,
  resolveClaudeConfigDir,
  resolveDaemonBridgeSessionId,
  sendClaudeControlRequest,
  teardownClaudeDaemonJob,
  waitForDaemonJobPid,
} from "./claude-daemon-control.mjs";
import {
  buildClaudeSessionProjection,
  removeClaudeSessionProjection,
  writeClaudeSessionProjection,
} from "./claude-session-projection.mjs";
import { createInteractiveTuiTransport } from "./interactive-tui-transport.mjs";

// daemon-control 이 deriveClaudeDaemonPaths / getProcStart /
// resolveClaudeConfigDir 의 단일 owner 다. configDir 해석이 갈리면 양쪽이
// 서로 다른 control.sock hash 를 보게 되므로 (HOME 오버라이드 split-brain)
// 로컬 복제본을 두지 않는다. 기존 import 경로 호환을 위해 re-export 한다.
export { deriveClaudeDaemonPaths, getProcStart, resolveClaudeConfigDir };

const DEFAULT_ROWS = 40;
const DEFAULT_COLS = 120;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const ROSTER_LOCK_STALE_MS = 30_000;
const ROSTER_LOCK_TIMEOUT_MS = 5_000;
const ROSTER_LOCK_RETRY_MS = 10;

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

function normalizeWorkerType(value) {
  return value === "interactive" ? "interactive" : "headless";
}

function buildInteractiveTransportSessionName(...parts) {
  const raw = parts.filter(Boolean).join("-");
  return raw
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function createStopOnce(transport) {
  let stopPromise = null;
  return () => {
    if (!stopPromise) {
      stopPromise = Promise.resolve()
        .then(() => transport.stop())
        .catch(() => {});
    }
    return stopPromise;
  };
}

function compactDisplayPart(value, fallback = "") {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function toPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function formatShardOrdinal({ shardIndex, shardCount }) {
  const index = toPositiveInteger(shardIndex);
  const count = toPositiveInteger(shardCount);
  if (!index || !count) return null;
  const width = Math.max(String(count).length, 2);
  return `${String(index).padStart(width, "0")}/${String(count).padStart(width, "0")}`;
}

function buildSwarmShardDisplayName({
  sessionId,
  cli,
  swarmName,
  shardIndex,
  shardCount,
  shardName,
}) {
  const groupName = compactDisplayPart(swarmName || sessionId, "swarm");
  const agentName = compactDisplayPart(cli, "agent");
  const workerName = compactDisplayPart(shardName, "shard");
  return [
    "Triflux swarm",
    groupName,
    formatShardOrdinal({ shardIndex, shardCount }),
    agentName,
    workerName,
  ]
    .filter(Boolean)
    .join(" ");
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
  swarmName,
  shardIndex,
  shardCount,
  shardName,
  cwd = process.cwd(),
  host = "local",
  interactive = false,
  workerType,
  launchCmd = "codex",
  env = {},
  configDir = resolveClaudeConfigDir(),
  tmpRoot = "/tmp",
  _deps = {},
} = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!shardName) throw new Error("shardName is required");

  const displayName = buildSwarmShardDisplayName({
    sessionId,
    cli,
    swarmName,
    shardIndex,
    shardCount,
    shardName,
  });
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
      displayName,
      close() {},
    };
  }

  const derivePaths = _deps.deriveClaudeDaemonPaths || deriveClaudeDaemonPaths;
  const buildPayload =
    _deps.buildDaemonExecDispatchPayload || buildDaemonExecDispatchPayload;
  const sendControl =
    _deps.sendClaudeControlRequest || sendClaudeControlRequest;
  const waitForPid = _deps.waitForDaemonJobPid || waitForDaemonJobPid;
  const resolveBridgeSessionId =
    _deps.resolveDaemonBridgeSessionId || resolveDaemonBridgeSessionId;
  const readProcStart = _deps.getProcStart || getProcStart;
  const buildProjection =
    _deps.buildClaudeSessionProjection || buildClaudeSessionProjection;
  const writeProjection =
    _deps.writeClaudeSessionProjection || writeClaudeSessionProjection;
  const removeProjection =
    _deps.removeClaudeSessionProjection || removeClaudeSessionProjection;
  const mergeRoster = _deps.mergeRosterWorkers || mergeRosterWorkers;
  const removeRoster = _deps.removeRosterWorkers || removeRosterWorkers;
  const createTransport =
    _deps.createInteractiveTuiTransport || createInteractiveTuiTransport;
  const removeJobStateImpl = _deps.removeClaudeJobState || removeClaudeJobState;
  const killJob = _deps.killDaemonJob || killDaemonJob;
  const accessControlSock = _deps.accessControlSock || fs.access;
  const dispatchJob = _deps.dispatchClaudeDaemonJob || dispatchClaudeDaemonJob;
  const teardownJob = _deps.teardownClaudeDaemonJob || teardownClaudeDaemonJob;

  const paths = derivePaths({ configDir, tmpRoot });
  const sessionsDir =
    paths.sessionsDir || path.join(paths.configDir || configDir, "sessions");
  const jobsDir =
    paths.jobsDir || path.join(paths.configDir || configDir, "jobs");
  const short = deriveSwarmShort({ sessionId, shardName, host });
  const command = buildSwarmShardBridgeCommand({ displayName, sessionId });
  const resolvedWorkerType = interactive
    ? "interactive"
    : normalizeWorkerType(workerType);

  if (resolvedWorkerType === "interactive") {
    const rvSock = path.join(paths.rendezvousDir, `${short}.rv.sock`);
    const ptySock = path.join(paths.ptyDir, `${short}.pty.sock`);
    let facade = null;
    let rosterWritten = false;
    const transport = createTransport({
      sessionName: buildInteractiveTransportSessionName(
        "tfx",
        "swarm",
        sessionId,
        shardName,
        short,
      ),
      cwd,
      launchCmd,
      env,
      onData(chunk) {
        if (facade) facade.writeOutput(chunk);
      },
    });
    const stopTransport = createStopOnce(transport);

    try {
      facade = await startNativeWorkerFacade({
        short,
        rvSock,
        ptySock,
        pid: process.pid,
        initialDetail: `${cli}:${role}:interactive`,
        workerType: "interactive",
        onInput(payload) {
          void Promise.resolve()
            .then(() => transport.writeInput(payload))
            .catch(() => {});
        },
        onResize(size) {
          void Promise.resolve()
            .then(() => transport.resize(size))
            .catch(() => {});
        },
        onKill() {
          void stopTransport();
        },
      });
      await transport.start();
      const rosterEntry = buildNativeWorkerRosterEntry({
        short,
        pid: process.pid,
        procStart: readProcStart(process.pid),
        sessionId,
        cwd,
        startedAt: Date.now(),
        rendezvousSock: rvSock,
        ptySock,
        name: displayName,
        prompt: displayName,
      });
      await mergeRoster(paths.rosterPath, { [short]: rosterEntry });
      rosterWritten = true;
    } catch (error) {
      await stopTransport();
      if (facade) await facade.close({ exitCode: 1 }).catch(() => {});
      throw error;
    }

    let closed = false;
    return {
      ok: true,
      skipped: false,
      interactive: true,
      host: "local",
      sessionId,
      swarmSessionId: sessionId,
      shardName,
      cli,
      role,
      short,
      displayName,
      rosterPath: paths.rosterPath,
      async close() {
        if (closed) return;
        closed = true;
        if (rosterWritten) await removeRoster(paths.rosterPath, [short]);
        await stopTransport();
        if (facade) await facade.close().catch(() => {});
      },
    };
  }

  const payload = buildPayload({
    short,
    cwd,
    command,
    name: displayName,
  });

  // native-bridge 는 데몬이 없으면 빠르게 실패해야 하므로 1000ms 로 고정한다
  // (headless 의 5000ms 와 다르므로 명시 전달).
  const dispatched = await dispatchJob({
    paths,
    controlSock: paths.controlSock,
    payload,
    agent: cli,
    name: displayName,
    cwd,
    dispatchTimeoutMs: 1000,
    pidTimeoutMs: 1000,
    bridgeTimeoutMs: 1000,
    accessControlSock,
    _deps: {
      sendClaudeControlRequest: sendControl,
      waitForDaemonJobPid: waitForPid,
      resolveDaemonBridgeSessionId: resolveBridgeSessionId,
      buildClaudeSessionProjection: buildProjection,
      writeClaudeSessionProjection: writeProjection,
      getProcStart: readProcStart,
    },
  });
  const sessionProjectionPath = dispatched.sessionProjectionPath;
  void sessionsDir;
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
      await teardownJob({
        controlSock: paths.controlSock,
        short,
        sessionProjectionPath,
        jobsDir,
        removeJobState: true,
        _deps: {
          removeClaudeSessionProjection: removeProjection,
          killDaemonJob: killJob,
          removeClaudeJobState: removeJobStateImpl,
        },
      });
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
  workerType = "headless",
  onInput,
  onResize,
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
  const handlePtyInput =
    workerType === "interactive" && typeof onInput === "function"
      ? onInput
      : appendOutput;

  const rvServer = net.createServer((socket) => {
    rvSockets.add(socket);
    events.push({ type: "rv-connect" });
    socket.setEncoding("utf8");
    socket.once("close", () => rvSockets.delete(socket));
    socket.on("error", (error) => {
      events.push({ type: "rv-socket-error", message: error.message });
    });
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
    socket.on("error", (error) => {
      events.push({ type: "pty-socket-error", message: error.message });
    });
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
          if (frame.kind === 0) handlePtyInput(frame.payload);
          else if (frame.ctrl.t === "resize") {
            if (
              workerType === "interactive" &&
              typeof onResize === "function"
            ) {
              const cols = toPositiveInteger(frame.ctrl.cols);
              const rows = toPositiveInteger(frame.ctrl.rows);
              if (cols && rows) {
                void Promise.resolve()
                  .then(() => onResize({ cols, rows }))
                  .catch((error) => {
                    events.push({
                      type: "pty-resize-error",
                      message: error.message,
                    });
                  });
              }
            }
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
  workerType = "headless",
  launchCmd = "codex",
  env = {},
  createTransport = createInteractiveTuiTransport,
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
  const transportStops = [];
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
      const workerCwd = assignment.cwd || assignment.workdir || cwd;
      const assignmentWorkerType = normalizeWorkerType(
        assignment.workerType || workerType,
      );
      let facade = null;
      if (assignmentWorkerType === "interactive") {
        const transport = createTransport({
          sessionName: buildInteractiveTransportSessionName(
            sessionName,
            paneName,
            short,
          ),
          cwd: workerCwd,
          launchCmd: assignment.launchCmd || launchCmd,
          env: assignment.env || env,
          onData(chunk) {
            if (facade) facade.writeOutput(chunk);
          },
        });
        const stopTransport = createStopOnce(transport);
        transportStops.push(stopTransport);
        facade = await startNativeWorkerFacade({
          short,
          rvSock,
          ptySock,
          pid: workerPid,
          initialDetail: `${cli}:${role}:interactive`,
          workerType: "interactive",
          onInput(payload) {
            void Promise.resolve()
              .then(() => transport.writeInput(payload))
              .catch(() => {});
          },
          onResize(size) {
            void Promise.resolve()
              .then(() => transport.resize(size))
              .catch(() => {});
          },
          onKill(event) {
            void stopTransport();
            if (typeof onKill === "function") onKill(event);
          },
        });
        try {
          await transport.start();
        } catch (error) {
          await stopTransport();
          await facade.close({ exitCode: 1 }).catch(() => {});
          throw error;
        }
      } else {
        facade = await startNativeWorkerFacade({
          short,
          rvSock,
          ptySock,
          pid: workerPid,
          initialDetail: `${cli}:${role}:pending`,
          onKill,
        });
      }
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
      byPaneName.set(paneName, {
        facade,
        cli,
        role,
        short,
        workerType: assignmentWorkerType,
      });
    }

    await mergeRosterWorkers(paths.rosterPath, rosterWorkers);
  } catch (error) {
    await Promise.all(transportStops.map((stop) => stop()));
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
      if (worker.workerType === "interactive") return;
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
      if (worker.workerType === "interactive") return;
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
      await Promise.all(transportStops.map((stop) => stop()));
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
