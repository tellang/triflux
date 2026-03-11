// tests/integration/router-route.test.mjs — router.mjs 커버리지 보완 테스트
//
// 기존 router.test.mjs에서 다루지 않은 경로를 검증:
//   - route() 직접 호출 (topic 팬아웃 / 1:1 직접 배달)
//   - responseEmitter 이벤트 기반 ask 응답 수신 (await_response_ms > 0)
//   - getStatus(scope='queue') 분기
//   - handlePublish()에서 correlation_id 있을 때 responseEmitter.emit 발생
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createStore } from '../../hub/store.mjs';
import { createRouter } from '../../hub/router.mjs';

// 격리된 임시 DB 경로 생성
function tempDbPath() {
  const dir = join(tmpdir(), `tfx-router-route-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.db');
}

describe('createRouter() — route() 직접 호출', () => {
  let store;
  let router;

  before(() => {
    store = createRouter(createStore(tempDbPath()));
  });

  after(() => {
    store.stopSweeper?.();
  });

  it('topic: 접두사 없는 대상은 1을 반환해야 한다', () => {
    // route() 반환값: 배달 에이전트 수
    const s = createStore(tempDbPath());
    const r = createRouter(s);

    // 수신 에이전트 등록
    s.registerAgent({
      agent_id: 'direct-route-target',
      cli: 'codex',
      capabilities: ['x'],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });

    const msg = s.enqueueMessage({
      type: 'event',
      from: 'route-sender',
      to: 'direct-route-target',
      topic: 'route.direct',
      payload: {},
    });

    // route()는 내부적으로 deliverToAgent를 호출하고 1을 반환해야 한다
    const count = r.route(msg);
    assert.equal(count, 1);

    r.stopSweeper();
    s.close();
  });

  it('topic: 접두사 대상은 구독자 수를 반환해야 한다', () => {
    const s = createStore(tempDbPath());
    const r = createRouter(s);

    // 동일 토픽 구독 에이전트 3개 등록
    for (let i = 0; i < 3; i++) {
      s.registerAgent({
        agent_id: `fanout-route-${i}`,
        cli: 'codex',
        capabilities: ['x'],
        topics: ['route.fanout'],
        heartbeat_ttl_ms: 60000,
      });
    }

    const msg = s.enqueueMessage({
      type: 'event',
      from: 'fanout-sender',
      to: 'topic:route.fanout',
      topic: 'route.fanout',
      payload: { broadcast: true },
    });

    const count = r.route(msg);
    assert.ok(count >= 3, `팬아웃 에이전트 수가 최소 3이어야 한다 (실제: ${count})`);

    r.stopSweeper();
    s.close();
  });
});

describe('createRouter() — responseEmitter 기반 ask/publish 응답 수신', () => {
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
    try { rmSync(join(dbPath, '..'), { recursive: true, force: true }); } catch {}
  });

  it('handlePublish()에서 correlation_id 발행 시 responseEmitter 이벤트가 발생해야 한다', async () => {
    // responseEmitter를 직접 구독하여 emit 확인
    const cid = randomUUID();
    store.registerAgent({
      agent_id: 'emitter-target',
      cli: 'codex',
      capabilities: ['x'],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });

    let emitted = false;
    const emitPromise = new Promise((resolve) => {
      router.responseEmitter.once(cid, (payload) => {
        emitted = true;
        resolve(payload);
      });
    });

    router.handlePublish({
      from: 'emitter-sender',
      to: 'emitter-target',
      topic: 'test.emit',
      payload: { answer: 'yes' },
      correlation_id: cid,
    });

    const receivedPayload = await emitPromise;
    assert.equal(emitted, true);
    assert.deepEqual(receivedPayload, { answer: 'yes' });
  });

  it('handleAsk()에서 await_response_ms > 0이고 응답이 도착하면 state=answered를 반환해야 한다', async () => {
    store.registerAgent({
      agent_id: 'ask-answerer',
      cli: 'codex',
      capabilities: ['x'],
      topics: [],
      heartbeat_ttl_ms: 60000,
    });

    // handleAsk 시작 전 eventNames()를 스냅샷으로 찍어두고
    // 호출 후 새로 추가된 이벤트 이름 중 내부 예약어(error/newListener/removeListener)를
    // 제외한 값이 correlation_id이다.
    //
    // node:events의 once(emitter, event, {signal})는 내부적으로
    //   emitter.once(event, ...)   → newListener 이벤트 발생 (event = cid)
    //   emitter.once('error', ...) → newListener 이벤트 발생 (event = 'error')
    // 두 번 등록하므로 newListener 콜백의 마지막 값이 'error'가 된다.
    // 따라서 newListener 훅 대신 호출 전후 eventNames() diff를 사용한다.
    const RESERVED = new Set(['newListener', 'removeListener', 'error']);
    const beforeNames = new Set(router.responseEmitter.eventNames());

    const askPromise = router.handleAsk({
      from: 'question-sender',
      to: 'ask-answerer',
      topic: 'test.ask.answer',
      question: '응답 있는 질문',
      await_response_ms: 2000, // 충분한 대기
    });

    // once()는 handleAsk 내부에서 동기적으로 등록되므로 await 불필요
    // 예비로 한 틱 대기
    await new Promise((r) => setImmediate(r));

    // 새로 추가된 이름 중 예약어가 아닌 첫 번째 항목이 correlation_id
    const capturedCid = router.responseEmitter
      .eventNames()
      .find((name) => !RESERVED.has(name) && !beforeNames.has(name));

    assert.ok(capturedCid, 'once() 리스너(correlation_id)가 등록되어야 한다');

    // 등록된 cid에 응답 emit → handleAsk의 once() 리스너가 수신
    router.responseEmitter.emit(capturedCid, { answer: 'resolved' });

    const result = await askPromise;
    assert.equal(result.ok, true);
    assert.equal(result.data.state, 'answered');
    assert.deepEqual(result.data.response, { answer: 'resolved' });
  });
});

describe('createRouter() — getStatus() 분기 보완', () => {
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
    try { rmSync(join(dbPath, '..'), { recursive: true, force: true }); } catch {}
  });

  it('scope=queue 일 때 hub 상태와 queues 메트릭을 반환해야 한다', () => {
    // getStatus()에서 scope=hub와 scope=queue는 동일 분기 처리
    const result = router.getStatus('queue');
    assert.equal(result.ok, true);
    assert.ok('hub' in result.data, 'hub 키가 있어야 한다');
    // include_metrics 기본값 true
    assert.ok('queues' in result.data, 'queues 키가 있어야 한다');
  });

  it('scope=agent이고 agent_id가 없을 때 agent 키가 없어야 한다', () => {
    const result = router.getStatus('agent'); // agent_id 미전달
    assert.equal(result.ok, true);
    assert.equal('agent' in result.data, false);
  });

  it('scope=trace이고 trace_id가 없을 때 trace 키가 없어야 한다', () => {
    const result = router.getStatus('trace'); // trace_id 미전달
    assert.equal(result.ok, true);
    assert.equal('trace' in result.data, false);
  });

  it('scope=agent이고 존재하지 않는 agent_id일 때 agent 키가 없어야 한다', () => {
    const result = router.getStatus('agent', { agent_id: 'nonexistent-agent-xyz' });
    assert.equal(result.ok, true);
    assert.equal('agent' in result.data, false);
  });

  it('include_metrics=false 일 때 queues 키가 없어야 한다', () => {
    const result = router.getStatus('hub', { include_metrics: false });
    assert.equal(result.ok, true);
    assert.ok('hub' in result.data);
    assert.equal('queues' in result.data, false);
  });
});
