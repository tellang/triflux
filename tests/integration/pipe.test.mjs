// tests/integration/pipe.test.mjs — Named Pipe 실시간 push 통합 테스트

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startHub } from "../../hub/server.mjs";
import { createMemoryStore } from "../../packages/core/hub/lib/memory-store.mjs";
import { createRouter as createCoreRouter } from "../../packages/core/hub/router.mjs";
import { createPipeServer as createRemotePipeServer } from "../../packages/remote/hub/pipe.mjs";

function tempDbPath() {
  const dir = join(tmpdir(), `tfx-hub-pipe-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function setTempHubStateDir() {
  const previous = process.env.TFX_HUB_STATE_DIR;
  const stateDir = join(tmpdir(), `tfx-hub-pipe-state-${randomUUID()}`);
  mkdirSync(stateDir, { recursive: true });
  process.env.TFX_HUB_STATE_DIR = stateDir;
  return () => {
    if (previous == null) delete process.env.TFX_HUB_STATE_DIR;
    else process.env.TFX_HUB_STATE_DIR = previous;
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  };
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
  let restoreHubStateDir;

  before(async () => {
    restoreHubStateDir = setTempHubStateDir();
    dbPath = tempDbPath();
    hub = await startHub({ port: TEST_PORT, dbPath, host: "127.0.0.1" });
  });

  after(async () => {
    if (hub?.stop) await hub.stop();
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {}
    restoreHubStateDir?.();
  });

  it("register presence 실패는 pipe transport가 ok:true로 감싸지 않아야 한다", async () => {
    const pipe = createRemotePipeServer({
      sessionId: `remote-register-failure-${randomUUID()}`,
      router: {
        registerAgent() {
          return {
            ok: false,
            error: {
              code: "REGISTER_PRESENCE_NOT_UPDATED",
              message: "stuck-agent register did not update effective presence",
            },
            data: {
              agent_id: "stuck-agent",
              lease_expires_ms: Date.now() + 60000,
              effective: { online: false, status: "offline" },
            },
          };
        },
      },
    });

    const result = await pipe.executeCommand("register", {
      agent_id: "stuck-agent",
      cli: "claude",
      capabilities: ["cto"],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "REGISTER_PRESENCE_NOT_UPDATED");
    assert.equal(result.data.effective.status, "offline");
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

  it("takeover_role command는 CTO leader를 바꾸고 미처리 CTO 메시지를 새 leader에게 push해야 한다", async () => {
    const oldLeader = await createPipeClient(hub.pipePath);
    const newLeader = await createPipeClient(hub.pipePath);
    const lead = await createPipeClient(hub.pipePath);

    await oldLeader.request("command", {
      action: "register",
      agent_id: "pipe-cto-old",
      cli: "claude",
      capabilities: ["code"],
      topics: [],
      metadata: { role: "cto", cto_priority: 10 },
      heartbeat_ttl_ms: 60000,
    });
    await newLeader.request("command", {
      action: "register",
      agent_id: "pipe-cto-new",
      cli: "codex",
      capabilities: ["cto"],
      topics: [],
      metadata: { role: "cto", cto_priority: 1 },
      heartbeat_ttl_ms: 60000,
    });

    const oldEventPromise = oldLeader.nextEvent();
    const published = await lead.request("command", {
      action: "publish",
      from: "pipe-lead",
      to: "topic:cto",
      topic: "cto",
      payload: { decision: "pipe takeover" },
    });
    assert.equal(published.ok, true);
    assert.equal(published.data.fanout_count, 1);
    assert.equal((await oldEventPromise).payload.message.topic, "cto");

    const newEventPromise = newLeader.nextEvent();
    const takeover = await lead.request("command", {
      action: "takeover_role",
      role: "cto",
      agent_id: "pipe-cto-new",
      reason: "pipe_test",
      requested_by: "test",
    });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.data.leader_agent_id, "pipe-cto-new");
    assert.equal(takeover.data.transferred_count, 1);

    const transferred = await newEventPromise;
    assert.equal(transferred.payload.message.topic, "cto");
    assert.deepEqual(transferred.payload.message.payload, {
      decision: "pipe takeover",
    });

    const status = await lead.request("query", {
      action: "status",
      scope: "hub",
    });
    assert.equal(status.ok, true);
    assert.equal(status.data.roles.cto.leader_agent_id, "pipe-cto-new");

    oldLeader.close();
    newLeader.close();
    lead.close();
  });

  it("context replay는 topic:cto 감사 로그를 elected leader에게만 보여줘야 한다", async () => {
    hub.router.registerAgent({
      agent_id: "pipe-cto-audit-leader",
      cli: "codex",
      capabilities: ["cto"],
      topics: [],
      metadata: { role: "cto" },
      heartbeat_ttl_ms: 60000,
    });
    hub.router.registerAgent({
      agent_id: "pipe-cto-audit-standby",
      cli: "claude",
      capabilities: ["code"],
      topics: ["cto"],
      heartbeat_ttl_ms: 60000,
    });
    const takeover = hub.router.takeoverRole({
      role: "cto",
      agent_id: "pipe-cto-audit-leader",
      reason: "audit_replay_test",
      requested_by: "test",
    });
    assert.equal(takeover.ok, true);

    const published = hub.router.handlePublish({
      from: "lead",
      to: "topic:cto",
      topic: "cto",
      payload: { decision: "audit replay must not fan out" },
    });
    assert.equal(published.ok, true);
    assert.equal(published.data.fanout_count, 1);

    const client = await createPipeClient(hub.pipePath);
    const standbyContext = await client.request("query", {
      action: "context",
      agent_id: "pipe-cto-audit-standby",
      max_messages: 20,
    });
    assert.equal(standbyContext.ok, true);
    assert.deepEqual(standbyContext.data.messages, []);

    const leaderContext = await client.request("query", {
      action: "context",
      agent_id: "pipe-cto-audit-leader",
      max_messages: 20,
    });
    assert.equal(leaderContext.ok, true);
    assert.equal(
      leaderContext.data.messages.some(
        (message) =>
          message.topic === "cto" &&
          message.payload?.decision === "audit replay must not fan out",
      ),
      true,
    );

    client.close();
  });

  it("context replay는 topic 구독 없는 explicit CTO leader에게도 감사 로그를 보여줘야 한다", async () => {
    hub.router.registerAgent({
      agent_id: "pipe-cto-explicit-audit-leader",
      cli: "codex",
      capabilities: ["cto"],
      topics: [],
      metadata: { role: "cto", cto_priority: 99 },
      heartbeat_ttl_ms: 60000,
    });
    hub.router.registerAgent({
      agent_id: "pipe-cto-explicit-audit-standby",
      cli: "claude",
      capabilities: ["code"],
      topics: ["cto"],
      heartbeat_ttl_ms: 60000,
    });
    const takeover = hub.router.takeoverRole({
      role: "cto",
      agent_id: "pipe-cto-explicit-audit-leader",
      reason: "explicit_audit_replay_test",
      requested_by: "test",
    });
    assert.equal(takeover.ok, true);

    const payload = {
      decision: `explicit audit replay ${randomUUID()}`,
    };
    const published = hub.router.handlePublish({
      from: "lead",
      to: "topic:cto",
      topic: "cto",
      payload,
    });
    assert.equal(published.ok, true);
    assert.equal(published.data.fanout_count, 1);

    const client = await createPipeClient(hub.pipePath);
    const drained = await client.request("query", {
      action: "drain",
      agent_id: "pipe-cto-explicit-audit-leader",
      max_messages: 10,
      auto_ack: true,
    });
    assert.equal(drained.ok, true);
    assert.equal(
      drained.data.messages.some(
        (message) => message.payload?.decision === payload.decision,
      ),
      true,
    );
    assert.equal(
      hub.router
        .getPendingMessages("pipe-cto-explicit-audit-leader")
        .some((message) => message.payload?.decision === payload.decision),
      false,
    );

    const leaderContext = await client.request("query", {
      action: "context",
      agent_id: "pipe-cto-explicit-audit-leader",
      max_messages: 50,
    });
    assert.equal(leaderContext.ok, true);
    assert.equal(
      leaderContext.data.messages.some(
        (message) => message.payload?.decision === payload.decision,
      ),
      true,
    );

    const standbyContext = await client.request("query", {
      action: "context",
      agent_id: "pipe-cto-explicit-audit-standby",
      max_messages: 50,
    });
    assert.equal(standbyContext.ok, true);
    assert.equal(
      standbyContext.data.messages.some(
        (message) => message.payload?.decision === payload.decision,
      ),
      false,
    );

    client.close();
  });

  it("HTTP /bridge/takeover-role도 CTO 승계 surface를 제공해야 한다", async () => {
    hub.router.registerAgent({
      agent_id: "http-cto-new",
      cli: "codex",
      capabilities: ["cto"],
      topics: [],
      metadata: { role: "cto", cto_priority: 3 },
      heartbeat_ttl_ms: 60000,
    });

    const response = await fetch(
      `http://127.0.0.1:${TEST_PORT}/bridge/takeover-role`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "cto",
          agent_id: "http-cto-new",
          reason: "http_test",
          requested_by: "test",
        }),
      },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.leader_agent_id, "http-cto-new");
  });

  it("HTTP /bridge/takeover-role은 malformed 요청을 거부해야 한다", async () => {
    const missingAgent = await fetch(
      `http://127.0.0.1:${TEST_PORT}/bridge/takeover-role`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "cto" }),
      },
    );
    const missingAgentBody = await missingAgent.json();
    assert.equal(missingAgent.status, 400);
    assert.equal(missingAgentBody.ok, false);

    const unsupportedRole = await fetch(
      `http://127.0.0.1:${TEST_PORT}/bridge/takeover-role`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "ceo",
          agent_id: "http-cto-new",
        }),
      },
    );
    const unsupportedRoleBody = await unsupportedRole.json();
    assert.equal(unsupportedRole.status, 409);
    assert.equal(unsupportedRoleBody.ok, false);
    assert.equal(unsupportedRoleBody.error.code, "ROLE_NOT_SUPPORTED");
  });

  it("packaged remote pipe uses packaged core router with takeover_role support", async () => {
    const router = createCoreRouter(createMemoryStore());
    const pipe = createRemotePipeServer({
      router,
      sessionId: `remote-package-${randomUUID()}`,
    });

    const oldRegister = await pipe.executeCommand("register", {
      agent_id: "pkg-cto-old",
      cli: "claude",
      capabilities: ["cto"],
      topics: [],
      metadata: { role: "cto", cto_priority: 10 },
      heartbeat_ttl_ms: 60000,
    });
    const newRegister = await pipe.executeCommand("register", {
      agent_id: "pkg-cto-new",
      cli: "codex",
      capabilities: ["cto"],
      topics: [],
      metadata: { role: "cto", cto_priority: 1 },
      heartbeat_ttl_ms: 60000,
    });
    assert.equal(oldRegister.ok, true);
    assert.equal(newRegister.ok, true);

    const published = await pipe.executeCommand("publish", {
      from: "lead",
      to: "topic:cto",
      topic: "cto",
      payload: { decision: "remote package takeover" },
    });
    assert.equal(published.ok, true);
    assert.equal(published.data.fanout_count, 1);

    const takeover = await pipe.executeCommand("takeover_role", {
      role: "cto",
      agent_id: "pkg-cto-new",
      reason: "package_test",
      requested_by: "test",
    });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.data.leader_agent_id, "pkg-cto-new");
    assert.equal(takeover.data.transferred_count, 1);
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
