import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDaemonControlAuth,
  sendControlRequest,
} from "../../experiments/native-bridge-feasibility/claude-native-worker-protocol.mjs";
import {
  deriveClaudeDaemonPaths,
  startClaudeNativeBridge,
} from "../../hub/team/claude-native-bridge.mjs";

const CLI_PROBE_TIMEOUT_MS = 10_000;
const DAEMON_READY_TIMEOUT_MS = 15_000;
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const ATTACH_TIMEOUT_MS = 5_000;
const DAEMON_EXIT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

const claudeAvailable =
  spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: CLI_PROBE_TIMEOUT_MS,
  }).status === 0;
const claudeSkipReason =
  "Claude CLI is unavailable or did not respond to `claude --version` in time";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = DAEMON_READY_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  return false;
}

async function waitForAdoptedWorker(controlSock, short) {
  const start = Date.now();
  while (Date.now() - start < DAEMON_READY_TIMEOUT_MS) {
    try {
      const has = await sendControlRequest(
        controlSock,
        { proto: 1, op: "has", short },
        { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS },
      );
      if (has.ok && has.present && has.alive) return has;
    } catch {}
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

function buildIsolatedDaemonEnv(configDir, baseEnv = process.env) {
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

function startDaemon({ configDir, logFile }) {
  return spawn(
    "claude",
    [
      "daemon",
      "run",
      path.join(configDir, "daemon.json"),
      "--log-file",
      logFile,
    ],
    {
      env: buildIsolatedDaemonEnv(configDir),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
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
  await sendControlRequest(
    controlSock,
    { proto: 1, op: "shutdown", reapWorkers: false },
    { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS },
  ).catch(() => {});
  if (await waitForExit(daemon, DAEMON_EXIT_TIMEOUT_MS)) return;
  daemon.kill("SIGTERM");
  if (await waitForExit(daemon, DAEMON_EXIT_TIMEOUT_MS)) return;
  daemon.kill("SIGKILL");
  await waitForExit(daemon, DAEMON_EXIT_TIMEOUT_MS);
}

async function collectAttach(
  controlSock,
  short,
  { timeoutMs = ATTACH_TIMEOUT_MS, configDir } = {},
) {
  const authPayload = await buildDaemonControlAuth(configDir);
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
          ...authPayload,
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
        if (stream.length > 0) finish();
        return;
      }
      stream = Buffer.concat([stream, buffer]);
      buffer = Buffer.alloc(0);
      if (stream.length > 0) finish();
    });
    socket.on("close", () => finish());
  });
}

async function runScenario(scenario) {
  const { default: runProbe } = await import(
    "../../experiments/native-bridge-feasibility/claude-native-worker-adoption-probe.mjs"
  );
  return runProbe({ scenario, cleanup: true });
}

test("hot-roster does not register in the live daemon map", {
  skip: claudeAvailable ? false : claudeSkipReason,
}, async () => {
  const report = await runScenario("hot-roster");
  assert.equal(report.afterHas.ok, true);
  assert.equal(report.afterHas.present, false);
  assert.equal(report.afterHas.alive, false);
});

test("startup-legacy adopts a schema-valid pid without PTY as legacy", {
  skip: claudeAvailable ? false : claudeSkipReason,
}, async () => {
  const report = await runScenario("startup-legacy");
  assert.equal(report.has.ok, true);
  assert.equal(report.has.present, true);
  assert.equal(report.has.alive, true);
  assert.equal(report.list.jobs[0].legacy, true);
});

test("startup-native adopts fake RV and PTY worker", {
  skip: claudeAvailable ? false : claudeSkipReason,
}, async () => {
  const report = await runScenario("startup-native");
  assert.equal(report.has.ok, true);
  assert.equal(report.has.present, true);
  assert.equal(report.has.alive, true);
  assert.notEqual(report.list.jobs[0].legacy, true);
  assert.equal(
    report.subscribe.some((message) => message.type === "snapshot"),
    true,
  );
  assert.equal(
    report.subscribe.some((message) => message.type === "state"),
    true,
  );
  assert.equal(report.attach.response.ok, true);
  assert.equal(report.attach.response.op, "attach");
  assert.match(
    report.attach.streamText,
    /tfx fake native worker (online|heartbeat)/,
  );
  assert.deepEqual(report.resize, { ok: true, op: "resize" });
  assert.deepEqual(report.kill, { ok: true, op: "kill" });
  assert.equal(
    report.fakeWorkerEvents.some((event) => event.frame?.t === "resize"),
    true,
  );
  assert.equal(
    report.fakeWorkerEvents.some((event) => event.frame?.t === "kill"),
    true,
  );
});

test("startup-native adopts production Triflux native bridge facade", {
  skip: claudeAvailable ? false : claudeSkipReason,
}, async () => {
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-native-prod-adopt-"),
  );
  const configDir = path.join(tmp, "config");
  const paths = deriveClaudeDaemonPaths({ configDir });
  let daemon;
  let bridge;
  try {
    bridge = await startClaudeNativeBridge({
      sessionName: "prod-adopt",
      assignments: [
        { cli: "codex", role: "executor", prompt: "production adoption" },
      ],
      configDir,
    });
    daemon = startDaemon({ configDir, logFile: path.join(tmp, "daemon.log") });
    assert.equal(await waitForFile(paths.controlSock), true);
    const short = bridge.workers[0];
    const has = await waitForAdoptedWorker(paths.controlSock, short);
    assert.ok(has, "daemon did not adopt the production bridge worker in time");
    const list = await sendControlRequest(
      paths.controlSock,
      { proto: 1, op: "list" },
      { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS },
    );
    const attach = await collectAttach(paths.controlSock, short, { configDir });
    const resize = await sendControlRequest(
      paths.controlSock,
      { proto: 1, op: "resize", short, cols: 100, rows: 30 },
      { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS },
    );
    const kill = await sendControlRequest(
      paths.controlSock,
      { proto: 1, op: "kill", short, signal: "SIGTERM" },
      { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS },
    );

    assert.equal(has.ok, true);
    assert.equal(has.present, true);
    assert.equal(has.alive, true);
    assert.notEqual(
      list.jobs?.find((job) => job.short === short)?.legacy,
      true,
    );
    assert.equal(attach.response.ok, true);
    assert.equal(attach.response.op, "attach");
    assert.equal(attach.streamBytes > 0, true);
    assert.deepEqual(resize, { ok: true, op: "resize" });
    assert.deepEqual(kill, { ok: true, op: "kill" });
  } finally {
    if (daemon) await stopDaemon(daemon, paths.controlSock);
    if (bridge) await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
