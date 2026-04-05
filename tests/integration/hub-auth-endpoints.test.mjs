// Batch 3: 다중 엔드포인트 인증 E2E 테스트
//
// nativeProxy.mjs의 TEAMS_ROOT/TASKS_ROOT는 모듈 로드 시 homedir()로 고정되므로,
// 모든 테스트가 동일한 homeDir을 공유해야 team 파일시스템 경로가 일치한다.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHubHarness, createTeamFixture, readJson } from './helpers/hub-auth-harness.mjs';

const SHARED_HOME = mkdtempSync(join(tmpdir(), 'hub-auth-ep-'));

process.on('exit', () => {
  try { rmSync(SHARED_HOME, { recursive: true, force: true }); } catch {}
});

async function authFetch(baseUrl, path, { token, body, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('hub auth 다중 엔드포인트 E2E', () => {
  it('올바른 Bearer 토큰으로 register -> deregister 전체 흐름이 동작해야 한다', async () => {
    const token = 'endpoint-flow-token';
    const h = await createHubHarness({ token, homeDir: SHARED_HOME });
    const agentId = `flow-agent-${randomUUID().slice(0, 8)}`;

    try {
      // register
      const regRes = await authFetch(h.baseUrl, '/bridge/register', {
        token,
        body: { agent_id: agentId, cli: 'codex', timeout_sec: 60 },
      });
      assert.equal(regRes.status, 200);
      const regBody = await regRes.json();
      assert.equal(regBody.ok, true);

      // deregister
      const deregRes = await authFetch(h.baseUrl, '/bridge/deregister', {
        token,
        body: { agent_id: agentId },
      });
      assert.equal(deregRes.status, 200);
      const deregBody = await deregRes.json();
      assert.equal(deregBody.ok, true);
    } finally {
      await h.cleanup();
    }
  });

  it('올바른 Bearer 토큰으로 team task-update + send-message가 동작해야 한다', async () => {
    const token = 'team-ep-token';
    const h = await createHubHarness({ token, homeDir: SHARED_HOME });
    const teamName = `ep-team-${randomUUID().slice(0, 8)}`;
    const taskId = 'ep-task-1';
    const taskPath = createTeamFixture(h.homeDir, { teamName, taskId });

    try {
      // task-update (claim)
      const updateRes = await authFetch(h.baseUrl, '/bridge/team/task-update', {
        token,
        body: {
          team_name: teamName,
          task_id: taskId,
          claim: true,
          owner: 'test-worker',
          status: 'in_progress',
        },
      });
      assert.equal(updateRes.status, 200);
      const updateBody = await updateRes.json();
      assert.equal(updateBody.ok, true);

      // task 파일 상태 확인
      const task = readJson(taskPath);
      assert.equal(task.status, 'in_progress');
      assert.equal(task.owner, 'test-worker');

      // send-message
      const msgRes = await authFetch(h.baseUrl, '/bridge/team/send-message', {
        token,
        body: {
          team_name: teamName,
          from: 'test-worker',
          to: 'team-lead',
          text: 'task completed',
        },
      });
      assert.equal(msgRes.status, 200);
      const msgBody = await msgRes.json();
      assert.equal(msgBody.ok, true);
    } finally {
      await h.cleanup();
    }
  });

  it('토큰 설정 시 인증 없는 모든 보호된 bridge 엔드포인트가 401이어야 한다', async () => {
    const h = await createHubHarness({ token: 'block-all-token', homeDir: SHARED_HOME });

    try {
      const endpoints = [
        { path: '/bridge/register', body: { agent_id: 'x', cli: 'codex' } },
        { path: '/bridge/result', body: { agent_id: 'x' } },
        { path: '/bridge/control', body: { to_agent: 'x', command: 'stop' } },
        { path: '/bridge/status', body: { scope: 'hub' } },
        { path: '/bridge/context', body: { agent_id: 'x' } },
        { path: '/bridge/deregister', body: { agent_id: 'x' } },
        { path: '/bridge/team/info', body: { team_name: 'x' } },
        { path: '/bridge/team/task-list', body: { team_name: 'x' } },
        { path: '/bridge/team/task-update', body: { team_name: 'x', task_id: 'x' } },
        { path: '/bridge/team/send-message', body: { team_name: 'x', from: 'x', text: 'x' } },
        { path: '/bridge/pipeline/state', body: { team_name: 'x' } },
        { path: '/bridge/pipeline/advance', body: { team_name: 'x' } },
        { path: '/bridge/pipeline/init', body: { team_name: 'x' } },
        { path: '/bridge/pipeline/list', body: {} },
      ];

      // 모든 엔드포인트에 병렬 요청
      const results = await Promise.all(
        endpoints.map(async ({ path, body }) => {
          const res = await authFetch(h.baseUrl, path, { body }); // 토큰 없음
          return { path, status: res.status };
        }),
      );

      for (const { path, status } of results) {
        assert.equal(status, 401, `${path}: 인증 없이 401이어야 하는데 ${status} 반환`);
      }
    } finally {
      await h.cleanup();
    }
  });

  it('인증된 요청이지만 허용되지 않은 HTTP 메서드(GET)는 405이어야 한다', async () => {
    const token = 'method-check-token';
    const h = await createHubHarness({ token, homeDir: SHARED_HOME });

    try {
      const res = await fetch(`${h.baseUrl}/bridge/register`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 405);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, 'Method Not Allowed');
    } finally {
      await h.cleanup();
    }
  });
});
