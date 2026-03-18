// tests/integration/hub-server.test.mjs — startHub() 라이프사이클 통합 테스트
// 실제 HTTP 서버를 임시 포트로 시작하고 /status, /health, /bridge/* 엔드포인트를 검증
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { startHub } from '../../hub/server.mjs';

// 임시 DB 경로 생성
function tempDbPath() {
  const dir = join(tmpdir(), `tfx-hub-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.db');
}

function firstNonLoopbackIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry?.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

// 테스트용 포트 (기본 27888과 충돌 방지)
const TEST_PORT = 27990 + Math.floor(Math.random() * 100);
const TEST_TOKEN = 'hub-server-test-token';
const EXTERNAL_IP = firstNonLoopbackIpv4();
const CLAUDE_HOME = join(homedir(), '.claude');
const TEAMS_ROOT = join(CLAUDE_HOME, 'teams');
const TASKS_ROOT = join(CLAUDE_HOME, 'tasks');

function uniqueTeamName() {
  return `hub-http-${randomUUID().slice(0, 8)}`;
}

function createTeamFixture(teamName, config = {}) {
  const teamDir = join(TEAMS_ROOT, teamName);
  const inboxesDir = join(teamDir, 'inboxes');
  const tasksDir = join(TASKS_ROOT, teamName);

  mkdirSync(teamDir, { recursive: true });
  mkdirSync(inboxesDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(teamDir, 'config.json'),
    JSON.stringify({ description: 'HTTP bridge 테스트 팀', ...config }, null, 2),
    'utf8',
  );

  return { teamDir, tasksDir };
}

function writeTaskFile(tasksDir, taskId, data) {
  writeFileSync(
    join(tasksDir, `${taskId}.json`),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

function cleanupTeamFixture(teamName) {
  try { rmSync(join(TEAMS_ROOT, teamName), { recursive: true, force: true }); } catch {}
  try { rmSync(join(TASKS_ROOT, teamName), { recursive: true, force: true }); } catch {}
}

describe('startHub() 라이프사이클', () => {
  let hub;
  let baseUrl;

  function bridgeHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
    };
  }

  before(async () => {
    process.env.TFX_HUB_TOKEN = TEST_TOKEN;
    const dbPath = tempDbPath();
    hub = await startHub({ port: TEST_PORT, dbPath, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  after(async () => {
    if (hub?.stop) await hub.stop();
    delete process.env.TFX_HUB_TOKEN;
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
      assert.equal(body.auth_mode, 'token-required');
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
      const res = await fetch(`${baseUrl}/status`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    });

    it('허용되지 않은 Origin은 403을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/status`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
  });

  // ── /bridge/register ──

  describe('POST /bridge/register', () => {
    it('Authorization 헤더가 없으면 401을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'unauthorized-agent', cli: 'codex' }),
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.ok, false);
    });

    it('유효한 에이전트 등록 시 ok: true를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
        body: JSON.stringify({ cli: 'codex' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
    });

    it('cli 누락 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, {
        method: 'POST',
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
        body: JSON.stringify({ agent_id: 'result-agent', cli: 'codex', timeout_sec: 60, topics: [], capabilities: ['code'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/result`, {
        method: 'POST',
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
        body: JSON.stringify({ agent_id: 'ctrl-target', cli: 'codex', timeout_sec: 60, topics: [], capabilities: ['code'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/control`, {
        method: 'POST',
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
        body: JSON.stringify({ agent_id: 'ctx-agent', cli: 'claude', timeout_sec: 60, topics: [], capabilities: ['x'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/context`, {
        method: 'POST',
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
        body: JSON.stringify({ agent_id: 'dereg-agent', cli: 'other', timeout_sec: 60, topics: [], capabilities: ['x'] }),
      });

      const res = await fetch(`${baseUrl}/bridge/deregister`, {
        method: 'POST',
        headers: bridgeHeaders(),
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
        headers: bridgeHeaders(),
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  // ── /bridge/assign/* ──

  describe('POST /bridge/assign/*', () => {
    it('assign async 생성 후 status/result/retry 엔드포인트가 동작해야 한다', async () => {
      const assignedRes = await fetch(`${baseUrl}/bridge/assign/async`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({
          supervisor_agent: 'http-assign-lead',
          worker_agent: 'http-assign-worker',
          task: 'HTTP assign 생성',
          max_retries: 1,
        }),
      });
      assert.equal(assignedRes.status, 200);
      const assigned = await assignedRes.json();
      assert.equal(assigned.ok, true);
      assert.equal(assigned.data.status, 'queued');

      const statusRes = await fetch(`${baseUrl}/bridge/assign/status`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({ job_id: assigned.data.job_id }),
      });
      assert.equal(statusRes.status, 200);
      const current = await statusRes.json();
      assert.equal(current.data.job_id, assigned.data.job_id);

      const retryingRes = await fetch(`${baseUrl}/bridge/assign/result`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({
          job_id: assigned.data.job_id,
          worker_agent: 'http-assign-worker',
          status: 'failed',
          attempt: 1,
          error: { message: 'first failure' },
        }),
      });
      assert.equal(retryingRes.status, 200);
      const retrying = await retryingRes.json();
      assert.equal(retrying.ok, true);
      assert.equal(retrying.data.retried, true);

      const retryRes = await fetch(`${baseUrl}/bridge/assign/retry`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({
          job_id: assigned.data.job_id,
          reason: 'manual-check',
          requested_by: 'test',
        }),
      });
      assert.equal(retryRes.status, 409);

      const doneRes = await fetch(`${baseUrl}/bridge/assign/result`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({
          job_id: assigned.data.job_id,
          worker_agent: 'http-assign-worker',
          status: 'completed',
          attempt: 2,
          metadata: { result: 'success' },
          result: { output: 'done' },
        }),
      });
      assert.equal(doneRes.status, 200);
      const done = await doneRes.json();
      assert.equal(done.data.status, 'succeeded');
    });

    it('필수값 누락 또는 미존재 job은 400/404를 반환해야 한다', async () => {
      const badAssign = await fetch(`${baseUrl}/bridge/assign/async`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({ supervisor_agent: 'lead' }),
      });
      assert.equal(badAssign.status, 400);

      const badResult = await fetch(`${baseUrl}/bridge/assign/result`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({ status: 'completed' }),
      });
      assert.equal(badResult.status, 400);

      const missingStatus = await fetch(`${baseUrl}/bridge/assign/status`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({ job_id: 'missing-job-id' }),
      });
      assert.equal(missingStatus.status, 404);
    });
  });

  describe('POST /bridge/team/*', () => {
    const teamName = uniqueTeamName();
    const taskId = 'http-fail-task';

    before(() => {
      const { tasksDir } = createTeamFixture(teamName, {
        description: 'HTTP team-task-update 테스트',
      });
      writeTaskFile(tasksDir, taskId, {
        id: taskId,
        status: 'in_progress',
        owner: 'worker-http',
        metadata: { existing: 'value' },
      });
    });

    after(() => cleanupTeamFixture(teamName));

    it('team-task-update는 status=failed를 completed + metadata.result=failed로 정규화해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/team/task-update`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({
          team_name: teamName,
          task_id: taskId,
          status: 'failed',
          metadata_patch: { via: 'http-test' },
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.task_after.status, 'completed');
      assert.equal(body.data.task_after.metadata?.result, 'failed');
      assert.equal(body.data.task_after.metadata?.via, 'http-test');
      assert.equal(body.data.task_after.metadata?.existing, 'value');
    });
  });

  // ── 알 수 없는 경로 ──

  describe('알 수 없는 경로', () => {
    it('인증 없이 GET /nonexistent 는 401을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/nonexistent`);
      assert.equal(res.status, 401);
    });

    it('인증된 GET /nonexistent 는 404를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/nonexistent`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      assert.equal(res.status, 404);
    });

    it('/bridge/unknown-endpoint 는 404를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/unknown-endpoint`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 404);
    });

    it('/bridge/* 에 GET 요청 시 405를 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/bridge/register`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      assert.equal(res.status, 405);
    });
  });

  // ── /mcp 초기화 없는 POST ──

  describe('POST /mcp 세션 없는 요청', () => {
    it('Authorization 헤더가 없으면 401을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      assert.equal(res.status, 401);
    });

    it('세션 ID 없이 비-initialize 요청 시 400을 반환해야 한다', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      assert.equal(res.status, 400);
    });
  });
});

describe('startHub() localhost-only 모드', () => {
  const LOCAL_ONLY_PORT = TEST_PORT + 200;
  let hub;
  let baseUrl;

  before(async () => {
    delete process.env.TFX_HUB_TOKEN;
    const dbPath = tempDbPath();
    hub = await startHub({ port: LOCAL_ONLY_PORT, dbPath, host: '0.0.0.0' });
    baseUrl = `http://127.0.0.1:${LOCAL_ONLY_PORT}`;
  });

  after(async () => {
    if (hub?.stop) await hub.stop();
  });

  it('로컬 /status는 인증 없이 접근 가능해야 한다', async () => {
    const res = await fetch(`${baseUrl}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.auth_mode, 'localhost-only');
    assert.equal(hub.hubToken, null);
    assert.equal(hub.authMode, 'localhost-only');
  });

  it('로컬 /bridge/register는 인증 없이 동작해야 한다', async () => {
    const res = await fetch(`${baseUrl}/bridge/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'localhost-only-agent',
        cli: 'codex',
        timeout_sec: 60,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('로컬 /mcp는 인증 없이 기존 유효성 검사를 통과해야 한다', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    assert.equal(res.status, 400);
  });

  it('원격 주소로 들어오면 403으로 차단해야 한다', { skip: !EXTERNAL_IP }, async () => {
    const res = await fetch(`http://${EXTERNAL_IP}:${LOCAL_ONLY_PORT}/status`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'Forbidden: localhost only');
  });
});
