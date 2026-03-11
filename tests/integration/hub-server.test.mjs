// tests/integration/hub-server.test.mjs — startHub() 라이프사이클 통합 테스트
// 실제 HTTP 서버를 임시 포트로 시작하고 /status, /health, /bridge/* 엔드포인트를 검증
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { startHub } from '../../hub/server.mjs';

// 임시 DB 경로 생성
function tempDbPath() {
  const dir = join(tmpdir(), `tfx-hub-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.db');
}

// 테스트용 포트 (기본 27888과 충돌 방지)
const TEST_PORT = 27990 + Math.floor(Math.random() * 100);

describe('startHub() 라이프사이클', () => {
  let hub;
  let baseUrl;

  before(async () => {
    const dbPath = tempDbPath();
    hub = await startHub({ port: TEST_PORT, dbPath, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  after(async () => {
    if (hub?.stop) await hub.stop();
  });

  it('startHub()는 port, host, url, pid를 포함한 객체를 반환해야 한다', () => {
    assert.equal(hub.port, TEST_PORT);
    assert.equal(hub.host, '127.0.0.1');
    assert.ok(hub.url.startsWith('http://'));
    assert.equal(hub.pid, process.pid);
    assert.ok(typeof hub.stop === 'function');
  });

  // ── /status ──

  describe('GET /status', () => {
    it('200 응답과 hub 상태 JSON을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok('hub' in body || 'sessions' in body, '/status 응답에 hub 또는 sessions가 있어야 한다');
      assert.equal(body.port, TEST_PORT);
      assert.equal(body.pid, process.pid);
    });

    it('GET / 도 /status와 동일한 응답을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);
    });
  });

  // ── /health ──

  describe('GET /health', () => {
    it('200 또는 503을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.ok([200, 503].includes(res.status));
      const body = await res.json();
      assert.equal(typeof body.ok, 'boolean');
    });

    it('GET /healthz 도 동일하게 동작해야 한다', async () => {
      const res = await fetch(`${baseUrl}/healthz`);
      assert.ok([200, 503].includes(res.status));
    });
  });

  // ── OPTIONS (CORS preflight) ──

  describe('OPTIONS 요청', () => {
    it('204를 반환하고 CORS 헤더를 포함해야 한다', async () => {
      const res = await fetch(`${baseUrl}/status`, { method: 'OPTIONS' });
      assert.equal(res.status, 204);
      assert.ok(res.headers.get('access-control-allow-origin'));
    });
  });

  // ── /bridge/register ──

  describe('POST /bridge/register', () => {
    it('유효한 에이전트 등록 시 ok: true를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: 'test-agent-http-001',
          cli: 'codex',
          timeout_sec: 60,
          topics: ['task.result'],
          capabilities: ['code'],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.ok(body.data?.lease_expires_ms > Date.now());
    });

    it('agent_id 누락 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli: 'codex' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
    });

    it('cli 누락 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'incomplete-agent' }),
      });
      assert.equal(res.status, 400);
    });
  });

  // ── /bridge/result ──

  describe('POST /bridge/result', () => {
    it('유효한 결과 발행 시 ok: true를 반환해야 한다', async () => {
      // 먼저 에이전트 등록
      await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'result-agent', cli: 'codex', timeout_sec: 60, topics: [], capabilities: ['code'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: 'result-agent',
          topic: 'task.result',
          payload: { output: '완료' },
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    it('agent_id 누락 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'task.result' }),
      });
      assert.equal(res.status, 400);
    });
  });

  // ── /bridge/control ──

  describe('POST /bridge/control', () => {
    it('to_agent와 command가 있을 때 ok: true를 반환해야 한다', async () => {
      // 수신 에이전트 등록
      await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'ctrl-target', cli: 'codex', timeout_sec: 60, topics: [], capabilities: ['code'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_agent: 'lead',
          to_agent: 'ctrl-target',
          command: 'pause',
          reason: '테스트',
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    it('to_agent 누락 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'pause' }),
      });
      assert.equal(res.status, 400);
    });
  });

  // ── /bridge/context ──

  describe('POST /bridge/context', () => {
    it('등록된 에이전트의 컨텍스트 폴링 시 ok: true를 반환해야 한다', async () => {
      await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'ctx-agent', cli: 'claude', timeout_sec: 60, topics: [], capabilities: ['x'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'ctx-agent', max_messages: 5 }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.data?.messages));
    });

    it('agent_id 누락 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_messages: 5 }),
      });
      assert.equal(res.status, 400);
    });
  });

  // ── /bridge/deregister ──

  describe('POST /bridge/deregister', () => {
    it('등록된 에이전트 해제 시 ok: true와 offline 상태를 반환해야 한다', async () => {
      await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'dereg-agent', cli: 'other', timeout_sec: 60, topics: [], capabilities: ['x'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/deregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'dereg-agent' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data?.status, 'offline');
    });

    it('agent_id 누락 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/deregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  // ── 알 수 없는 경로 ──

  describe('알 수 없는 경로', () => {
    it('GET /nonexistent 는 404를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/nonexistent`);
      assert.equal(res.status, 404);
    });

    it('/bridge/unknown-endpoint 는 404를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/unknown-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 404);
    });

    it('/bridge/* 에 GET 요청 시 405를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, { method: 'GET' });
      assert.equal(res.status, 405);
    });
  });

  // ── /mcp 초기화 없는 POST ──

  describe('POST /mcp 세션 없는 요청', () => {
    it('세션 ID 없이 비-initialize 요청 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      assert.equal(res.status, 400);
    });
  });
});
