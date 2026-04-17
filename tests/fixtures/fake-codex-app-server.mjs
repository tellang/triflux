#!/usr/bin/env node
// tests/fixtures/fake-codex-app-server.mjs — deterministic codex app-server stub
//
// Behaviour is driven by env vars so tests can spawn the same binary in multiple
// shapes without needing per-test files.
//
//   FAKE_MODE = "ok"               (default) — happy path, 3 delta chunks → "PONG"
//             = "bootstrap-timeout"           — never responds to initialize
//             = "bootstrap-error"              — writes JSON-RPC error for initialize
//             = "execution-failed"             — turn/completed with status="failed"
//             = "execution-interrupted"        — turn/completed with status="interrupted"
//             = "error-notification"           — emits error notification then turn/completed
//             = "unknown-methods"              — emits >=5 unknown notifications before completing
//             = "timeout"                      — starts turn but never completes
//   FAKE_DELTAS = "PO,NG"                      — comma-separated delta chunks (default "P,O,N,G")
//   FAKE_THREAD_ID = "test-thread-id"          — threadId echoed in responses (default same)
//
// Wire format is line-delimited JSON-RPC 2.0 on stdin/stdout.
import process from "node:process";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE || "ok";
const rawDeltas = process.env.FAKE_DELTAS || "P,O,N,G";
const deltas = rawDeltas.split(",");
const threadId = process.env.FAKE_THREAD_ID || "test-thread-id";

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function fakeThread() {
  return {
    id: threadId,
    forkedFromId: null,
    preview: "",
    ephemeral: true,
    modelProvider: "fake",
    createdAt: 0,
    updatedAt: 0,
    status: "running",
    path: null,
    cwd: process.cwd(),
    cliVersion: "fake-0.0.0",
    source: "app-server",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function fakeTurn(status = "completed") {
  return {
    id: "turn-1",
    items: [],
    status,
    error: status === "failed" ? { code: "fake-fail", message: "boom" } : null,
    startedAt: 0,
    completedAt: 0,
    durationMs: 100,
  };
}

async function flushAgentDeltas() {
  notify("thread/started", { thread: fakeThread() });
  notify("turn/started", { threadId, turnId: "turn-1" });
  for (const d of deltas) {
    notify("item/agentMessage/delta", {
      threadId,
      turnId: "turn-1",
      itemId: "item-1",
      delta: d,
    });
  }
}

async function handleThreadStart(id) {
  respond(id, {
    thread: fakeThread(),
    model: "gpt-fake",
    modelProvider: "fake",
    serviceTier: null,
    cwd: process.cwd(),
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { mode: "read-only" },
    reasoningEffort: null,
  });
}

async function handleTurnStart(id) {
  respond(id, { turnId: "turn-1" });

  if (mode === "timeout") {
    await flushAgentDeltas();
    // Never emit turn/completed
    return;
  }

  if (mode === "unknown-methods") {
    await flushAgentDeltas();
    for (let i = 0; i < 6; i += 1) {
      notify(`codex/experimental/${i}`, { threadId, payload: i });
    }
    notify("turn/completed", { threadId, turn: fakeTurn("completed") });
    return;
  }

  if (mode === "error-notification") {
    notify("error", { threadId, message: "synthetic error" });
    notify("turn/completed", { threadId, turn: fakeTurn("failed") });
    return;
  }

  if (mode === "execution-failed") {
    await flushAgentDeltas();
    notify("turn/completed", { threadId, turn: fakeTurn("failed") });
    return;
  }

  if (mode === "execution-interrupted") {
    await flushAgentDeltas();
    notify("turn/completed", { threadId, turn: fakeTurn("interrupted") });
    return;
  }

  // ok
  await flushAgentDeltas();
  notify("turn/completed", { threadId, turn: fakeTurn("completed") });
}

async function handleInitialize(id) {
  if (mode === "bootstrap-timeout") return;
  if (mode === "bootstrap-error") {
    respondError(id, -32000, "fake bootstrap failure");
    return;
  }
  respond(id, {
    userAgent: "fake-codex-app-server/0.0.0",
    codexHome: "/tmp/fake-codex-home",
    platformFamily: "unix",
    platformOs: "linux",
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.method === "initialize") {
    await handleInitialize(msg.id);
  } else if (msg.method === "initialized") {
    // no-op
  } else if (msg.method === "thread/start") {
    await handleThreadStart(msg.id);
  } else if (msg.method === "turn/start") {
    await handleTurnStart(msg.id);
  } else if (msg.method === "thread/unsubscribe") {
    if (typeof msg.id !== "undefined") respond(msg.id, {});
  }
});

rl.on("close", () => {
  process.exit(0);
});
