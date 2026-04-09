// tests/integration/pipe.test.mjs — Named Pipe 실시간 push 통합 테스트

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startHub } from "../../hub/server.mjs";

function tempDbPath() {
  const dir = join(tmpdir(), `tfx-hub-pipe-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

async function createPipeClient(pipePath) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = "";
    const pending = new Map();
    const events = [];
    const waiters = [];

    function emitEvent(frame) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        events.push(frame);
      }
    }

    function flush(line) {
      if (!line) return;
      const frame = JSON.parse(line);
      if (frame.type === "response" && pending.has(frame.request_id)) {
        const resolvePending = pending.get(frame.request_id);
        pending.delete(frame.request_id);
        resolvePending(frame);
        return;
      }
      emitEvent(frame);
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          flush(line);
          newlineIndex = buffer.indexOf("\n");
        }
      });

      resolve({
        async request(type, payload, timeoutMs = 3000) {
          const requestId = randomUUID();
          return await new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
              pending.delete(requestId);
              rejectRequest(
                new Error(`pipe request timeout: ${payload.action || type}`),
              );
            }, timeoutMs);

            pending.set(requestId, (frame) => {
              clearTimeout(timer);
              resolveRequest(frame);
            });

            socket.write(
              `${JSON.stringify({ type, request_id: requestId, payload })}\n`,
            );
          });
        },
        async nextEvent(timeoutMs = 3000) {
          if (events.length) return events.shift();
          return await new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(
              () => rejectEvent(new Error("pipe event timeout")),
              timeoutMs,
            );
            waiters.push((frame) => {
              clearTimeout(timer);
              resolveEvent(frame);
            });
          });
        },
        close() {
          socket.end();
        },
      });
    });
    socket.once("error", reject);
  });
}

async function createAssignCallbackClient(pipePath) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = "";
    const events = [];
    const waiters = [];

    function emitEvent(frame) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        events.push(frame);
      }
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) emitEvent(JSON.parse(line));
          newlineIndex = buffer.indexOf("\n");
        }
      });

      resolve({
        async nextEvent(timeoutMs = 3000) {
          if (events.length) return events.shift();
          return await new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(
              () => rejectEvent(new Error("assign callback timeout")),
              timeoutMs,
            );
            waiters.push((frame) => {
              clearTimeout(timer);
              resolveEvent(frame);
            });
          });
        },
        close() {
          socket.end();
        },
      });
    });
    socket.once("error", reject);
  });
}

const TEST_PORT = 28100 + Math.floor(Math.random() * 100);

describe("Named Pipe 실시간 채널", () => {
  let hub;
  let dbPath;

  before(async () => {
    dbPath = tempDbPath();
    hub = await startHub({ port: TEST_PORT, dbPath, host: "127.0.0.1" });
  });

  after(async () => {
    if (hub?.stop) await hub.stop();
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {}
  });

  it("구독된 에이전트는 publish 후 메시지를 실시간 push로 받아야 한다", async () => {
    const subscriber = await createPipeClient(hub.pipePath);
    const publisher = await createPipeClient(hub.pipePath);

    const register = await subscriber.request("command", {
      action: "register",
      agent_id: "pipe-subscriber",
      cli: "codex",
      capabilities: ["code"],
      topics: ["task.result"],
      heartbeat_ttl_ms: 60000,
    });
    assert.equal(register.ok, true);

    const eventPromise = subscriber.nextEvent();
    const published = await publisher.request("command", {
      action: "publish",
      from: "pipe-publisher",
      to: "topic:task.result",
      topic: "task.result",
      payload: { summary: "done" },
    });
    assert.equal(published.ok, true);

    const pushed = await eventPromise;
    assert.equal(pushed.type, "event");
    assert.equal(pushed.event, "message");
    assert.equal(pushed.payload.message.topic, "task.result");
    assert.deepEqual(pushed.payload.message.payload, { summary: "done" });

    const acked = await subscriber.request("command", {
      action: "ack",
      agent_id: "pipe-subscriber",
      message_ids: [pushed.payload.message.id],
    });
    assert.equal(acked.ok, true);
    assert.equal(acked.data.acked_count, 1);

    subscriber.close();
    publisher.close();
  });

  it("query drain은 연결 시점 이전에 쌓인 메시지를 반환해야 한다", async () => {
    hub.router.registerAgent({
      agent_id: "pipe-drain-agent",
      cli: "claude",
      capabilities: ["x"],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });
    hub.router.handlePublish({
      from: "lead",
      to: "pipe-drain-agent",
      topic: "lead.control",
      payload: { command: "pause" },
    });

    const client = await createPipeClient(hub.pipePath);
    const drained = await client.request("query", {
      action: "drain",
      agent_id: "pipe-drain-agent",
      max_messages: 5,
      auto_ack: true,
    });

    assert.equal(drained.ok, true);
    assert.equal(drained.data.count, 1);
    assert.equal(drained.data.messages[0].topic, "lead.control");
    assert.deepEqual(drained.data.messages[0].payload, { command: "pause" });

    client.close();
  });

  it("assign/assign_result/assign_status 명령은 pipe 경로로 동작해야 한다", async () => {
    const lead = await createPipeClient(hub.pipePath);
    const worker = await createPipeClient(hub.pipePath);

    await lead.request("command", {
      action: "register",
      agent_id: "pipe-assign-lead",
      cli: "claude",
      capabilities: ["plan"],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });
    await worker.request("command", {
      action: "register",
      agent_id: "pipe-assign-worker",
      cli: "codex",
      capabilities: ["code"],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });

    const nextWorkerEvent = worker.nextEvent();
    const assigned = await lead.request("command", {
      action: "assign",
      supervisor_agent: "pipe-assign-lead",
      worker_agent: "pipe-assign-worker",
      task: "assign via pipe",
      max_retries: 1,
    });

    assert.equal(assigned.ok, true);
    assert.equal(assigned.data.status, "queued");

    const jobEvent = await nextWorkerEvent;
    assert.equal(
      jobEvent.payload.message.payload.assign_job_id,
      assigned.data.job_id,
    );

    const progressed = await worker.request("command", {
      action: "assign_result",
      job_id: assigned.data.job_id,
      worker_agent: "pipe-assign-worker",
      status: "running",
      attempt: 1,
    });
    assert.equal(progressed.ok, true);
    assert.equal(progressed.data.status, "running");

    const completed = await worker.request("command", {
      action: "assign_result",
      job_id: assigned.data.job_id,
      worker_agent: "pipe-assign-worker",
      status: "completed",
      attempt: 1,
      metadata: { result: "success" },
      result: { output: "done" },
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.data.status, "succeeded");

    const queried = await lead.request("query", {
      action: "assign_status",
      job_id: assigned.data.job_id,
    });
    assert.equal(queried.ok, true);
    assert.equal(queried.data.status, "succeeded");

    lead.close();
    worker.close();
  });

  it("assign_jobs 상태 변경은 assign callback pipe로 실시간 JSON 이벤트를 보내야 한다", async () => {
    const callbacks = await createAssignCallbackClient(
      hub.assignCallbackPipePath,
    );
    const lead = await createPipeClient(hub.pipePath);
    const worker = await createPipeClient(hub.pipePath);

    await lead.request("command", {
      action: "register",
      agent_id: "pipe-callback-lead",
      cli: "claude",
      capabilities: ["plan"],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });
    await worker.request("command", {
      action: "register",
      agent_id: "pipe-callback-worker",
      cli: "codex",
      capabilities: ["code"],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });

    const queuedEventPromise = callbacks.nextEvent();
    const assigned = await lead.request("command", {
      action: "assign",
      supervisor_agent: "pipe-callback-lead",
      worker_agent: "pipe-callback-worker",
      task: "assign callback via pipe",
    });

    const queuedEvent = await queuedEventPromise;
    assert.equal(queuedEvent.job_id, assigned.data.job_id);
    assert.equal(queuedEvent.event, "assign_job_status");
    assert.equal(queuedEvent.status, "queued");
    assert.equal(queuedEvent.supervisor_agent, "pipe-callback-lead");
    assert.equal(queuedEvent.worker_agent, "pipe-callback-worker");
    assert.equal(queuedEvent.task, "assign callback via pipe");
    assert.equal(typeof queuedEvent.timestamp, "string");

    const runningEventPromise = callbacks.nextEvent();
    await worker.request("command", {
      action: "assign_result",
      job_id: assigned.data.job_id,
      worker_agent: "pipe-callback-worker",
      status: "running",
      attempt: 1,
      result: { step: "started" },
    });

    const runningEvent = await runningEventPromise;
    assert.equal(runningEvent.job_id, assigned.data.job_id);
    assert.equal(runningEvent.status, "running");
    assert.equal(runningEvent.event, "assign_job_status");
    assert.deepEqual(runningEvent.result, { step: "started" });

    const doneEventPromise = callbacks.nextEvent();
    await worker.request("command", {
      action: "assign_result",
      job_id: assigned.data.job_id,
      worker_agent: "pipe-callback-worker",
      status: "completed",
      attempt: 1,
      result: { output: "done" },
    });

    const doneEvent = await doneEventPromise;
    assert.equal(doneEvent.job_id, assigned.data.job_id);
    assert.equal(doneEvent.status, "succeeded");
    assert.equal(doneEvent.event, "assign_job_status");
    assert.equal(doneEvent.completed_at_ms !== null, true);
    assert.deepEqual(doneEvent.result, { output: "done" });

    callbacks.close();
    lead.close();
    worker.close();
  });
});
