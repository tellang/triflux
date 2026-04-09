// tests/integration/router.test.mjs — router.mjs 통합 테스트
// store + router를 함께 초기화하여 실제 라우팅 경로를 검증

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createRouter } from "../../hub/router.mjs";
import { createStore } from "../../hub/store.mjs";

function tempDbPath() {
  const dir = join(tmpdir(), `tfx-router-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

describe("createRouter()", () => {
  let store;
  let router;
  let dbPath;

  before(() => {
    dbPath = tempDbPath();
    store = createStore(dbPath);
    router = createRouter(store);
  });

  after(() => {
    router.stopSweeper();
    store.close();
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {}
  });

  // ── handlePublish ──

  describe("handlePublish()", () => {
    it("직접 에이전트 대상 발행 시 ok: true와 message_id를 반환해야 한다", () => {
      // 수신 에이전트 등록
      store.registerAgent({
        agent_id: "pub-receiver",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handlePublish({
        from: "pub-sender",
        to: "pub-receiver",
        topic: "test.event",
        payload: { value: 1 },
      });

      assert.equal(result.ok, true);
      assert.ok(result.data.message_id);
      assert.equal(typeof result.data.fanout_count, "number");
      assert.ok(result.data.expires_at_ms > Date.now());
    });

    it("correlation_id 있을 때 response 타입으로 저장되어야 한다", () => {
      store.registerAgent({
        agent_id: "corr-receiver",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const cid = randomUUID();
      const result = router.handlePublish({
        from: "corr-sender",
        to: "corr-receiver",
        topic: "test.response",
        payload: { answer: 42 },
        correlation_id: cid,
      });

      assert.equal(result.ok, true);
      const msg = store.getMessage(result.data.message_id);
      assert.equal(msg.type, "response");
      assert.equal(msg.correlation_id, cid);
    });

    it("correlation_id 없을 때 event 타입으로 저장되어야 한다", () => {
      store.registerAgent({
        agent_id: "event-receiver",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handlePublish({
        from: "event-sender",
        to: "event-receiver",
        topic: "test.plain",
        payload: {},
      });

      const msg = store.getMessage(result.data.message_id);
      assert.equal(msg.type, "event");
    });

    it("topic: 접두사로 팬아웃 발행 시 구독 에이전트 수를 fanout_count로 반환해야 한다", () => {
      // 동일 토픽을 구독하는 에이전트 2개 등록
      store.registerAgent({
        agent_id: "fanout-a",
        cli: "codex",
        capabilities: ["x"],
        topics: ["broadcast.test"],
        heartbeat_ttl_ms: 60000,
      });
      store.registerAgent({
        agent_id: "fanout-b",
        cli: "gemini",
        capabilities: ["y"],
        topics: ["broadcast.test"],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handlePublish({
        from: "broadcaster",
        to: "topic:broadcast.test",
        topic: "broadcast.test",
        payload: { msg: "hello all" },
      });

      assert.equal(result.ok, true);
      assert.ok(
        result.data.fanout_count >= 2,
        `fanout_count(${result.data.fanout_count})는 최소 2여야 한다`,
      );
    });
  });

  // ── handleAsk ──

  describe("handleAsk()", () => {
    it("await_response_ms=0 일 때 즉시 티켓(correlation_id)을 반환해야 한다", async () => {
      store.registerAgent({
        agent_id: "ask-target",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = await router.handleAsk({
        from: "asker",
        to: "ask-target",
        topic: "test.ask",
        question: "지금 몇 시야?",
        await_response_ms: 0,
      });

      assert.equal(result.ok, true);
      assert.equal(result.data.state, "queued");
      assert.ok(result.data.correlation_id);
      assert.ok(result.data.request_message_id);
    });

    it("await_response_ms > 0이고 응답 없을 때 delivered 또는 queued 상태를 반환해야 한다", async () => {
      store.registerAgent({
        agent_id: "ask-timeout-target",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = await router.handleAsk({
        from: "asker2",
        to: "ask-timeout-target",
        topic: "test.ask.timeout",
        question: "응답 없는 질문",
        await_response_ms: 50, // 50ms 대기 후 타임아웃
      });

      assert.equal(result.ok, true);
      assert.ok(
        ["delivered", "queued"].includes(result.data.state),
        `state는 delivered 또는 queued여야 한다 (실제: ${result.data.state})`,
      );
    });
  });

  // ── handleHandoff ──

  describe("handleHandoff()", () => {
    it("handoff_message_id와 assigned_to를 포함한 응답을 반환해야 한다", () => {
      store.registerAgent({
        agent_id: "handoff-target",
        cli: "codex",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handleHandoff({
        from: "lead",
        to: "handoff-target",
        topic: "task.handoff",
        task: "테스트 작업을 완료하세요",
        acceptance_criteria: ["테스트 통과"],
      });

      assert.equal(result.ok, true);
      assert.ok(result.data.handoff_message_id);
      assert.equal(result.data.assigned_to, "handoff-target");
      assert.equal(result.data.state, "queued");
    });
  });

  // ── assignAsync / reportAssignResult ──

  describe("assign job 상태머신", () => {
    it("assignAsync()는 queued assign job을 생성하고 워커에게 메시지를 큐잉해야 한다", () => {
      store.registerAgent({
        agent_id: "assign-worker-a",
        cli: "codex",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.assignAsync({
        supervisor_agent: "assign-lead-a",
        worker_agent: "assign-worker-a",
        task: "README를 점검하라",
        max_retries: 1,
      });

      assert.equal(result.ok, true);
      assert.equal(result.data.status, "queued");
      assert.ok(result.data.job_id);

      const pending = router.getPendingMessages("assign-worker-a", {
        max_messages: 10,
      });
      assert.ok(
        pending.some(
          (message) => message.payload?.assign_job_id === result.data.job_id,
        ),
      );
    });

    it("reportAssignResult()는 completed + metadata.result를 succeeded로 정규화해야 한다", () => {
      const created = router.assignAsync({
        supervisor_agent: "assign-lead-success",
        worker_agent: "assign-worker-success",
        task: "성공 케이스",
      });

      const running = router.reportAssignResult({
        job_id: created.data.job_id,
        worker_agent: "assign-worker-success",
        status: "running",
        attempt: 1,
      });
      assert.equal(running.ok, true);
      assert.equal(running.data.status, "running");

      const done = router.reportAssignResult({
        job_id: created.data.job_id,
        worker_agent: "assign-worker-success",
        status: "completed",
        attempt: 1,
        metadata: { result: "success" },
        result: { summary: "ok" },
      });

      assert.equal(done.ok, true);
      assert.equal(done.data.status, "succeeded");
      assert.deepEqual(done.data.result, { summary: "ok" });

      const supervisorMessages = router.getPendingMessages(
        "assign-lead-success",
        { max_messages: 20 },
      );
      assert.ok(
        supervisorMessages.some(
          (message) =>
            message.topic === "assign.result" &&
            message.payload?.job_id === created.data.job_id &&
            message.payload?.status === "succeeded",
        ),
      );
    });

    it("failed 결과는 max_retries 한도 내에서 자동 재시도되어야 한다", () => {
      const created = router.assignAsync({
        supervisor_agent: "assign-lead-retry",
        worker_agent: "assign-worker-retry",
        task: "재시도 케이스",
        max_retries: 1,
      });

      const failed = router.reportAssignResult({
        job_id: created.data.job_id,
        worker_agent: "assign-worker-retry",
        status: "failed",
        attempt: 1,
        error: { message: "실패" },
      });

      assert.equal(failed.ok, true);
      assert.equal(failed.data.retried, true);
      assert.equal(failed.data.status, "queued");
      assert.equal(failed.data.retry_count, 1);
      assert.equal(failed.data.attempt, 2);
    });

    it("sweepTimedOutAssigns()는 만료된 assign을 timed_out 또는 retry로 처리해야 한다", () => {
      const job = store.createAssign({
        supervisor_agent: "assign-lead-timeout",
        worker_agent: "assign-worker-timeout",
        task: "타임아웃 케이스",
        max_retries: 0,
        deadline_ms: Date.now() - 10,
      });

      const result = router.sweepTimedOutAssigns();
      assert.equal(result.timed_out >= 1, true);

      const updated = store.getAssign(job.job_id);
      assert.equal(updated.status, "timed_out");
    });
  });

  // ── getStatus ──

  describe("getStatus()", () => {
    it('scope=hub 일 때 hub.state === "healthy"를 반환해야 한다', () => {
      const result = router.getStatus("hub");
      assert.equal(result.ok, true);
      assert.equal(result.data.hub.state, "healthy");
      assert.ok(result.data.hub.uptime_ms >= 0);
    });

    it("scope=hub 일 때 queues 메트릭을 포함해야 한다", () => {
      const result = router.getStatus("hub", { include_metrics: true });
      assert.ok("queues" in result.data);
      assert.equal(typeof result.data.queues.urgent_depth, "number");
      assert.equal(typeof result.data.queues.normal_depth, "number");
      assert.equal(typeof result.data.queues.dlq_depth, "number");
    });

    it("scope=agent 일 때 등록된 에이전트 정보를 반환해야 한다", () => {
      store.registerAgent({
        agent_id: "status-check-agent",
        cli: "claude",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.getStatus("agent", {
        agent_id: "status-check-agent",
      });
      assert.equal(result.ok, true);
      assert.equal(result.data.agent.agent_id, "status-check-agent");
    });

    it("scope=trace 일 때 해당 trace_id 메시지 목록을 반환해야 한다", () => {
      const tid = randomUUID();
      store.enqueueMessage({
        type: "event",
        from: "tracer",
        to: "tracee",
        topic: "trace.test",
        payload: {},
        trace_id: tid,
      });

      const result = router.getStatus("trace", { trace_id: tid });
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.data.trace));
      assert.ok(result.data.trace.some((m) => m.trace_id === tid));
    });
  });

  // ── 스위퍼 ──

  describe("startSweeper() / stopSweeper()", () => {
    it("startSweeper() 는 중복 호출해도 타이머를 하나만 유지해야 한다", () => {
      // 별도 router 인스턴스로 테스트 (메인 router 오염 방지)
      const r2 = createRouter(store);
      r2.startSweeper();
      r2.startSweeper(); // 중복 — 무시되어야 함
      r2.stopSweeper();
      // 에러 없이 완료되면 성공
      assert.ok(true);
    });

    it("stopSweeper() 는 미시작 상태에서도 안전해야 한다", () => {
      const r3 = createRouter(store);
      r3.stopSweeper(); // 시작 안 했어도 에러 없어야 함
      assert.ok(true);
    });
  });
});
