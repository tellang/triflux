import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStoreAdapter } from '../../hub/store-adapter.mjs';

const TEMP_DIRS = [];

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'tfx-store-adapter-tier2-'));
  TEMP_DIRS.push(dir);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'store.db');
}

function assertTier2Interface(store) {
  for (const method of ['addAdaptiveRule', 'findAdaptiveRule', 'updateRuleConfidence', 'pruneStaleRules']) {
    assert.equal(typeof store[method], 'function', `${method} should be a function`);
  }
}

async function createSqliteStore(t) {
  let sqliteCtor;
  try {
    const mod = await import('better-sqlite3');
    sqliteCtor = mod.default ?? mod;
  } catch {
    t.skip('better-sqlite3 unavailable in this environment');
    return null;
  }

  return createStoreAdapter(tempDbPath(), {
    loadDatabase: async () => sqliteCtor,
  });
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    try { rmSync(TEMP_DIRS.pop(), { recursive: true, force: true }); } catch {}
  }
  mock.restoreAll();
});

describe('hub/store-adapter.mjs tier2 adaptive rules', () => {
  it('sqlite store가 adaptive_rules CRUD를 제공한다', async (t) => {
    const store = await createSqliteStore(t);
    if (!store) return;

    try {
      assertTier2Interface(store);

      const added = store.addAdaptiveRule({
        project_slug: 'alpha',
        pattern: 'retry-throttle',
      });

      assert.deepEqual(added, {
        project_slug: 'alpha',
        pattern: 'retry-throttle',
        confidence: 0.5,
        hit_count: 1,
        last_seen_ms: added.last_seen_ms,
        created_ms: added.created_ms,
        error_message: null,
        solution: null,
        context: null,
      });
      assert.equal(store.db.prepare("SELECT value FROM _meta WHERE key = 'adaptive_rules_schema_version'").pluck().get(), '2');
      assert.deepEqual(store.findAdaptiveRule('alpha', 'retry-throttle'), added);

      const updated = store.updateRuleConfidence('alpha', 'retry-throttle', 0.9, {
        hit_count_increment: 2,
        last_seen_ms: added.last_seen_ms + 50,
      });

      assert.equal(updated.confidence, 0.9);
      assert.equal(updated.hit_count, 3);
      assert.equal(updated.last_seen_ms, added.last_seen_ms + 50);
      assert.equal(updated.created_ms, added.created_ms);

      store.addAdaptiveRule({
        project_slug: 'alpha',
        pattern: 'stale-low-confidence',
        confidence: 0.1,
        hit_count: 1,
        created_ms: Date.now() - 90 * 24 * 3600 * 1000,
        last_seen_ms: Date.now() - 90 * 24 * 3600 * 1000,
      });
      store.addAdaptiveRule({
        project_slug: 'alpha',
        pattern: 'recent-high-confidence',
        confidence: 0.8,
        hit_count: 4,
        created_ms: Date.now(),
        last_seen_ms: Date.now(),
      });

      const pruned = store.pruneStaleRules(30 * 24 * 3600 * 1000, 0.2);

      assert.equal(pruned, 1);
      assert.equal(store.findAdaptiveRule('alpha', 'stale-low-confidence'), null);
      assert.notEqual(store.findAdaptiveRule('alpha', 'recent-high-confidence'), null);
    } finally {
      store.close();
    }
  });

  it('memory fallback도 동일한 adaptive_rules 인터페이스를 유지한다', async () => {
    const warnings = [];
    mock.method(console, 'warn', (message) => warnings.push(String(message)));

    const store = await createStoreAdapter(tempDbPath(), {
      loadDatabase: async () => {
        throw new Error('sqlite missing');
      },
    });

    assert.equal(store.type, 'memory');
    assertTier2Interface(store);
    assert.match(warnings[0] || '', /SQLite unavailable/i);

    const added = store.addAdaptiveRule({
      project_slug: 'beta',
      pattern: 'memory-only',
      confidence: 0.3,
      hit_count: 2,
      created_ms: 100,
      last_seen_ms: 200,
    });

    assert.deepEqual(store.findAdaptiveRule('beta', 'memory-only'), added);

    const updated = store.updateRuleConfidence('beta', 'memory-only', 0.7, {
      hit_count_increment: 3,
      last_seen_ms: 500,
    });

    assert.equal(updated.confidence, 0.7);
    assert.equal(updated.hit_count, 5);
    assert.equal(updated.last_seen_ms, 500);

    store.addAdaptiveRule({
      project_slug: 'beta',
      pattern: 'old-low',
      confidence: 0.1,
      hit_count: 1,
      created_ms: Date.now() - 80 * 24 * 3600 * 1000,
      last_seen_ms: Date.now() - 80 * 24 * 3600 * 1000,
    });

    const pruned = store.pruneStaleRules(30 * 24 * 3600 * 1000, 0.2);
    assert.equal(pruned, 1);
    assert.equal(store.findAdaptiveRule('beta', 'old-low'), null);

    store.close();
  });
});
