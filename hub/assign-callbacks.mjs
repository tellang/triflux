// hub/assign-callbacks.mjs — assign job 상태 변경용 Named Pipe/Unix socket 브로드캐스터

import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { IS_WINDOWS, pipePath } from "./platform.mjs";

export function getAssignCallbackPipePath(sessionId = process.pid) {
  return pipePath("triflux-assign-callback", sessionId);
}

function buildAssignCallbackEvent(event = {}, row = null) {
  const source = row || event || {};
  const updatedAtMs = Number(source.updated_at_ms);
  const createdAtMs = Number(source.created_at_ms);
  const timestampMs = Number.isFinite(updatedAtMs)
    ? updatedAtMs
    : Number.isFinite(createdAtMs)
      ? createdAtMs
      : Date.now();

  return {
    event: "assign_job_status",
    job_id: source.job_id || event.job_id || null,
    supervisor_agent: source.supervisor_agent || null,
    worker_agent: source.worker_agent || null,
    topic: source.topic || null,
    task: source.task || null,
    status: source.status || event.status || null,
    attempt: Number.isFinite(Number(source.attempt))
      ? Number(source.attempt)
      : null,
    retry_count: Number.isFinite(Number(source.retry_count))
      ? Number(source.retry_count)
      : null,
    max_retries: Number.isFinite(Number(source.max_retries))
      ? Number(source.max_retries)
      : null,
    priority: Number.isFinite(Number(source.priority))
      ? Number(source.priority)
      : null,
    ttl_ms: Number.isFinite(Number(source.ttl_ms))
      ? Number(source.ttl_ms)
      : null,
    timeout_ms: Number.isFinite(Number(source.timeout_ms))
      ? Number(source.timeout_ms)
      : null,
    deadline_ms: Number.isFinite(Number(source.deadline_ms))
      ? Number(source.deadline_ms)
      : null,
    trace_id: source.trace_id || null,
    correlation_id: source.correlation_id || null,
    last_message_id: source.last_message_id || null,
    result: Object.hasOwn(source, "result")
      ? source.result
      : Object.hasOwn(event, "result")
        ? event.result
        : null,
    error: Object.hasOwn(source, "error")
      ? source.error
      : Object.hasOwn(event, "error")
        ? event.error
        : null,
    created_at_ms: Number.isFinite(createdAtMs) ? createdAtMs : null,
    updated_at_ms: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    started_at_ms: Number.isFinite(Number(source.started_at_ms))
      ? Number(source.started_at_ms)
      : null,
    completed_at_ms: Number.isFinite(Number(source.completed_at_ms))
      ? Number(source.completed_at_ms)
      : null,
    last_retry_at_ms: Number.isFinite(Number(source.last_retry_at_ms))
      ? Number(source.last_retry_at_ms)
      : null,
    timestamp: new Date(timestampMs).toISOString(),
  };
}

export function createAssignCallbackServer({
  store = null,
  sessionId = process.pid,
} = {}) {
  const pipePath = getAssignCallbackPipePath(sessionId);
  const clients = new Set();
  let server = null;
  let detachStoreListener = null;

  function removeSocket(socket) {
    if (!socket) return;
    clients.delete(socket);
    try {
      socket.destroy();
    } catch {}
  }

  function broadcast(event) {
    const frame = `${JSON.stringify(event)}\n`;
    for (const socket of Array.from(clients)) {
      if (!socket.writable || socket.destroyed) {
        removeSocket(socket);
        continue;
      }
      try {
        socket.write(frame);
      } catch {
        removeSocket(socket);
      }
    }
  }

  return {
    path: pipePath,
    getStatus() {
      return {
        path: pipePath,
        clients: clients.size,
      };
    },
    async start() {
      if (server) return { path: pipePath };
      if (!IS_WINDOWS && existsSync(pipePath)) {
        try {
          unlinkSync(pipePath);
        } catch {}
      }

      server = net.createServer((socket) => {
        clients.add(socket);
        socket.setEncoding("utf8");
        socket.on("error", () => removeSocket(socket));
        socket.on("close", () => removeSocket(socket));
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipePath, () => {
          server?.off("error", reject);
          resolve();
        });
      });

      if (store?.onAssignStatusChange && !detachStoreListener) {
        detachStoreListener = store.onAssignStatusChange((event, row) => {
          broadcast(buildAssignCallbackEvent(event, row));
        });
      }

      return { path: pipePath };
    },
    async stop() {
      if (detachStoreListener) {
        try {
          detachStoreListener();
        } catch {}
        detachStoreListener = null;
      }
      if (!server) return;
      for (const socket of Array.from(clients)) {
        removeSocket(socket);
      }
      await new Promise((resolve) => server.close(resolve));
      server = null;
      if (!IS_WINDOWS && existsSync(pipePath)) {
        try {
          unlinkSync(pipePath);
        } catch {}
      }
    },
    broadcast,
  };
}
