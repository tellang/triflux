#!/usr/bin/env node
// tests/fixtures/fake-codex-app-server-ws-uds.mjs
//
// Deterministic codex app-server stub that speaks the SAME JSON-RPC protocol as
// fake-codex-app-server.mjs, but over WebSocket-over-Unix-Domain-Socket — the
// real transport of `codex app-server --listen unix://PATH`. Lets CI exercise
// JsonRpcWsUdsClient + createCodexAppServerUdsEndpoint without the real codex
// binary, with zero model quota.
//
//   argv[2] (or $FAKE_WS_UDS_SOCK) = absolute unix socket path to bind.
//   FAKE_MODE   = "ok" (default) | "execution-failed" | "execution-interrupted"
//   FAKE_DELTAS = comma-separated delta chunks (default "P,O,N,G")
//   FAKE_THREAD_ID = thread id echoed (default "fake-thread-ws")

import { createHash } from "node:crypto";
import net from "node:net";
import process from "node:process";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sockPath = process.argv[2] || process.env.FAKE_WS_UDS_SOCK;
const mode = process.env.FAKE_MODE || "ok";
const deltas = (process.env.FAKE_DELTAS || "P,O,N,G").split(",");
const threadId = process.env.FAKE_THREAD_ID || "fake-thread-ws";
const loadedThreads = JSON.parse(
  process.env.FAKE_LOADED_THREADS || `["${threadId}"]`,
);
const initialActiveReads = Number(process.env.FAKE_ACTIVE_READS || 0);
const statusByThread = new Map(
  loadedThreads.map((id) => [
    id,
    {
      activeReads: initialActiveReads,
      active: initialActiveReads > 0,
      currentTurnId: initialActiveReads > 0 ? "active-turn-ws-1" : null,
    },
  ]),
);

if (!sockPath) {
  process.stderr.write("fake-codex-app-server-ws-uds: missing socket path\n");
  process.exit(2);
}

// Server -> client frames are unmasked. `fin` controls the FIN bit so the fake
// can split a message into text + continuation frames (FAKE_FRAGMENT=1).
function encodeServerFrame(opcode, payload, fin = true) {
  const len = payload.length;
  const b0 = (fin ? 0x80 : 0) | opcode;
  let header;
  if (len < 126) {
    header = Buffer.from([b0, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = b0;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = b0;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

const FRAGMENT = process.env.FAKE_FRAGMENT === "1";
const connections = new Set();

const server = net.createServer((socket) => {
  let upgraded = false;
  let buf = Buffer.alloc(0);
  const subscribed = new Set();

  const sendJson = (obj) => {
    const full = Buffer.from(JSON.stringify(obj), "utf8");
    if (FRAGMENT && full.length >= 4) {
      // Split into a non-final text frame + a final continuation frame to
      // exercise the client's fragment reassembly.
      const mid = Math.floor(full.length / 2);
      socket.write(encodeServerFrame(0x1, full.subarray(0, mid), false));
      socket.write(encodeServerFrame(0x0, full.subarray(mid), true));
    } else {
      socket.write(encodeServerFrame(0x1, full));
    }
  };
  const respond = (id, result) => sendJson({ id, result });
  const notify = (method, params) => sendJson({ method, params });
  const connection = { subscribed, notify };
  connections.add(connection);
  const notifyThread = (id, method, params) => {
    for (const peer of connections) {
      if (peer.subscribed.has(id)) peer.notify(method, params);
    }
  };

  const fakeThread = (id = threadId) => ({
    id,
    sessionId: id,
    ephemeral: true,
    modelProvider: "fake",
    status: { type: statusByThread.get(id)?.active ? "active" : "idle" },
    cwd: process.env.FAKE_CWD || process.cwd(),
    name: `fake ${id}`,
    source: "cli",
    turns:
      mode === "active-turns-visible" && statusByThread.get(id)?.active
        ? [fakeTurn("inProgress", statusByThread.get(id).currentTurnId)]
        : [],
  });
  const fakeTurn = (status, id = "turn-ws-1") => ({
    id,
    items: [],
    status,
    error: status === "failed" ? { message: "boom" } : null,
  });

  const handleMessage = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.method === "initialize") {
      respond(msg.id, {
        userAgent: "fake-ws-uds/0.0.0",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      });
    } else if (msg.method === "initialized") {
      /* no-op */
    } else if (msg.method === "thread/start") {
      subscribed.add(threadId);
      respond(msg.id, {
        thread: fakeThread(),
        model: "gpt-fake",
        approvalPolicy: "never",
      });
    } else if (msg.method === "thread/loaded/list") {
      respond(msg.id, { data: loadedThreads, nextCursor: null });
    } else if (msg.method === "thread/read") {
      if (msg.params?.includeTurns) {
        sendJson({
          id: msg.id,
          error: { code: -32601, message: "list_turns is not supported yet" },
        });
      } else {
        const id = msg.params?.threadId;
        const state = statusByThread.get(id);
        if (!state)
          sendJson({
            id: msg.id,
            error: { code: -32602, message: "thread not found" },
          });
        else {
          const thread = fakeThread(id);
          respond(msg.id, { thread });
          if (state.activeReads > 0 && --state.activeReads === 0)
            state.active = false;
        }
      }
    } else if (msg.method === "thread/resume") {
      if (mode === "resume-failed") {
        sendJson({
          id: msg.id,
          error: { code: -32602, message: "resume failed" },
        });
      } else if (msg.params?.excludeTurns !== true) {
        sendJson({
          id: msg.id,
          error: { code: -32602, message: "excludeTurns required" },
        });
      } else {
        subscribed.add(msg.params.threadId);
        respond(msg.id, { thread: fakeThread(msg.params.threadId) });
      }
    } else if (msg.method === "turn/start" || msg.method === "turn/steer") {
      const requestedThreadId = msg.params?.threadId || threadId;
      const state = statusByThread.get(requestedThreadId) || {
        active: false,
        activeReads: 0,
        currentTurnId: null,
      };
      const wasActive = state.active;
      if (
        mode === "active-turns-visible" &&
        wasActive &&
        msg.method === "turn/start"
      ) {
        sendJson({
          id: msg.id,
          error: { code: -32602, message: "use turn/steer" },
        });
        return;
      }
      if (
        msg.method === "turn/steer" &&
        msg.params?.expectedTurnId !== state.currentTurnId
      ) {
        sendJson({
          id: msg.id,
          error: { code: -32602, message: "wrong expectedTurnId" },
        });
        return;
      }
      const turnId = wasActive ? state.currentTurnId : "turn-ws-1";
      state.active = true;
      state.currentTurnId = turnId;
      statusByThread.set(requestedThreadId, state);
      respond(
        msg.id,
        msg.method === "turn/steer"
          ? { turnId }
          : { turn: fakeTurn("inProgress", turnId) },
      );
      if (!subscribed.has(requestedThreadId)) {
        notify("thread/status/changed", {
          threadId: requestedThreadId,
          status: { type: "active" },
        });
      }
      notifyThread(requestedThreadId, "thread/started", {
        thread: fakeThread(requestedThreadId),
      });
      if (!wasActive)
        notifyThread(requestedThreadId, "turn/started", {
          threadId: requestedThreadId,
          turn: fakeTurn("inProgress", turnId),
        });
      if (mode === "mixed-ids") {
        notifyThread(requestedThreadId, "item/agentMessage/delta", {
          threadId: requestedThreadId,
          turnId: "other-turn",
          delta: "WRONG",
        });
        notifyThread(requestedThreadId, "turn/completed", {
          threadId: requestedThreadId,
          turn: fakeTurn("completed", "other-turn"),
        });
      }
      if (mode === "missing-completion-id") {
        notifyThread(requestedThreadId, "turn/completed", {
          threadId: requestedThreadId,
          turn: { status: "failed" },
        });
      }
      if (mode === "partial-completed") {
        notifyThread(requestedThreadId, "item/agentMessage/delta", {
          threadId: requestedThreadId,
          turnId,
          itemId: "item-1",
          delta: "PO",
        });
        notifyThread(requestedThreadId, "item/completed", {
          threadId: requestedThreadId,
          turnId,
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "PONG",
            phase: "final_answer",
          },
        });
      } else if (
        mode === "multi-message" ||
        mode === "multi-message-no-final"
      ) {
        const messages =
          mode === "multi-message"
            ? [
                ["comment-1", "working", "commentary"],
                ["final-1", "FINAL ONE", "final_answer"],
                ["final-2", "FINAL TWO", "final_answer"],
              ]
            : [
                ["first", "first message", "commentary"],
                ["last", "last message", "commentary"],
              ];
        for (const [itemId, text, phase] of messages) {
          for (const delta of [text.slice(0, 3), text.slice(3)])
            notifyThread(requestedThreadId, "item/agentMessage/delta", {
              threadId: requestedThreadId,
              turnId,
              itemId,
              delta,
            });
          notifyThread(requestedThreadId, "item/completed", {
            threadId: requestedThreadId,
            turnId,
            item: { id: itemId, type: "agentMessage", text, phase },
          });
        }
      } else {
        for (const d of deltas) {
          notifyThread(requestedThreadId, "item/agentMessage/delta", {
            threadId: requestedThreadId,
            turnId,
            itemId: "item-1",
            delta: d,
          });
        }
      }
      if (mode === "timeout") return;
      if (mode === "error-notification") {
        notifyThread(requestedThreadId, "error", {
          threadId: requestedThreadId,
          turnId,
          error: { message: "fake turn error" },
          willRetry: false,
        });
        return;
      }
      if (mode === "retry-notification")
        notifyThread(requestedThreadId, "error", {
          threadId: requestedThreadId,
          turnId,
          error: { message: "transient error" },
          willRetry: true,
        });
      state.active = false;
      if (mode === "tool-activity") {
        for (const delay of [50, 140, 230]) {
          setTimeout(
            () =>
              notifyThread(requestedThreadId, "item/started", {
                threadId: requestedThreadId,
                turnId,
                item: { id: `tool-${delay}`, type: "commandExecution" },
              }),
            delay,
          );
        }
        setTimeout(
          () =>
            notifyThread(requestedThreadId, "turn/completed", {
              threadId: requestedThreadId,
              turn: fakeTurn("completed", turnId),
            }),
          300,
        );
        return;
      }
      if (mode === "execution-failed") {
        notifyThread(requestedThreadId, "turn/completed", {
          threadId: requestedThreadId,
          turn: fakeTurn("failed", turnId),
        });
      } else if (mode === "execution-interrupted") {
        notifyThread(requestedThreadId, "turn/completed", {
          threadId: requestedThreadId,
          turn: fakeTurn("interrupted", turnId),
        });
      } else {
        notifyThread(requestedThreadId, "turn/completed", {
          threadId: requestedThreadId,
          turn: fakeTurn("completed", turnId),
        });
      }
    } else if (msg.method === "thread/unsubscribe") {
      if (typeof msg.id !== "undefined") respond(msg.id, {});
    }
  };

  const drainFrames = () => {
    while (buf.length >= 2) {
      const b1 = buf[1];
      const masked = (b1 & 0x80) !== 0;
      // Client -> server frames MUST be masked (RFC 6455 §5.1). Reject otherwise
      // so this fake actively verifies the client masks correctly.
      if (!masked) {
        socket.destroy();
        return;
      }
      let len = b1 & 0x7f;
      let cursor = 2;
      if (len === 126) {
        if (buf.length < cursor + 2) return;
        len = buf.readUInt16BE(cursor);
        cursor += 2;
      } else if (len === 127) {
        if (buf.length < cursor + 8) return;
        len = Number(buf.readBigUInt64BE(cursor));
        cursor += 8;
      }
      if (buf.length < cursor + 4 + len) return;
      const maskKey = buf.subarray(cursor, cursor + 4);
      cursor += 4;
      const opcode = buf[0] & 0x0f;
      const maskedPayload = buf.subarray(cursor, cursor + len);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++)
        payload[i] = maskedPayload[i] ^ maskKey[i % 4];
      buf = Buffer.from(buf.subarray(cursor + len));
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeServerFrame(0xa, payload)); // ping -> pong
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0)
        handleMessage(payload.toString("utf8"));
    }
  };

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const headers = buf.subarray(0, sep).toString("utf8");
      const keyMatch = headers.match(/sec-websocket-key:\s*(.+)\r?\n/i);
      if (!keyMatch) {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(keyMatch[1].trim() + WS_GUID)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      upgraded = true;
      buf = Buffer.from(buf.subarray(sep + 4));
    }
    drainFrames();
  });
  socket.on("error", () => {});
  socket.on("close", () => connections.delete(connection));
});

server.on("error", (err) => {
  process.stderr.write(`fake-codex-app-server-ws-uds error: ${err.message}\n`);
  process.exit(1);
});

server.listen(sockPath, () => {
  process.stdout.write(`listening ${sockPath}\n`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try {
      server.close();
    } catch {}
    process.exit(0);
  });
}
