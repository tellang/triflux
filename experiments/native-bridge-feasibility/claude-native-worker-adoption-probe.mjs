import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  buildRosterEntry,
  buildIsolatedDaemonEnv,
  deriveDaemonPaths,
  getProcStart,
  sendControlRequest,
  writeRoster,
} from "./claude-native-worker-protocol.mjs";
import { startFakeNativeWorker } from "./fake-claude-native-worker.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      await sleep(100);
    }
  }
  return false;
}

function startDaemon({ configDir, logFile }) {
  return spawn("claude", ["daemon", "run", path.join(configDir, "daemon.json"), "--log-file", logFile], {
    env: buildIsolatedDaemonEnv(configDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopDaemon(daemon, controlSock) {
  await sendControlRequest(controlSock, { proto: 1, op: "shutdown", reapWorkers: false }, { timeoutMs: 1000 })
    .catch(() => {});
  if (await waitForExit(daemon, 2000)) return;
  daemon.kill("SIGTERM");
  if (await waitForExit(daemon, 2000)) return;
  daemon.kill("SIGKILL");
  if (!(await waitForExit(daemon, 2000))) {
    throw new Error(`isolated daemon did not exit after SIGKILL: pid=${daemon.pid}`);
  }
}

async function collectSubscribe(controlSock, short, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(controlSock);
    const messages = [];
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(messages);
    }, timeoutMs);

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(messages);
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ proto: 1, op: "subscribe", short, tail: 10 })}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      while (data.includes("\n")) {
        const index = data.indexOf("\n");
        const line = data.slice(0, index);
        data = data.slice(index + 1);
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(messages);
    });
  });
}

async function collectAttach(controlSock, short, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(controlSock);
    let buffer = Buffer.alloc(0);
    let response;
    let stream = Buffer.alloc(0);
    let settled = false;
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        response,
        streamText: stream.toString("utf8"),
        streamBytes: stream.length,
        ...extra,
      });
    };
    const timer = setTimeout(() => finish(), timeoutMs);

    socket.on("error", (error) => finish({ error: error.message }));
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          proto: 1,
          op: "attach",
          short,
          cols: 120,
          rows: 40,
          caps: { terminal: null, mux: null, ssh: false },
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!response) {
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        stream = Buffer.concat([stream, buffer.subarray(newline + 1)]);
        buffer = Buffer.alloc(0);
        return;
      }
      stream = Buffer.concat([stream, buffer]);
      buffer = Buffer.alloc(0);
    });
    socket.on("close", () => finish());
  });
}

function parseScenario(argv) {
  const equalsArg = argv.find((arg) => arg.startsWith("--scenario="));
  if (equalsArg) return equalsArg.slice("--scenario=".length);
  const flagIndex = argv.indexOf("--scenario");
  if (flagIndex >= 0 && argv[flagIndex + 1]) return argv[flagIndex + 1];
  return "startup-native";
}

function compactJob(job) {
  if (!job) return job;
  return {
    short: job.short,
    pid: job.pid,
    sessionId: job.sessionId,
    state: job.state,
    tempo: job.tempo,
    backend: job.backend,
    legacy: job.legacy,
    detail: job.detail,
    name: job.name,
    messagingSock: job.messagingSock,
  };
}

export default async function runProbe({ scenario = "startup-native", cleanup = true } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `tfx-native-${scenario}-`));
  const configDir = path.join(tmp, "config");
  await fs.mkdir(path.join(configDir, "daemon"), { recursive: true });
  const paths = deriveDaemonPaths({ configDir });
  const short = crypto.randomBytes(4).toString("hex");
  const sleeper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  let daemon;
  let fakeWorker;

  try {
    const startedAt = Date.now();
    const rvSock = path.join(tmp, "worker.rv.sock");
    const ptySock = scenario === "startup-native" ? path.join(tmp, "worker.pty.sock") : undefined;
    const messagingSock = path.join(tmp, "worker.msg.sock");
    if (scenario === "startup-native") {
      fakeWorker = await startFakeNativeWorker({ rvSock, ptySock, pid: sleeper.pid });
    }
    const entry = buildRosterEntry({
      short,
      pid: sleeper.pid,
      procStart: getProcStart(sleeper.pid),
      cwd: process.cwd(),
      startedAt,
      rendezvousSock: rvSock,
      ptySock,
      messagingSock,
      launchMode: scenario === "startup-native" ? "prompt" : "exec",
    });

    if (scenario === "hot-roster") {
      daemon = startDaemon({ configDir, logFile: path.join(tmp, "daemon.log") });
      if (!(await waitForFile(paths.controlSock))) throw new Error(`control.sock not found: ${paths.controlSock}`);
      const before = await sendControlRequest(paths.controlSock, { proto: 1, op: "list" });
      await writeRoster(paths.rosterPath, { [short]: entry });
      await sleep(750);
      const afterList = await sendControlRequest(paths.controlSock, { proto: 1, op: "list" });
      const afterHas = await sendControlRequest(paths.controlSock, { proto: 1, op: "has", short });
      return { scenario, tmp, short, before, afterList, afterHas };
    }

    await writeRoster(paths.rosterPath, { [short]: entry });
    daemon = startDaemon({ configDir, logFile: path.join(tmp, "daemon.log") });
    if (!(await waitForFile(paths.controlSock))) throw new Error(`control.sock not found: ${paths.controlSock}`);
    await sleep(1000);
    const list = await sendControlRequest(paths.controlSock, { proto: 1, op: "list" });
    const has = await sendControlRequest(paths.controlSock, { proto: 1, op: "has", short });
    const subscribe = await collectSubscribe(paths.controlSock, short);
    const attach = scenario === "startup-native" ? await collectAttach(paths.controlSock, short) : undefined;
    const resize =
      scenario === "startup-native"
        ? await sendControlRequest(paths.controlSock, { proto: 1, op: "resize", short, cols: 100, rows: 30 })
        : undefined;
    await sleep(300);
    const kill =
      scenario === "startup-native"
        ? await sendControlRequest(paths.controlSock, { proto: 1, op: "kill", short, signal: "SIGTERM" })
        : undefined;
    await sleep(300);
    const fakeWorkerEvents = fakeWorker?.getEvents();
    return {
      scenario,
      tmp,
      short,
      list: { ...list, jobs: list.jobs?.map(compactJob) },
      has,
      subscribe,
      ...(attach ? { attach } : {}),
      ...(resize ? { resize } : {}),
      ...(kill ? { kill } : {}),
      ...(fakeWorkerEvents ? { fakeWorkerEvents } : {}),
    };
  } finally {
    if (daemon) await stopDaemon(daemon, paths.controlSock);
    if (fakeWorker) await fakeWorker.close();
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {}
    if (cleanup) await fs.rm(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProbe({ scenario: parseScenario(process.argv.slice(2)), cleanup: true })
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
