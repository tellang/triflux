// hub/pipeline/state.mjs — Hub SQLite 파이프라인 상태 저장/로드
//
// store.mjs의 기존 SQLite 연결(db)을 활용한다.
// pipeline_state 테이블은 schema.sql에 정의.

import { join } from 'node:path';

import { TFX_STATE_DIR, ensureTfxDirs } from '../paths.mjs';

/**
 * 파이프라인 상태 DB 경로를 계산한다.
 * @param {string} baseDir
 * @returns {string}
 */
export function getPipelineStateDbPath(baseDir) {
  return join(baseDir, TFX_STATE_DIR, 'state.db');
}

/**
 * 파이프라인 상태 DB 경로와 .tfx 디렉토리를 준비한다.
 * @param {string} baseDir
 * @returns {string}
 */
export function ensurePipelineStateDbPath(baseDir) {
  ensureTfxDirs(baseDir);
  return getPipelineStateDbPath(baseDir);
}

/**
 * pipeline_state 테이블 초기화 (store.db에 없으면 생성)
 * @param {object} db - better-sqlite3 인스턴스
 */
export function ensurePipelineTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_state (
      team_name TEXT PRIMARY KEY,
      phase TEXT NOT NULL DEFAULT 'plan',
      fix_attempt INTEGER DEFAULT 0,
      fix_max INTEGER DEFAULT 3,
      ralph_iteration INTEGER DEFAULT 0,
      ralph_max INTEGER DEFAULT 10,
      artifacts TEXT DEFAULT '{}',
      phase_history TEXT DEFAULT '[]',
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
}

const STATEMENTS = new WeakMap();

function getStatements(db) {
  let s = STATEMENTS.get(db);
  if (s) return s;

  s = {
    get: db.prepare('SELECT * FROM pipeline_state WHERE team_name = ?'),
    insert: db.prepare(`
      INSERT INTO pipeline_state (team_name, phase, fix_attempt, fix_max, ralph_iteration, ralph_max, artifacts, phase_history, created_at, updated_at)
      VALUES (@team_name, @phase, @fix_attempt, @fix_max, @ralph_iteration, @ralph_max, @artifacts, @phase_history, @created_at, @updated_at)
    `),
    update: db.prepare(`
      UPDATE pipeline_state SET
        phase = @phase,
        fix_attempt = @fix_attempt,
        fix_max = @fix_max,
        ralph_iteration = @ralph_iteration,
        ralph_max = @ralph_max,
        artifacts = @artifacts,
        phase_history = @phase_history,
        updated_at = @updated_at
      WHERE team_name = @team_name
    `),
    remove: db.prepare('DELETE FROM pipeline_state WHERE team_name = ?'),
    list: db.prepare('SELECT * FROM pipeline_state ORDER BY updated_at DESC'),
  };
  STATEMENTS.set(db, s);
  return s;
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    artifacts: JSON.parse(row.artifacts || '{}'),
    phase_history: JSON.parse(row.phase_history || '[]'),
  };
}

function serializeState(state) {
  return {
    team_name: state.team_name,
    phase: state.phase || 'plan',
    fix_attempt: state.fix_attempt ?? 0,
    fix_max: state.fix_max ?? 3,
    ralph_iteration: state.ralph_iteration ?? 0,
    ralph_max: state.ralph_max ?? 10,
    artifacts: JSON.stringify(state.artifacts || {}),
    phase_history: JSON.stringify(state.phase_history || []),
    created_at: state.created_at ?? Date.now(),
    updated_at: state.updated_at ?? Date.now(),
  };
}

/**
 * 파이프라인 상태 초기화 (새 파이프라인)
 * @param {object} db - better-sqlite3 인스턴스
 * @param {string} teamName
 * @param {object} opts - { fix_max?, ralph_max? }
 * @returns {object} 초기 상태
 */
export function initPipelineState(db, teamName, opts = {}) {
  return db.transaction(() => {
    const S = getStatements(db);
    const now = Date.now();
    const state = {
      team_name: teamName,
      phase: 'plan',
      fix_attempt: 0,
      fix_max: opts.fix_max ?? 3,
      ralph_iteration: 0,
      ralph_max: opts.ralph_max ?? 10,
      artifacts: {},
      phase_history: [],
      created_at: now,
      updated_at: now,
    };

    // 기존 상태가 있으면 삭제 후 재생성
    S.remove.run(teamName);
    S.insert.run(serializeState(state));
    return state;
  })();
}

/**
 * 파이프라인 상태 조회
 * @param {object} db - better-sqlite3 인스턴스
 * @param {string} teamName
 * @returns {object|null}
 */
export function readPipelineState(db, teamName) {
  const S = getStatements(db);
  return parseRow(S.get.get(teamName));
}

/**
 * 파이프라인 상태 업데이트 (부분 패치)
 * @param {object} db - better-sqlite3 인스턴스
 * @param {string} teamName
 * @param {object} patch - 업데이트할 필드
 * @returns {object|null} 업데이트된 상태
 */
export function updatePipelineState(db, teamName, patch) {
  return db.transaction(() => {
    const S = getStatements(db);
    const current = parseRow(S.get.get(teamName));
    if (!current) return null;

    const merged = {
      ...current,
      ...patch,
      team_name: teamName, // team_name 변경 불가
      updated_at: Date.now(),
    };

    S.update.run(serializeState(merged));
    return merged;
  })();
}

/**
 * 파이프라인 상태 삭제
 * @param {object} db - better-sqlite3 인스턴스
 * @param {string} teamName
 * @returns {boolean}
 */
export function removePipelineState(db, teamName) {
  const S = getStatements(db);
  return S.remove.run(teamName).changes > 0;
}

/**
 * 활성 파이프라인 목록
 * @param {object} db - better-sqlite3 인스턴스
 * @returns {object[]}
 */
export function listPipelineStates(db) {
  const S = getStatements(db);
  return S.list.all().map(parseRow);
}
