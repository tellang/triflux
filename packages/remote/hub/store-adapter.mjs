import { createStore, importBetterSqlite3 } from './store.mjs';
import {
  createMemoryStore,
  clone,
  buildAdaptiveRuleRow,
  normalizeAdaptiveRuleIdentity,
  clampConfidence,
  clampHitIncrement,
  coerceTimestamp,
  clampRetentionMs,
} from '@triflux/core/hub/lib/memory-store.mjs';

export { createMemoryStore };

function ensureAdaptiveRulesSchema(db) {
  const schemaKey = 'adaptive_rules_schema_version';
  const currentVersion = db.prepare('SELECT value FROM _meta WHERE key = ?').pluck().get(schemaKey);
  if (currentVersion === '1') return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS adaptive_rules (
      project_slug TEXT NOT NULL,
      pattern TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      hit_count INTEGER NOT NULL DEFAULT 1,
      last_seen_ms INTEGER NOT NULL,
      created_ms INTEGER NOT NULL,
      PRIMARY KEY (project_slug, pattern)
    );
    CREATE INDEX IF NOT EXISTS idx_adaptive_rules_last_seen
      ON adaptive_rules(project_slug, last_seen_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_adaptive_rules_confidence
      ON adaptive_rules(project_slug, confidence DESC);
  `);
  db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)').run(schemaKey, '1');
}

function attachAdaptiveRuleStore(store) {
  if (store.type !== 'sqlite' || !store.db) return store;
  ensureAdaptiveRulesSchema(store.db);
  const statements = {
    upsertRule: store.db.prepare(`
      INSERT INTO adaptive_rules (
        project_slug, pattern, confidence, hit_count, last_seen_ms, created_ms
      ) VALUES (
        @project_slug, @pattern, @confidence, @hit_count, @last_seen_ms, @created_ms
      )
      ON CONFLICT(project_slug, pattern) DO UPDATE SET
        confidence = excluded.confidence,
        hit_count = excluded.hit_count,
        last_seen_ms = excluded.last_seen_ms,
        created_ms = MIN(adaptive_rules.created_ms, excluded.created_ms)`),
    getRule: store.db.prepare('SELECT * FROM adaptive_rules WHERE project_slug = ? AND pattern = ?'),
    updateRule: store.db.prepare(`
      UPDATE adaptive_rules SET
        confidence = ?,
        hit_count = hit_count + ?,
        last_seen_ms = ?
      WHERE project_slug = ? AND pattern = ?`),
    pruneRules: store.db.prepare(`
      DELETE FROM adaptive_rules
      WHERE last_seen_ms < ? AND confidence < ?`),
  };

  store.addAdaptiveRule = function addAdaptiveRule(rule) {
    const next = buildAdaptiveRuleRow(rule);
    if (!next) return null;
    statements.upsertRule.run(next);
    return store.findAdaptiveRule(next.project_slug, next.pattern);
  };

  store.findAdaptiveRule = function findAdaptiveRule(projectSlug, pattern) {
    const identity = normalizeAdaptiveRuleIdentity(projectSlug, pattern);
    if (!identity) return null;
    return clone(statements.getRule.get(identity.project_slug, identity.pattern) || null);
  };

  store.updateRuleConfidence = function updateRuleConfidence(projectSlug, pattern, confidence, options = {}) {
    const current = store.findAdaptiveRule(projectSlug, pattern);
    if (!current) return null;
    const updatedAt = Math.max(current.last_seen_ms, coerceTimestamp(options.last_seen_ms, Date.now()));
    statements.updateRule.run(
      clampConfidence(confidence, current.confidence),
      clampHitIncrement(options.hit_count_increment, 1),
      updatedAt,
      current.project_slug,
      current.pattern,
    );
    return store.findAdaptiveRule(current.project_slug, current.pattern);
  };

  store.pruneStaleRules = function pruneStaleRules(maxAge_ms = 30 * 24 * 3600 * 1000, minConfidence = 0.2) {
    const cutoff = Date.now() - clampRetentionMs(maxAge_ms, 30 * 24 * 3600 * 1000);
    return statements.pruneRules.run(cutoff, minConfidence).changes;
  };

  // listAdaptiveRules: decayRules/getActiveAdaptiveRules에서 사용
  const listStmt = store.db.prepare('SELECT * FROM adaptive_rules WHERE project_slug = ? ORDER BY confidence DESC');
  const listAllStmt = store.db.prepare('SELECT * FROM adaptive_rules ORDER BY confidence DESC');
  const deleteRuleStmt = store.db.prepare('DELETE FROM adaptive_rules WHERE project_slug = ? AND pattern = ?');

  store.listAdaptiveRules = function listAdaptiveRules(projectSlug) {
    if (projectSlug) return listStmt.all(projectSlug).map(clone);
    return listAllStmt.all().map(clone);
  };

  store.deleteAdaptiveRule = function deleteAdaptiveRule(projectSlug, pattern) {
    return deleteRuleStmt.run(projectSlug, pattern).changes > 0;
  };

  return store;
}

/**
 * 환경에 따라 적절한 스토어 어댑터(SQLite 또는 인메모리)를 생성합니다.
 *
 * @param {string} dbPath - SQLite 데이터베이스 파일 경로
 * @param {object} [options] - 옵션
 * @param {Function} [options.loadDatabase] - 데이터베이스 로더 함수
 * @returns {Promise<object>} 생성된 스토어 어댑터
 */
export async function createStoreAdapter(dbPath, options = {}) {
  const loadDatabase = options.loadDatabase || importBetterSqlite3;
  try {
    const DatabaseCtor = await loadDatabase();
    const store = createStore(dbPath, { DatabaseCtor });
    store.type = 'sqlite';
    return attachAdaptiveRuleStore(store);
  } catch (error) {
    console.warn(`[store] SQLite unavailable (${error.message}), using in-memory fallback`);
    return createMemoryStore();
  }
}
