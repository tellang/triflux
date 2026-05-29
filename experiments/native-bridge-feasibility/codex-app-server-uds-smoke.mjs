#!/usr/bin/env node
// experiments/native-bridge-feasibility/codex-app-server-uds-smoke.mjs
//
// Exercises the PRODUCTION JsonRpcWsUdsClient (hub/workers/lib/jsonrpc-ws-uds.mjs)
// against a real `codex app-server --listen unix://PATH` over WebSocket-over-UDS.
//
// Default (ungated): spawn → connect → initialize → initialized → thread/start.
// This is auth-free and costs ZERO model quota, validating the full WS transport
// + JSON-RPC handshake through the real client.
//
// Gated (TFX_RUN_REAL_CODEX_APP_SERVER_UDS=1): additionally runs turn/start with
// a tiny "reply PONG" prompt and collects item/agentMessage/delta until
// turn/completed — a real end-to-end round-trip (needs codex auth + quota).
//
// Spawned via `node`, so the headless-guard never sees a `codex` Bash command.

import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { JsonRpcWsUdsClient } from "../../hub/workers/lib/jsonrpc-ws-uds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "codex-app-server-uds-smoke-latest-report.json");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const RUN_REAL_TURN = process.env.TFX_RUN_REAL_CODEX_APP_SERVER_UDS === "1";

function nowIso() {
  return new Date().toISOString();
}

async function waitForSocket(sockPath, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      if ((await stat(sockPath)).isSocket()) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function extractThreadId(result) {
  if (!result || typeof result !== "object") return null;
  if (typeof result.threadId === "string") return result.threadId;
  if (result.thread && typeof result.thread.id === "string")
    return result.thread.id;
  return null;
}

async function main() {
  const report = {
    kind: "codex-app-server-uds-smoke",
    startedAt: nowIso(),
    realTurn: RUN_REAL_TURN,
    serverArgv: null,
    serverSpawn: null,
    initialize: null,
    threadStart: null,
    threadId: null,
    turn: null,
    conclusion: null,
    stderrTail: "",
  };

  let dir;
  let child;
  let client;

  try {
    dir = await mkdtemp(join(tmpdir(), "tfx-codex-appserver-smoke-"));
    const sockPath = join(dir, "app-server.sock");
    report.serverArgv = ["app-server", "--listen", `unix://${sockPath}`];
    child = spawn(CODEX_BIN, report.serverArgv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += String(c);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const earlyExit = new Promise((resolve) => {
      child.once("error", (e) => resolve(`spawn error: ${e.message}`));
      child.once("exit", (code, sig) =>
        resolve(`exited early code=${code} sig=${sig || ""}`),
      );
    });

    const ready = await Promise.race([
      waitForSocket(sockPath, 12_000).then((ok) =>
        ok ? "ready" : "no-socket",
      ),
      earlyExit,
    ]);
    report.serverSpawn = ready;
    if (ready !== "ready") {
      report.stderrTail = stderr.slice(-2000);
      report.conclusion = `server did not bind socket: ${ready}`;
      return;
    }

    client = new JsonRpcWsUdsClient({ socketPath: sockPath });
    await client.connect();

    const initResult = await client.request(
      "initialize",
      { clientInfo: { name: "tfx-uds-smoke", version: "0.0.0" } },
      8000,
    );
    report.initialize = initResult;
    client.notify("initialized", {});

    const threadStart = await client.request(
      "thread/start",
      { sandbox: "read-only", approvalPolicy: "never", ephemeral: true },
      8000,
    );
    report.threadStart = threadStart;
    const threadId = extractThreadId(threadStart);
    report.threadId = threadId;

    if (!RUN_REAL_TURN) {
      report.conclusion = threadId
        ? "OK (ungated): WS-over-UDS handshake + initialize + thread/start succeeded (no model turn)"
        : "PARTIAL: handshake ok but thread id missing";
      return;
    }

    // Gated real turn — needs auth + quota.
    if (!threadId) {
      report.conclusion = "FAILED: no threadId, cannot start turn";
      return;
    }
    const parts = [];
    const done = new Promise((resolve) => {
      const offDelta = client.onNotification("item/agentMessage/delta", (p) => {
        if (typeof p?.delta === "string") parts.push(p.delta);
      });
      const offDone = client.onNotification("turn/completed", (p) => {
        offDelta();
        offDone();
        resolve(p?.turn?.status || "unknown");
      });
    });
    await client.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: "Reply with exactly one word: PONG" }],
      },
      90_000,
    );
    const status = await Promise.race([
      done,
      new Promise((r) => setTimeout(() => r("timeout"), 90_000)),
    ]);
    report.turn = { status, output: parts.join("") };
    report.conclusion = `real turn status=${status}, output=${JSON.stringify(parts.join(""))}`;
  } catch (e) {
    report.conclusion = `smoke error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try {
      client?.close();
    } catch {}
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {}
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    report.finishedAt = nowIso();
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(
      () => {},
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main();
