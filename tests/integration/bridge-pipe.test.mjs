// tests/integration/bridge-pipe.test.mjs — bridge.mjs pipe 우선 / HTTP fallback 테스트
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { startHub } from '../../hub/server.mjs';
import { initPipelineState } from '../../hub/pipeline/state.mjs';

const execFileAsync = promisify(execFile);

function tempDbPath() {
  const dir = join(tmpdir(), `tfx-bridge-pipe-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.db');
}

const TEST_PORT = 28200 + Math.floor(Math.random() * 100);

describe('bridge.mjs pipe-first', () => {
  let hub;
  let dbPath;
  let baseUrl;

  before(async () => {
    dbPath = tempDbPath();
    hub = await startHub({ port: TEST_PORT, dbPath, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  after(async () => {
    if (hub?.stop) await hub.stop();
    try { rmSync(join(dbPath, '..'), { recursive: true, force: true }); } catch {}
  });

  async function execBridge(args, env = {}) {
    const { stdout } = await execFileAsync(process.execPath, ['hub/bridge.mjs', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TFX_HUB_URL: baseUrl,
        TFX_HUB_TOKEN: hub?.hubToken,
        TFX_HUB_PIPE: hub?.pipe_path || hub?.pipePath,
        ...env,
      },
    });
    return JSON.parse(stdout.trim());
  }

  it('ping은 pipe 연결이 가능하면 pipe transport를 사용해야 한다', async () => {
    const result = await execBridge(['ping'], {
      TFX_HUB_PIPE: hub.pipePath,
      TFX_HUB_URL: baseUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'pipe');
  });

  it('pipe 실패 시 HTTP로 fallback 해야 한다', async () => {
    const result = await execBridge(['ping'], {
      TFX_HUB_PIPE: process.platform === 'win32' ? '\\.\\pipe\\missing-triflux-test' : '/tmp/missing-triflux-test.sock',
      TFX_HUB_URL: baseUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'http');
  });

  it('control은 HTTP가 죽어 있어도 pipe로 전달되어야 한다', async () => {
    const agentId = 'pipe-control-agent';
    await hub.pipe.executeCommand('register', {
      agent_id: agentId,
      cli: 'other',
      topics: ['lead.control'],
      capabilities: ['code'],
      heartbeat_ttl_ms: 60000,
    });

    const result = await execBridge([
      'control',
      '--from', 'team-lead',
      '--to', agentId,
      '--command', 'pause',
      '--reason', 'pipe-first-control',
      '--payload', '{"source":"bridge-test"}',
    ], {
      TFX_HUB_PIPE: hub.pipePath,
      TFX_HUB_URL: 'http://127.0.0.1:1',
    });

    assert.equal(result.ok, true);

    const drained = await hub.pipe.executeQuery('drain', {
      agent_id: agentId,
      max_messages: 5,
      auto_ack: true,
    });
    assert.equal(drained.ok, true);
    assert.equal(drained.data.messages.length, 1);
    assert.equal(drained.data.messages[0].payload.command, 'pause');
    assert.equal(drained.data.messages[0].payload.source, 'bridge-test');
  });

  it('pipeline-state는 HTTP가 죽어 있어도 pipe로 조회되어야 한다', async () => {
    const db = new Database(dbPath);
    initPipelineState(db, 'pipe-state-team');
    db.close();

    const result = await execBridge(['pipeline-state', '--team', 'pipe-state-team'], {
      TFX_HUB_PIPE: hub.pipePath,
      TFX_HUB_URL: 'http://127.0.0.1:1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.team_name, 'pipe-state-team');
    assert.equal(result.data.phase, 'plan');
  });

  it('pipeline-advance는 pipe 실패 시 HTTP fallback으로 성공해야 한다', async () => {
    const db = new Database(dbPath);
    initPipelineState(db, 'http-fallback-team');
    db.close();

    const result = await execBridge(['pipeline-advance', '--team', 'http-fallback-team', '--status', 'prd'], {
      TFX_HUB_PIPE: process.platform === 'win32' ? '\\.\\pipe\\missing-triflux-advance-test' : '/tmp/missing-triflux-advance-test.sock',
      TFX_HUB_URL: baseUrl,
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.phase, 'prd');
  });

  it('assign-status는 pipe 실패 시 HTTP fallback으로 성공해야 한다', async () => {
    const assigned = await hub.pipe.executeCommand('assign', {
      supervisor_agent: 'assign-lead',
      worker_agent: 'assign-worker',
      task: 'check status via http fallback',
    });
    assert.equal(assigned.ok, true);

    const result = await execBridge(['assign-status', '--job-id', assigned.data.job_id], {
      TFX_HUB_PIPE: process.platform === 'win32' ? '\\.\\pipe\\missing-triflux-assign-test' : '/tmp/missing-triflux-assign-test.sock',
      TFX_HUB_URL: baseUrl,
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.job_id, assigned.data.job_id);
    assert.equal(result.data.status, 'queued');
  });

  it('pipeline-init/list는 공통 transport helper를 통해 동작해야 한다', async () => {
    const initResult = await execBridge(['pipeline-init', '--team', 'pipeline-init-team', '--fix-max', '2', '--ralph-max', '3'], {
      TFX_HUB_PIPE: hub.pipePath,
      TFX_HUB_URL: 'http://127.0.0.1:1',
    });
    assert.equal(initResult.ok, true);
    assert.equal(initResult.data.team_name, 'pipeline-init-team');

    const listResult = await execBridge(['pipeline-list'], {
      TFX_HUB_PIPE: process.platform === 'win32' ? '\\.\\pipe\\missing-triflux-list-test' : '/tmp/missing-triflux-list-test.sock',
      TFX_HUB_URL: baseUrl,
    });
    assert.equal(listResult.ok, true);
    assert.ok(Array.isArray(listResult.data));
    assert.ok(listResult.data.some((state) => state.team_name === 'pipeline-init-team'));
  });

  it('context는 HTTP fallback에서도 pipe와 동일하게 drain semantics를 유지해야 한다', async () => {
    const agentId = 'http-context-agent';
    const outFile = join(tmpdir(), `tfx-bridge-context-${randomUUID()}.txt`);

    await hub.pipe.executeCommand('register', {
      agent_id: agentId,
      cli: 'other',
      topics: ['lead.control'],
      capabilities: ['code'],
      heartbeat_ttl_ms: 60000,
    });
    await hub.pipe.executeCommand('control', {
      from_agent: 'team-lead',
      to_agent: agentId,
      command: 'pause',
      reason: 'http-fallback-drain-check',
    });

    const first = await execBridge(['context', '--agent', agentId, '--out', outFile], {
      TFX_HUB_PIPE: process.platform === 'win32' ? '\\.\\pipe\\missing-triflux-context-test' : '/tmp/missing-triflux-context-test.sock',
      TFX_HUB_URL: baseUrl,
    });
    assert.equal(first.ok, true);
    assert.equal(first.count, 1);
    assert.match(readFileSync(outFile, 'utf8'), /pause/);

    const second = await execBridge(['context', '--agent', agentId, '--out', outFile], {
      TFX_HUB_PIPE: process.platform === 'win32' ? '\\.\\pipe\\missing-triflux-context-test' : '/tmp/missing-triflux-context-test.sock',
      TFX_HUB_URL: baseUrl,
    });
    assert.equal(second.ok, true);
    assert.equal(second.count, 0);
  });

  it('pipe 서버가 team_info query를 직접 처리해야 한다', async () => {
    const result = await hub.pipe.executeQuery('team_info', {
      team_name: 'bridge-pipe-nonexistent',
      include_members: true,
      include_paths: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TEAM_NOT_FOUND');
  });
});
