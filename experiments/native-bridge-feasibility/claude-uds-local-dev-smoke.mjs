#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildDispatchPayload,
  deriveDaemonPaths,
  redactControlResponse,
  sendControlRequest,
} from "./claude-daemon-dispatch-poc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultReportPath = path.join(here, "uds-local-dev-latest-report.json");
const DEFAULT_TIMEOUT_MS = 90_000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseArgs(argv) {
  const flags = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    reportPath: defaultReportPath,
    marker: `TFX_UDS_LOCAL_DEV_${Date.now()}`,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    index += 1;

    if (key === "timeout") {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      flags.timeoutMs = Math.round(seconds * 1000);
    } else if (key === "marker") {
      flags.marker = value;
    } else if (key === "report") {
      flags.reportPath = value;
    } else {
      throw new Error(`Unknown flag --${key}`);
    }
  }

  return flags;
}

export function usage() {
  return [
    "Usage:",
    "  claude-uds-local-dev-smoke.mjs [--marker TEXT] [--timeout 90] [--report PATH]",
    "",
    "Dev-only Claude daemon UDS smoke:",
    "  - connects to ~/.claude daemon control.sock",
    "  - dispatches one short-lived prompt job over the Unix domain socket",
    "  - subscribes until the marker is observed",
    "  - kills the job for cleanup",
  ].join("\n");
}

export function summarizeJobs(response) {
  return redactControlResponse(response)?.jobs?.map((job) => ({
    short: job.short,
    pid: job.pid,
    sessionId: job.sessionId,
    state: job.state,
    tempo: job.tempo,
    cwd: job.cwd,
    name: job.name,
    agent: job.agent,
    source: job.source,
    outcome: job.outcome,
  }));
}

export function subscribeUntilMarker(sockPath, short, marker, { timeoutMs }) {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    let data = "";
    let streamBytes = 0;
    let messageCount = 0;
    let stateCount = 0;
    let markerSeen = false;
    let settled = null;
    let settledAt = null;
    let finished = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);

    function finish(extra = {}) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        short,
        marker,
        markerSeen,
        settled,
        settledAt,
        messageCount,
        stateCount,
        streamBytes,
        elapsedMs: Date.now() - startedAt,
        ...extra,
      });
    }

    function scanText(text) {
      streamBytes += Buffer.byteLength(text);
      if (text.includes(marker)) markerSeen = true;
    }

    function handleMessage(message) {
      messageCount += 1;
      if (message.type === "snapshot") {
        for (const line of message.streamTail || []) scanText(line);
      } else if (
        message.type === "stream" &&
        typeof message.line === "string"
      ) {
        scanText(message.line);
      } else if (message.type === "state") {
        stateCount += 1;
      } else if (message.type === "settled") {
        settled = message.outcome || "settled";
        settledAt = Date.now();
      }

      if (markerSeen) finish();
      else if (settled) finish();
    }

    socket.on("error", (error) => finish({ error: error.message }));
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ proto: 1, op: "subscribe", short, tail: 80 })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      while (data.includes("\n")) {
        const index = data.indexOf("\n");
        const line = data.slice(0, index).trim();
        data = data.slice(index + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch (_error) {
          messageCount += 1;
        }
      }
    });
    socket.on("close", () => finish({ closed: true }));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const paths = deriveDaemonPaths();
  const report = {
    generatedAt: new Date().toISOString(),
    kind: "claude-daemon-uds-local-dev-smoke",
    controlSock: paths.controlSock,
    marker: flags.marker,
    listBefore: null,
    dispatch: null,
    subscribe: null,
    hasAfterSubscribe: null,
    cleanup: null,
    hasAfterCleanup: null,
    listAfter: null,
    verdict: "unknown",
  };

  const prompt = `Reply with exactly ${flags.marker} and then stop.`;
  const payload = buildDispatchPayload({
    mode: "prompt",
    cwd: process.cwd(),
    prompt,
  });
  payload.seed.name = "tfx uds local dev marker smoke";
  payload.seed.intent = "[redacted local dev marker prompt]";

  try {
    report.listBefore = summarizeJobs(
      await sendControlRequest(paths.controlSock, { proto: 1, op: "list" }),
    );
    report.dispatch = await sendControlRequest(
      paths.controlSock,
      { proto: 1, op: "dispatch", d: payload, timeoutMs: 5000 },
      { timeoutMs: 7000 },
    );
    report.subscribe = await subscribeUntilMarker(
      paths.controlSock,
      payload.short,
      flags.marker,
      {
        timeoutMs: flags.timeoutMs,
      },
    );
    report.hasAfterSubscribe = await sendControlRequest(paths.controlSock, {
      proto: 1,
      op: "has",
      short: payload.short,
    });

    if (report.hasAfterSubscribe?.present || report.hasAfterSubscribe?.alive) {
      report.cleanup = await sendControlRequest(paths.controlSock, {
        proto: 1,
        op: "kill",
        short: payload.short,
      });
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      report.hasAfterCleanup = await sendControlRequest(paths.controlSock, {
        proto: 1,
        op: "has",
        short: payload.short,
      });
      if (!report.hasAfterCleanup?.present && !report.hasAfterCleanup?.alive)
        break;
      await sleep(250);
    }

    report.listAfter = summarizeJobs(
      await sendControlRequest(paths.controlSock, { proto: 1, op: "list" }),
    );
    report.verdict =
      report.dispatch?.ok === true && report.subscribe?.markerSeen === true
        ? "prompt-marker-seen"
        : report.dispatch?.ok === true
          ? "prompt-dispatched-no-marker"
          : "dispatch-failed";
  } catch (error) {
    report.verdict = "error";
    report.error = error.message;
  }

  await fs.writeFile(flags.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "prompt-marker-seen") process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
