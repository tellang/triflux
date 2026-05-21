#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultReportPath = path.join(here, "daemon-dispatch-latest-report.json");

function defaultDaemonTmpRoot() {
  return process.env.TERMUX_VERSION && process.env.PREFIX
    ? path.join(process.env.PREFIX, "tmp")
    : "/tmp";
}

export function deriveDaemonPaths({
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  tmpRoot = defaultDaemonTmpRoot(),
} = {}) {
  const resolvedConfigDir = path.resolve(configDir);
  const hash = crypto.createHash("sha256").update(resolvedConfigDir).digest("hex").slice(0, 8);
  const daemonDir = path.join(tmpRoot, `cc-daemon-${uid}`, hash);
  return {
    configDir,
    resolvedConfigDir,
    uid,
    hash,
    daemonDir,
    controlSock: path.join(daemonDir, "control.sock"),
    rendezvousDir: path.join(daemonDir, "rv"),
    ptyDir: path.join(daemonDir, "pty"),
    spareDir: path.join(daemonDir, "spare"),
    rosterPath: path.join(configDir, "daemon", "roster.json"),
  };
}

export function readJsonLine(text) {
  const line = text.split("\n").find((entry) => entry.trim().length > 0);
  if (!line) throw new Error("empty daemon response");
  return JSON.parse(line);
}

function redactJob(job) {
  return {
    short: job.short,
    pid: job.pid,
    sessionId: job.sessionId,
    state: job.state,
    tempo: job.tempo,
    cwd: job.cwd,
    backend: job.backend,
    name: job.name,
    agent: job.agent,
    source: job.source,
    cliVersion: job.cliVersion,
    outcome: job.outcome,
    dying: job.dying,
  };
}

export function redactControlResponse(response) {
  if (!response || typeof response !== "object") return response;
  if (!Array.isArray(response.jobs)) return response;
  return {
    ...response,
    jobs: response.jobs.map((job) =>
      Object.fromEntries(
        Object.entries(redactJob(job)).filter(([, value]) => value !== undefined),
      ),
    ),
  };
}

function redactPatch(patch) {
  if (!patch || typeof patch !== "object") return patch;
  const { detail, intent, needs, ...rest } = patch;
  return rest;
}

export function redactSubscribeMessages(messages) {
  return messages.map((message) => {
    if (message.type === "snapshot" && message.record) {
      return {
        ...message,
        record: Object.fromEntries(
          Object.entries(redactJob(message.record)).filter(([, value]) => value !== undefined),
        ),
      };
    }
    if (message.type === "state" && message.patch) {
      return {
        ...message,
        patch: redactPatch(message.patch),
      };
    }
    if (message.type === "stream" && typeof message.line === "string") {
      return {
        type: "stream",
        bytes: Buffer.byteLength(message.line),
      };
    }
    return message;
  });
}

export function sendControlRequest(sockPath, request, { timeoutMs = 6000 } = {}) {
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

    socket.setTimeout(timeoutMs, () => finish(new Error(`Timed out connecting to ${sockPath}`)));
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      try {
        finish(null, readJsonLine(data));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("close", () => {
      if (!settled && data.length > 0) {
        try {
          finish(null, readJsonLine(data));
        } catch (error) {
          finish(error);
        }
      } else if (!settled) {
        finish(new Error("daemon closed connection without a response"));
      }
    });
  });
}

export function buildDispatchPayload({
  short = crypto.randomBytes(4).toString("hex"),
  cwd = process.cwd(),
  createdAt = Date.now(),
  mode = "exec",
  command = "/bin/sh",
  args = ["-lc", "printf 'tfx-daemon-dispatch-poc\\n'; sleep 1"],
  prompt = "Say exactly TFX_DAEMON_DISPATCH_POC_DONE and then stop.",
} = {}) {
  const uuid = crypto.randomUUID();
  const sessionId = `${short}${uuid.slice(8)}`;
  const base = {
    proto: 1,
    short,
    sessionId,
    createdAt,
    source: "shell",
    cwd,
    env: {},
    isolation: "none",
    respawnFlags: [],
    cols: 120,
    rows: 40,
  };

  if (mode === "prompt") {
    return {
      ...base,
      agent: "claude",
      launch: {
        mode: "prompt",
        args: [
          "--session-id",
          sessionId,
          "--agent",
          "claude",
          "--permission-mode",
          "auto",
          "--",
          prompt,
        ],
      },
      seed: {
        intent: prompt,
        name: "tfx daemon dispatch prompt smoke",
      },
    };
  }

  return {
    ...base,
    launch: {
      mode: "exec",
      cmd: command,
      args,
    },
    seed: {
      intent: "tfx daemon dispatch exec smoke",
      name: "tfx daemon dispatch exec smoke",
    },
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(paths) {
  if (await exists(paths.controlSock)) return { started: false, command: null };
  const result = run("claude", ["agents", "--json"]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await exists(paths.controlSock)) {
      return { started: true, command: result };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { started: false, command: result, error: `control.sock not found at ${paths.controlSock}` };
}

async function collectSubscribe(sockPath, short, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    const messages = [];
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(messages);
    }, timeoutMs);
    timer.unref?.();

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(messages);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ proto: 1, op: "subscribe", short, tail: 20 })}\n`);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      while (data.includes("\n")) {
        const index = data.indexOf("\n");
        const line = data.slice(0, index).trim();
        data = data.slice(index + 1);
        if (!line) continue;
        try {
          messages.push(JSON.parse(line));
        } catch (error) {
          messages.push({ parseError: error.message, line });
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(messages);
    });
  });
}

async function main() {
  const promptSmoke = process.argv.includes("--prompt-smoke");
  const dispatchOnly = process.argv.includes("--dispatch");
  const keep = process.argv.includes("--keep");
  const paths = deriveDaemonPaths();
  const report = {
    generatedAt: new Date().toISOString(),
    mode: promptSmoke ? "prompt" : "exec",
    paths,
    ensureDaemon: null,
    listBefore: null,
    dispatch: null,
    hasAfterDispatch: null,
    subscribe: null,
    listAfter: null,
    agentsJsonAfter: null,
    cleanup: null,
    verdict: "unknown",
  };

  report.ensureDaemon = await ensureDaemon(paths);
  if (report.ensureDaemon.error) {
    report.verdict = "daemon-unreachable";
    await fs.writeFile(defaultReportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  report.listBefore = redactControlResponse(
    await sendControlRequest(paths.controlSock, { proto: 1, op: "list" }),
  );

  if (dispatchOnly || promptSmoke) {
    const payload = buildDispatchPayload({
      mode: promptSmoke ? "prompt" : "exec",
      cwd: process.cwd(),
    });
    report.dispatchPayload = {
      ...payload,
      launch:
        payload.launch.mode === "prompt"
          ? { ...payload.launch, args: payload.launch.args.slice(0, -1).concat("[prompt redacted]") }
          : payload.launch,
      seed:
        payload.launch.mode === "prompt"
          ? { ...payload.seed, intent: "[prompt redacted]" }
          : payload.seed,
    };
    report.dispatch = await sendControlRequest(
      paths.controlSock,
      { proto: 1, op: "dispatch", d: payload, timeoutMs: 5000 },
      { timeoutMs: 7000 },
    );
    report.hasAfterDispatch = await sendControlRequest(paths.controlSock, {
      proto: 1,
      op: "has",
      short: payload.short,
    });
    report.subscribe = redactSubscribeMessages(
      await collectSubscribe(paths.controlSock, payload.short),
    );
    report.listAfter = redactControlResponse(
      await sendControlRequest(paths.controlSock, { proto: 1, op: "list" }),
    );
    report.agentsJsonAfter = run("claude", ["agents", "--json"]);

    const stillAlive = report.hasAfterDispatch?.alive === true;
    if (stillAlive && !keep) {
      report.cleanup = await sendControlRequest(paths.controlSock, {
        proto: 1,
        op: "kill",
        short: payload.short,
      });
    }

    report.verdict =
      report.dispatch?.ok === true && report.hasAfterDispatch?.present === true
        ? promptSmoke
          ? "prompt-dispatch-registered"
          : "exec-dispatch-registered"
        : "dispatch-not-registered";
  } else {
    report.verdict = report.listBefore?.ok === true ? "control-list-ok" : "control-list-failed";
  }

  await fs.writeFile(defaultReportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict.endsWith("failed") || report.verdict === "daemon-unreachable") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
