// tests/integration/store.test.mjs — store.mjs CRUD 통합 테스트
// 임시 인메모리 SQLite DB를 사용하여 외부 의존성 없이 실행
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createStore, uuidv7 } from '../../hub/store.mjs';

// ── 헬퍼: 격리된 임시 DB 경로 생성 ──
function tempDbPath() {
  const dir = join(tmpdir(), `tfx-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.db');
}

// ── uuidv7 ──
describe('uuidv7()', () => {
  it('RFC 9562 형식의 문자열을 반환해야 한다', () => {
    const id = uuidv7();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('연속 호출 시 서로 다른 값을 반환해야 한다', () => {
    const ids = new Set(Array.from({ length: 20 }, () => uuidv7()));
    assert.equal(ids.size, 20);
  });

  it('시간 순서가 보장되어야 한다 (단조 증가)', () => {
    const a = uuidv7();
    const b = uuidv7();
    // UUIDv7은 문자열 비교로 시간 순서 확인 가능 (lexicographic order)
    assert.ok(a <= b, `${a} <= ${b}여야 한다`);
  });
});

// ── createStore() ──
describe('createStore()', () => {
  let store;
  let dbPath;

  before(() => {
    dbPath = tempDbPath();
    store = createStore(dbPath);
  });

  after(() => {
    store.close();
    try { rmSync(join(dbPath, '..'), { recursive: true, force: true }); } catch {}
  });

  // ── 에이전트 CRUD ──

  describe('에이전트 등록/조회', () => {
    it('registerAgent()는 lease_expires_ms를 포함한 객체를 반환해야 한다', () => {
      const result = store.registerAgent({
        agent_id: 'test-agent-001',
        cli: 'codex',
        capabilities: ['code'],
        topics: ['task.result'],
        heartbeat_ttl_ms: 60000,
      });
      assert.ok(result.agent_id);
      assert.ok(result.lease_expires_ms > Date.now());
      assert.ok(result.lease_id);
    });

    it('getAgent()는 등록된 에이전트를 반환해야 한다', () => {
      store.registerAgent({
        agent_id: 'test-agent-002',
        cli: 'gemini',
        capabilities: ['docs'],
        topics: [],
        heartbeat_ttl_ms: 30000,
      });
      const agent = store.getAgent('test-agent-002');
      assert.equal(agent.agent_id, 'test-agent-002');
      assert.equal(agent.cli, 'gemini');
      assert.equal(agent.status, 'online');
      assert.deepEqual(agent.capabilities, ['docs']);
    });

    it('getAgent()는 존재하지 않는 ID에 대해 null을 반환해야 한다', () => {
      const agent = store.getAgent('nonexistent-agent-xyz');
      assert.equal(agent, null);
    });

    it('listOnlineAgents()는 online 에이전트 배열을 반환해야 한다', () => {
      const agents = store.listOnlineAgents();
      assert.ok(Array.isArray(agents));
      assert.ok(agents.every(a => a.status !== 'offline'));
    });

    it('updateAgentStatus()는 에이전트 상태를 변경해야 한다', () => {
      store.registerAgent({
        agent_id: 'test-agent-status',
        cli: 'claude',
        capabilities: ['orchestration'],
        topics: [],
        heartbeat_ttl_ms: 30000,
      });
      const changed = store.updateAgentStatus('test-agent-status', 'offline');
      assert.equal(changed, true);
      const agent = store.getAgent('test-agent-status');
      assert.equal(agent.status, 'offline');
    });

    it('동일 agent_id로 재등록 시 upsert가 되어야 한다', () => {
      store.registerAgent({ agent_id: 'upsert-agent', cli: 'codex', capabilities: ['a'], topics: [], heartbeat_ttl_ms: 30000 });
      store.registerAgent({ agent_id: 'upsert-agent', cli: 'gemini', capabilities: ['b'], topics: [], heartbeat_ttl_ms: 30000 });
      const agent = store.getAgent('upsert-agent');
      assert.equal(agent.cli, 'gemini');
    });
  });

  // ── 메시지 큐 ──

  describe('메시지 enqueue/poll', () => {
    it('enqueueMessage()는 id와 payload를 포함한 메시지 객체를 반환해야 한다', () => {
      const msg = store.enqueueMessage({
        type: 'event',
        from: 'sender-agent',
        to: 'receiver-agent',
        topic: 'test.event',
        payload: { data: 'hello' },
      });
      assert.ok(msg.id);
      assert.equal(msg.from_agent, 'sender-agent');
      assert.equal(msg.to_agent, 'receiver-agent');
      assert.equal(msg.status, 'queued');
      assert.deepEqual(msg.payload, { data: 'hello' });
    });

    it('getMessage()는 enqueue된 메시지를 반환해야 한다', () => {
      const msg = store.enqueueMessage({
        type: 'event',
        from: 'agent-a',
        to: 'agent-b',
        topic: 'test.get',
        payload: { x: 1 },
      });
      const fetched = store.getMessage(msg.id);
      assert.equal(fetched.id, msg.id);
      assert.deepEqual(fetched.payload, { x: 1 });
    });

    it('deliverToAgent() 후 pollForAgent()는 해당 메시지를 반환해야 한다', () => {
      // 수신 에이전트 등록
      store.registerAgent({ agent_id: 'poll-target', cli: 'other', capabilities: ['x'], topics: [], heartbeat_ttl_ms: 60000 });

      const msg = store.enqueueMessage({
        type: 'event',
        from: 'producer',
        to: 'poll-target',
        topic: 'poll.test',
        payload: { n: 42 },
      });
      store.deliverToAgent(msg.id, 'poll-target');

      const messages = store.pollForAgent('poll-target', { max_messages: 5 });
      assert.ok(messages.length > 0);
      const found = messages.find(m => m.id === msg.id);
      assert.ok(found, '배달된 메시지가 poll 결과에 있어야 한다');
      assert.deepEqual(found.payload, { n: 42 });
    });

    it('getMessage()는 존재하지 않는 ID에 대해 null을 반환해야 한다', () => {
      const msg = store.getMessage('nonexistent-msg-id');
      assert.equal(msg, null);
    });
  });

  // ── assign job ──

  describe('assign job CRUD', () => {
    it('createAssign()는 queued 상태의 assign job을 생성해야 한다', () => {
      const job = store.createAssign({
        supervisor_agent: 'lead-assign-store',
        worker_agent: 'worker-assign-store',
        task: '문서를 요약하라',
        payload: { file: 'README.md' },
        max_retries: 2,
      });

      assert.ok(job.job_id);
      assert.equal(job.status, 'queued');
      assert.equal(job.attempt, 1);
      assert.equal(job.retry_count, 0);
      assert.equal(job.max_retries, 2);
      assert.deepEqual(job.payload, { file: 'README.md' });
    });

    it('updateAssignStatus()는 running/succeeded 상태와 결과를 반영해야 한다', () => {
      const job = store.createAssign({
        supervisor_agent: 'lead-assign-update',
        worker_agent: 'worker-assign-update',
        task: '테스트 실행',
      });

      const running = store.updateAssignStatus(job.job_id, 'running', {
        started_at_ms: Date.now(),
      });
      assert.equal(running.status, 'running');
      assert.ok(running.started_at_ms);

      const done = store.updateAssignStatus(job.job_id, 'succeeded', {
        result: { ok: true },
      });
      assert.equal(done.status, 'succeeded');
      assert.deepEqual(done.result, { ok: true });
      assert.ok(done.completed_at_ms);
    });

    it('retryAssign()는 attempt/retry_count를 증가시키고 queued로 되돌려야 한다', () => {
      const job = store.createAssign({
        supervisor_agent: 'lead-assign-retry',
        worker_agent: 'worker-assign-retry',
        task: '실패 후 재시도',
        max_retries: 3,
      });
      store.updateAssignStatus(job.job_id, 'failed', {
        error: { message: '첫 실패' },
      });

      const retried = store.retryAssign(job.job_id, {
        error: { message: '재시도 예정' },
      });

      assert.equal(retried.status, 'queued');
      assert.equal(retried.attempt, 2);
      assert.equal(retried.retry_count, 1);
      assert.deepEqual(retried.error, { message: '재시도 예정' });
      assert.equal(retried.completed_at_ms, null);
    });

    it('listAssigns()는 supervisor/status 필터를 적용해야 한다', () => {
      store.createAssign({
        supervisor_agent: 'lead-filter-a',
        worker_agent: 'worker-filter-a',
        task: 'A',
      });
      store.createAssign({
        supervisor_agent: 'lead-filter-b',
        worker_agent: 'worker-filter-b',
        task: 'B',
        status: 'running',
      });

      const queued = store.listAssigns({ status: 'queued', limit: 20 });
      const bySupervisor = store.listAssigns({ supervisor_agent: 'lead-filter-a', limit: 20 });

      assert.ok(queued.some((item) => item.status === 'queued'));
      assert.equal(bySupervisor.length, 1);
      assert.equal(bySupervisor[0].supervisor_agent, 'lead-filter-a');
    });
  });

  // ── 스위퍼 ──

  describe('sweepExpired()', () => {
    it('TTL이 초과된 메시지를 dead_letter로 이동해야 한다', () => {
      // TTL = 1ms (즉시 만료)
      store.enqueueMessage({
        type: 'event',
        from: 'sweeper-test',
        to: 'nobody',
        topic: 'expire.test',
        ttl_ms: 1,
        payload: {},
      });

      // 1ms 이상 경과 후 sweep
      // Atomics.wait 대신 단순 반복으로 최소 대기
      const start = Date.now();
      while (Date.now() - start < 5) { /* 5ms 대기 */ }

      const result = store.sweepExpired();
      assert.ok(result.messages >= 1, '만료된 메시지가 최소 1개 이상 처리되어야 한다');
    });
  });

  // ── 메트릭 ──

  describe('메트릭 조회', () => {
    it('getQueueDepths()는 urgent/normal/dlq 카운트를 반환해야 한다', () => {
      const depths = store.getQueueDepths();
      assert.equal(typeof depths.urgent, 'number');
      assert.equal(typeof depths.normal, 'number');
      assert.equal(typeof depths.dlq, 'number');
    });

    it('getDeliveryStats()는 total_deliveries와 avg_delivery_ms를 반환해야 한다', () => {
      const stats = store.getDeliveryStats();
      assert.equal(typeof stats.total_deliveries, 'number');
      assert.equal(typeof stats.avg_delivery_ms, 'number');
    });

    it('getHubStats()는 online_agents와 total_messages를 포함해야 한다', () => {
      const stats = store.getHubStats();
      assert.equal(typeof stats.online_agents, 'number');
      assert.equal(typeof stats.total_messages, 'number');
    });
  });

  // ── 데드 레터 ──

  describe('데드 레터 큐', () => {
    it('moveToDeadLetter()는 메시지를 dead_letter 큐로 이동시켜야 한다', () => {
      const msg = store.enqueueMessage({
        type: 'event',
        from: 'dl-test',
        to: 'nobody',
        topic: 'dl.test',
        payload: {},
      });
      store.moveToDeadLetter(msg.id, 'test_reason', 'test error');
      const dls = store.getDeadLetters(10);
      assert.ok(dls.some(dl => dl.message_id === msg.id));
    });
  });
});
