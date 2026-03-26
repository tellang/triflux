// tests/unit/reflexion.test.mjs — reflexion 에러 학습 엔진 테스트
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createStore } from '../../hub/store.mjs';
import {
  normalizeError,
  lookupSolution,
  learnFromError,
  reportOutcome,
  recalcConfidence,
} from '../../hub/reflexion.mjs';

describe('reflexion', () => {
  let store, tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reflexion-test-'));
    store = createStore(join(tmpDir, 'test.db'));
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. normalizeError: 파일 경로 → <FILE> 치환
  it('normalizeError replaces file paths with <FILE>', () => {
    const msg = 'Error in C:\\Users\\dev\\project\\src\\index.js at runtime';
    const norm = normalizeError(msg);
    assert.ok(norm.includes('<file>'), `Expected <file> in: ${norm}`);
    assert.ok(!norm.includes('index.js'), 'File name should be replaced');
  });

  // 2. normalizeError: 줄 번호/UUID/숫자 치환
  it('normalizeError replaces line numbers, UUIDs, and large numbers', () => {
    const msg = 'Error at line 42: 550e8400-e29b-41d4-a716-446655440000 failed with code 123456';
    const norm = normalizeError(msg);
    assert.ok(norm.includes('<line>'), `Expected <line> in: ${norm}`);
    assert.ok(norm.includes('<id>'), `Expected <id> in: ${norm}`);
    assert.ok(norm.includes('<num>'), `Expected <num> in: ${norm}`);
  });

  // 3. learnFromError: 새 에러 저장 → id 반환
  it('learnFromError stores new error and returns entry with id', () => {
    const entry = learnFromError(store, {
      error: 'TypeError: Cannot read property "foo" of undefined',
      solution: 'Check for null before accessing property',
      context: { file: 'app.js', agent: 'executor' },
    });
    assert.ok(entry, 'Entry should be created');
    assert.ok(entry.id, 'Entry should have an id');
    assert.equal(entry.solution, 'Check for null before accessing property');
    assert.equal(entry.hit_count, 1);
    assert.equal(entry.confidence, 0.5);
  });

  // 4. lookupSolution: 동일 패턴 매칭 → found: true
  it('lookupSolution finds matching pattern', () => {
    // 동일 에러 (파일/줄만 다름) → 같은 정규화 패턴으로 매칭
    const result = lookupSolution(store, 'TypeError: Cannot read property "foo" of undefined');
    assert.equal(result.found, true, 'Should find matching pattern');
    assert.ok(result.bestMatch, 'Should have best match');
    assert.ok(result.entries.length > 0, 'Should have entries');
  });

  // 5. lookupSolution: 유사하지 않은 에러 → found: false
  it('lookupSolution returns found:false for unrelated errors', () => {
    const result = lookupSolution(store, 'ECONNREFUSED: connection refused');
    assert.equal(result.found, false);
    assert.equal(result.entries.length, 0);
    assert.equal(result.bestMatch, null);
  });

  // 6. updateReflexionHit: hit_count 증가 + success 시 success_count 증가
  it('updateReflexionHit increments hit_count and success_count', () => {
    const entry = store.addReflexion({
      error_pattern: 'test-hit-update',
      error_message: 'test error',
      solution: 'test solution',
    });
    assert.equal(entry.hit_count, 1);
    assert.equal(entry.success_count, 0);

    const updated = store.updateReflexionHit(entry.id, true);
    assert.equal(updated.hit_count, 2);
    assert.equal(updated.success_count, 1);

    const updated2 = store.updateReflexionHit(entry.id, false);
    assert.equal(updated2.hit_count, 3);
    assert.equal(updated2.success_count, 1);
  });

  // 7. recalcConfidence: success/hit 비율 기반 계산
  it('recalcConfidence calculates based on success/hit ratio with decay', () => {
    const conf = recalcConfidence({ hit_count: 10, success_count: 8 });
    // decay = min(1, 10/10) = 1.0, ratio = 0.8 → 0.8*1 + 0.5*0 = 0.8
    assert.equal(conf, 0.8);

    const confLow = recalcConfidence({ hit_count: 2, success_count: 2 });
    // decay = min(1, 2/10) = 0.2, ratio = 1.0 → 1.0*0.2 + 0.5*0.8 = 0.6
    assert.ok(Math.abs(confLow - 0.6) < 0.001, `Expected ~0.6, got ${confLow}`);
  });

  // 8. recalcConfidence: 0회 hit → 기본 0.5
  it('recalcConfidence returns 0.5 for zero hits', () => {
    assert.equal(recalcConfidence({ hit_count: 0, success_count: 0 }), 0.5);
    assert.equal(recalcConfidence(null), 0.5);
    assert.equal(recalcConfidence(undefined), 0.5);
    assert.equal(recalcConfidence({ hit_count: -1, success_count: 0 }), 0.5);
  });

  // 9. pruneReflexion: 오래된 + 낮은 confidence 항목 삭제
  it('pruneReflexion removes old low-confidence entries', () => {
    // 직접 DB에 오래된 항목 삽입
    const oldEntry = store.addReflexion({
      error_pattern: 'prune-test-old',
      error_message: 'old error',
      solution: 'old solution',
    });
    // confidence를 낮게 설정 (recalcConfidence decay: 10회 실패 → conf=0)
    for (let i = 0; i < 9; i++) store.updateReflexionHit(oldEntry.id, false);
    // hit_count=10, success_count=0 → decay=1.0 → recalcConfidence=0

    // updated_at_ms를 강제로 과거로 수정
    store.db.prepare('UPDATE reflexion_entries SET updated_at_ms = ? WHERE id = ?')
      .run(Date.now() - 60 * 24 * 3600 * 1000, oldEntry.id); // 60일 전

    const pruned = store.pruneReflexion(30 * 24 * 3600 * 1000, 0.2);
    assert.ok(pruned >= 1, `Expected at least 1 pruned, got ${pruned}`);

    const after = store.getReflexion(oldEntry.id);
    assert.equal(after, null, 'Pruned entry should be gone');
  });

  // 10. 전체 흐름: learn → lookup → report → confidence 변화
  it('full flow: learn → lookup → report → confidence changes', () => {
    const error = 'SyntaxError: Unexpected token } in /src/parser.js:99:5';
    const solution = 'Missing comma before closing brace';

    // learn
    const entry = learnFromError(store, { error, solution });
    assert.ok(entry);
    assert.equal(entry.confidence, 0.5);

    // lookup
    const lookup = lookupSolution(store, error);
    assert.equal(lookup.found, true);
    assert.equal(lookup.bestMatch.id, entry.id);

    // report success
    const after1 = reportOutcome(store, entry.id, true);
    assert.equal(after1.hit_count, 2);
    assert.equal(after1.success_count, 1);
    assert.equal(after1.confidence, 0.5); // 1/2 = 0.5

    // report another success
    const after2 = reportOutcome(store, entry.id, true);
    assert.equal(after2.hit_count, 3);
    assert.equal(after2.success_count, 2);
    // confidence should increase: 2/3 ≈ 0.667
    assert.ok(after2.confidence > 0.5, `Confidence should increase: ${after2.confidence}`);
  });

  // 11. normalizeError: 빈 입력 처리
  it('normalizeError returns empty string for invalid input', () => {
    assert.equal(normalizeError(''), '');
    assert.equal(normalizeError(null), '');
    assert.equal(normalizeError(undefined), '');
    assert.equal(normalizeError(42), '');
  });

  // 12. learnFromError: 동일 패턴 재학습 시 기존 엔트리 업데이트
  it('learnFromError updates existing entry for same pattern', () => {
    const error = 'ReferenceError: x is not defined at /unique/path.js:10';
    const entry1 = learnFromError(store, { error, solution: 'Define x' });
    const entry2 = learnFromError(store, { error, solution: 'Define x', success: true });
    // 동일 패턴이므로 같은 id, hit_count 증가
    assert.equal(entry2.id, entry1.id);
    assert.equal(entry2.hit_count, 2);
  });
});
