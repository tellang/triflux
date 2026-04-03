import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStoreAdapter } from '../../hub/store-adapter.mjs';

const TEMP_DIRS = [];

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'tfx-store-adapter-'));
  TEMP_DIRS.push(dir);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'store.db');
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    try { rmSync(TEMP_DIRS.pop(), { recursive: true, force: true }); } catch {}
  }
  mock.restoreAll();
});

function assertStoreInterface(store) {
  const methods = [
    'close',
    'registerAgent',
    'getAgent',
    'updateAgentStatus',
    'enqueueMessage',
    'getMessage',
    'createAssign',
    'getAssign',
    'updateAssignStatus',
    'listAssigns',
    'retryAssign',
    'insertHumanRequest',
    'getPendingHumanRequests',
    'moveToDeadLetter',
    'getDeadLetters',
    'addReflexion',
    'findReflexion',
    'updateReflexionHit',
    'onAssignStatusChange',
  ];

  for (const method of methods) {
    assert.equal(typeof store[method], 'function', `${method} should be a function`);
  }
}

describe('hub/store-adapter.mjs', () => {
  it('better-sqlite3가 있으면 sqlite store를 사용한다', async (t) => {
    const dbPath = tempDbPath();
    let sqliteCtor;
    try {
      const mod = await import('better-sqlite3');
      sqliteCtor = mod.default ?? mod;
    } catch {
      t.skip('better-sqlite3 unavailable in this environment');
      return;
    }

    const store = await createStoreAdapter(dbPath, {
      loadDatabase: async () => sqliteCtor,
    });

    try {
      assert.equal(store.type, 'sqlite');
      assertStoreInterface(store);
      const agent = store.registerAgent({
        agent_id: 'sqlite-agent',
        cli: 'codex',
        capabilities: ['code'],
        topics: ['task.result'],
        heartbeat_ttl_ms: 30000,
      });
      assert.equal(agent.agent_id, 'sqlite-agent');

      const message = store.enqueueMessage({
        type: 'event',
        from: 'sqlite-agent',
        to: 'sqlite-agent',
        topic: 'task.result',
        payload: { ok: true },
      });
      assert.deepEqual(store.getMessage(message.id)?.payload, { ok: true });
    } finally {
      store.close();
    }
  });

  it('better-sqlite3 로드 실패 시 memory fallback을 사용한다', async () => {
    const warnings = [];
    mock.method(console, 'warn', (message) => warnings.push(String(message)));

    const store = await createStoreAdapter(tempDbPath(), {
      loadDatabase: async () => {
        throw new Error('native build missing');
      },
    });

    assert.equal(store.type, 'memory');
    assertStoreInterface(store);
    assert.match(warnings[0] || '', /SQLite unavailable/i);

    const assignEvents = [];
    const detach = store.onAssignStatusChange((event) => assignEvents.push(event));

    const registered = store.registerAgent({
      agent_id: 'memory-agent',
      cli: 'other',
      capabilities: ['audit'],
      topics: ['audit.log'],
      heartbeat_ttl_ms: 60000,
    });
    assert.equal(registered.agent_id, 'memory-agent');
    assert.equal(store.getAgent('memory-agent')?.status, 'online');

    const message = store.enqueueMessage({
      type: 'event',
      from: 'lead',
      to: 'memory-agent',
      topic: 'audit.log',
      payload: { data: 1 },
    });
    assert.deepEqual(store.getMessage(message.id)?.payload, { data: 1 });

    const job = store.createAssign({
      supervisor_agent: 'lead',
      worker_agent: 'memory-agent',
      task: 'fallback works',
    });
    const done = store.updateAssignStatus(job.job_id, 'succeeded', {
      result: { ok: true },
    });

    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.result, { ok: true });
    assert.ok(assignEvents.some((event) => event.job_id === job.job_id));

    detach();
    store.close();
  });
});
