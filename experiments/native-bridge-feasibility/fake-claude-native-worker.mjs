import fs from "node:fs/promises";
import net from "node:net";

import {
  buildPtyControlFrame,
  buildPtyDataFrame,
  extractPtyFrames,
} from "./claude-native-worker-protocol.mjs";

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

export async function startFakeNativeWorker({
  rvSock,
  ptySock,
  pid = process.pid,
  version = "2.1.145",
} = {}) {
  if (!rvSock) throw new Error("rvSock is required");
  if (!ptySock) throw new Error("ptySock is required");

  await fs.rm(rvSock, { force: true }).catch(() => {});
  await fs.rm(ptySock, { force: true }).catch(() => {});

  const sockets = new Set();
  const events = [];
  const rvServer = net.createServer((socket) => {
    sockets.add(socket);
    events.push({ type: "rv-connect" });
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let tick = 0;
    const sendState = () => {
      tick += 1;
      socket.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
      socket.write(
        `${JSON.stringify({ type: "state", patch: { state: "running", tempo: "idle", detail: `tick:${tick}` } })}\n`,
      );
    };
    socket.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
    socket.write(`${JSON.stringify({ type: "state", patch: { state: "running", tempo: "idle" } })}\n`);
    const stateTimer = setInterval(sendState, 300);
    socket.once("close", () => clearInterval(stateTimer));
    socket.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        events.push({ type: "rv-message", message });
        if (message.type === "shutdown") {
          socket.write(`${JSON.stringify({ type: "shutting-down" })}\n`);
          socket.end();
        } else if (message.type === "repaint") {
          socket.write(`${JSON.stringify({ type: "repaint-done" })}\n`);
        } else if (message.type === "reply") {
          socket.write(
            `${JSON.stringify({ type: "state", patch: { detail: `reply:${message.text}`, tempo: "idle" } })}\n`,
          );
        }
      }
    });
  });

  const ptyServer = net.createServer((socket) => {
    sockets.add(socket);
    events.push({ type: "pty-connect" });
    socket.once("close", () => sockets.delete(socket));
    socket.write(buildPtyControlFrame({ t: "hello", replPid: pid, version }));
    socket.write(buildPtyDataFrame("tfx fake native worker online\r\n"));
    socket.write(buildPtyControlFrame({ t: "live" }));
    const outputTimer = setInterval(() => {
      socket.write(buildPtyDataFrame("tfx fake native worker heartbeat\r\n"));
    }, 300);
    socket.once("close", () => clearInterval(outputTimer));
    let ptyBuffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        const result = extractPtyFrames(Buffer.concat([ptyBuffer, chunk]));
        ptyBuffer = result.rest;
        for (const frame of result.frames) {
          events.push({ type: "pty-frame", frame: frame.kind === 1 ? frame.ctrl : { kind: 0, bytes: frame.payload.length } });
          if (frame.kind === 0) {
            socket.write(buildPtyDataFrame(frame.payload));
          } else if (frame.kind === 1 && frame.ctrl.t === "kill") {
            socket.write(buildPtyControlFrame({ t: "exit", code: 0, signal: frame.ctrl.sig }));
            socket.end();
          } else if (frame.kind === 1 && frame.ctrl.t === "resize") {
            socket.write(buildPtyControlFrame({ t: "live" }));
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
    for (const socket of sockets) socket.destroy();
    await Promise.all([closeServer(rvServer), closeServer(ptyServer)]);
    await fs.rm(rvSock, { force: true }).catch(() => {});
    await fs.rm(ptySock, { force: true }).catch(() => {});
    throw error;
  }

  return {
    rvSock,
    ptySock,
    getEvents() {
      return events.slice();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([closeServer(rvServer), closeServer(ptyServer)]);
      await fs.rm(rvSock, { force: true }).catch(() => {});
      await fs.rm(ptySock, { force: true }).catch(() => {});
    },
  };
}
