// hub/pipeline/index.mjs — 파이프라인 매니저
//
// 상태(state.mjs) + 전이(transitions.mjs) 통합 인터페이스

import { canTransition, transitionPhase, ralphRestart, TERMINAL } from './transitions.mjs';
import {
  ensurePipelineTable,
  initPipelineState,
  readPipelineState,
  updatePipelineState,
  removePipelineState,
} from './state.mjs';

/**
 * 파이프라인 매니저 생성
 * @param {object} db - better-sqlite3 인스턴스 (store.db)
 * @param {string} teamName
 * @param {object} opts - { fix_max?, ralph_max? }
 * @returns {object} 파이프라인 API
 */
export function createPipeline(db, teamName, opts = {}) {
  ensurePipelineTable(db);

  // 기존 상태가 있으면 로드, 없으면 초기화
  let state = readPipelineState(db, teamName);
  if (!state) {
    state = initPipelineState(db, teamName, opts);
  }

  return {
    /**
     * 현재 상태 조회
     */
    getState() {
      state = readPipelineState(db, teamName) || state;
      return { ...state };
    },

    /**
     * 다음 단계로 전이 가능 여부
     * @param {string} phase
     */
    canAdvance(phase) {
      const current = readPipelineState(db, teamName);
      return current ? canTransition(current.phase, phase) : false;
    },

    /**
     * 다음 단계로 전이
     * @param {string} nextPhase
     * @returns {{ ok: boolean, state?: object, error?: string }}
     */
    advance(nextPhase) {
      const current = readPipelineState(db, teamName);
      if (!current) {
        return { ok: false, error: `파이프라인 없음: ${teamName}` };
      }

      const result = transitionPhase(current, nextPhase);
      if (!result.ok) return result;

      state = updatePipelineState(db, teamName, result.state);
      return { ok: true, state: { ...state } };
    },

    /**
     * ralph loop 재시작 (plan부터 다시)
     * @returns {{ ok: boolean, state?: object, error?: string }}
     */
    restart() {
      const current = readPipelineState(db, teamName);
      if (!current) {
        return { ok: false, error: `파이프라인 없음: ${teamName}` };
      }

      const result = ralphRestart(current);
      if (!result.ok) return result;

      state = updatePipelineState(db, teamName, result.state);
      return { ok: true, state: { ...state } };
    },

    /**
     * artifact 저장 (plan_path, prd_path, verify_report 등)
     * @param {string} key
     * @param {*} value
     */
    setArtifact(key, value) {
      const current = readPipelineState(db, teamName);
      if (!current) return;
      const artifacts = { ...(current.artifacts || {}), [key]: value };
      state = updatePipelineState(db, teamName, { artifacts });
    },

    /**
     * 터미널 상태 여부
     */
    isTerminal() {
      const current = readPipelineState(db, teamName);
      return current ? TERMINAL.has(current.phase) : true;
    },

    /**
     * 파이프라인 초기화 (리셋)
     */
    reset() {
      state = initPipelineState(db, teamName, opts);
      return { ...state };
    },

    /**
     * 파이프라인 삭제
     */
    remove() {
      return removePipelineState(db, teamName);
    },
  };
}

export { ensurePipelineTable } from './state.mjs';
export { PHASES, TERMINAL, ALLOWED, canTransition } from './transitions.mjs';
