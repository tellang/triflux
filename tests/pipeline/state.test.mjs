// tests/pipeline/state.test.mjs — SQLite 파이프라인 상태 관리 테스트
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  ensurePipelineTable,
  initPipelineState,
  readPipelineState,
  updatePipelineState,
  removePipelineState,
  listPipelineStates,
} from '../../hub/pipeline/state.mjs';

let db;
let dbPath;

beforeEach(() => {
  dbPath = join(tmpdir(), `tfx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  ensurePipelineTable(db);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
});

describe('ensurePipelineTable', () => {
  it('테이블 생성 (멱등)', () => {
    // 이미 beforeEach에서 생성됨 — 두 번 호출해도 에러 없음
    ensurePipelineTable(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_state'").all();
    assert.equal(tables.length, 1);
  });
});

describe('initPipelineState', () => {
  it('기본값으로 초기화', () => {
    const state = initPipelineState(db, 'test-team');
    assert.equal(state.team_name, 'test-team');
    assert.equal(state.phase, 'plan');
    assert.equal(state.fix_attempt, 0);
    assert.equal(state.fix_max, 3);
    assert.equal(state.ralph_iteration, 0);
    assert.equal(state.ralph_max, 10);
    assert.deepEqual(state.artifacts, {});
    assert.deepEqual(state.phase_history, []);
  });

  it('커스텀 옵션 적용', () => {
    const state = initPipelineState(db, 'custom-team', { fix_max: 5, ralph_max: 20 });
    assert.equal(state.fix_max, 5);
    assert.equal(state.ralph_max, 20);
  });

  it('기존 상태 덮어쓰기', () => {
    initPipelineState(db, 'overwrite-team');
    const state = initPipelineState(db, 'overwrite-team', { fix_max: 7 });
    assert.equal(state.fix_max, 7);
    assert.equal(state.phase, 'plan');
  });
});

describe('readPipelineState', () => {
  it('존재하는 팀 조회', () => {
    initPipelineState(db, 'read-team');
    const state = readPipelineState(db, 'read-team');
    assert.equal(state.team_name, 'read-team');
    assert.equal(state.phase, 'plan');
  });

  it('존재하지 않는 팀 → null', () => {
    const state = readPipelineState(db, 'nonexistent');
    assert.equal(state, null);
  });

  it('artifacts/phase_history JSON 파싱', () => {
    initPipelineState(db, 'json-team');
    updatePipelineState(db, 'json-team', {
      artifacts: { plan_path: '/tmp/plan.md' },
      phase_history: [{ from: 'plan', to: 'prd', at: 123 }],
    });
    const state = readPipelineState(db, 'json-team');
    assert.equal(state.artifacts.plan_path, '/tmp/plan.md');
    assert.equal(state.phase_history.length, 1);
  });
});

describe('updatePipelineState', () => {
  it('부분 패치 적용', () => {
    initPipelineState(db, 'patch-team');
    const updated = updatePipelineState(db, 'patch-team', { phase: 'exec', fix_attempt: 2 });
    assert.equal(updated.phase, 'exec');
    assert.equal(updated.fix_attempt, 2);
    assert.equal(updated.fix_max, 3); // 변경하지 않은 필드 유지
  });

  it('team_name 변경 불가', () => {
    initPipelineState(db, 'immutable-team');
    const updated = updatePipelineState(db, 'immutable-team', { team_name: 'hacked' });
    assert.equal(updated.team_name, 'immutable-team');
  });

  it('존재하지 않는 팀 → null', () => {
    const result = updatePipelineState(db, 'ghost', { phase: 'exec' });
    assert.equal(result, null);
  });
});

describe('removePipelineState', () => {
  it('삭제 성공', () => {
    initPipelineState(db, 'remove-team');
    assert.ok(removePipelineState(db, 'remove-team'));
    assert.equal(readPipelineState(db, 'remove-team'), null);
  });

  it('존재하지 않는 팀 삭제 → false', () => {
    assert.ok(!removePipelineState(db, 'no-team'));
  });
});

describe('listPipelineStates', () => {
  it('여러 팀 목록', () => {
    initPipelineState(db, 'team-a');
    initPipelineState(db, 'team-b');
    initPipelineState(db, 'team-c');
    const list = listPipelineStates(db);
    assert.equal(list.length, 3);
  });

  it('updated_at 내림차순 정렬', () => {
    initPipelineState(db, 'old-team');
    initPipelineState(db, 'new-team');
    // updatePipelineState는 항상 Date.now()를 사용하므로 직접 SQL로 차이 부여
    db.prepare("UPDATE pipeline_state SET updated_at = 1000 WHERE team_name = 'old-team'").run();
    db.prepare("UPDATE pipeline_state SET updated_at = 2000 WHERE team_name = 'new-team'").run();
    const list = listPipelineStates(db);
    assert.equal(list[0].team_name, 'new-team');
  });
});
