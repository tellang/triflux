// hub/pipeline/index.mjs — 파이프라인 매니저
//
// 상태(state.mjs) + 전이(transitions.mjs) 통합 인터페이스

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { canTransition, transitionPhase, ralphRestart, TERMINAL } from './transitions.mjs';
import {
  ensurePipelineTable,
  initPipelineState,
  readPipelineState,
  updatePipelineState,
  removePipelineState,
} from './state.mjs';
import { runConfidenceCheck } from './gates/confidence.mjs';
import { runSelfCheck } from './gates/selfcheck.mjs';
import { classifyIntent as _classifyIntent } from '../intent.mjs';
// deslop gate: 호출자가 scanDirectory/detectSlop 결과를 전달

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
     * DAG 컨텍스트를 파이프라인 상태에 저장
     * @param {{ dag_width: number, levels: Record<number, string[]>, edges: Array<{from:string, to:string}>, max_complexity: string, taskResults: Record<string, *> }} dagContext
     */
    setDagContext(dagContext) {
      const current = readPipelineState(db, teamName);
      if (!current) return;
      const artifacts = { ...(current.artifacts || {}), dagContext };
      state = updatePipelineState(db, teamName, { artifacts });
    },

    /**
     * DAG 컨텍스트 조회 (편의 메서드)
     * @returns {{ dag_width: number, levels: Record<number, string[]>, edges: Array<{from:string, to:string}>, max_complexity: string, taskResults: Record<string, *> } | null}
     */
    getDagContext() {
      const current = readPipelineState(db, teamName) || state;
      return current?.artifacts?.dagContext || null;
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
     * Plan 파일을 .tfx/plans/{teamName}-plan.md 에 기록하고
     * artifact('plan_path')에 절대 경로를 저장한다.
     * @param {string} content - Plan markdown 내용
     * @returns {string} 절대 경로
     */
    writePlanFile(content) {
      const safeName = teamName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const planDir = resolve(process.cwd(), '.tfx', 'plans');
      mkdirSync(planDir, { recursive: true });
      const planPath = join(planDir, `${safeName}-plan.md`);
      writeFileSync(planPath, content, 'utf8');
      this.setArtifact('plan_path', planPath);
      return planPath;
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

    /**
     * Confidence Gate 실행 + 자동 전이
     * prd → confidence → exec/failed
     * @param {string|object} planArtifact
     * @param {object} context - { checks?, codebaseFiles?, existingTests? }
     * @returns {{ ok: boolean, gate: object, state?: object, error?: string }}
     */
    runConfidenceGate(planArtifact, context = {}) {
      const current = readPipelineState(db, teamName);
      if (!current) return { ok: false, error: `파이프라인 없음: ${teamName}` };

      if (current.phase !== 'confidence') {
        return { ok: false, error: `confidence gate는 confidence 단계에서만 실행 가능 (현재: ${current.phase})` };
      }

      const gate = runConfidenceCheck(planArtifact, context);
      this.setArtifact('confidence_result', gate);

      if (gate.decision === 'abort') {
        const result = this.advance('failed');
        return { ok: true, gate, state: result.state };
      }

      // proceed 또는 alternative → exec로 전이
      const result = this.advance('exec');
      return { ok: result.ok, gate, state: result.state, error: result.error };
    },

    /**
     * Deslop Gate 실행 + 자동 전이
     * exec → deslop → verify
     * 호출자가 미리 deslop 결과를 생성하여 전달.
     * @param {object} [deslopResult] - scanDirectory() 또는 detectSlop() 결과
     * @returns {{ ok: boolean, gate: object, state?: object, error?: string }}
     */
    runDeslopGate(deslopResult = null) {
      const current = readPipelineState(db, teamName);
      if (!current) return { ok: false, error: `파이프라인 없음: ${teamName}` };

      if (current.phase !== 'deslop') {
        return { ok: false, error: `deslop gate는 deslop 단계에서만 실행 가능 (현재: ${current.phase})` };
      }

      const gate = deslopResult || { files: [], summary: { total: 0, clean: 0 } };
      this.setArtifact('deslop_result', gate);

      // deslop은 항상 verify로 전이 (정보 제공 게이트, 차단 없음)
      const result = this.advance('verify');
      return { ok: result.ok, gate, state: result.state, error: result.error };
    },

    /**
     * Self-Check Gate 실행 + 자동 전이
     * verify → selfcheck → complete/fix
     * @param {string|object} execResult
     * @param {string|object} verifyResult
     * @param {object} requirements - { hasDiff?, evidence? }
     * @returns {{ ok: boolean, gate: object, state?: object, error?: string }}
     */
    runSelfCheckGate(execResult, verifyResult, requirements = {}) {
      const current = readPipelineState(db, teamName);
      if (!current) return { ok: false, error: `파이프라인 없음: ${teamName}` };

      if (current.phase !== 'selfcheck') {
        return { ok: false, error: `selfcheck gate는 selfcheck 단계에서만 실행 가능 (현재: ${current.phase})` };
      }

      const gate = runSelfCheck(execResult, verifyResult, requirements);
      this.setArtifact('selfcheck_result', gate);

      if (gate.passed) {
        const result = this.advance('complete');
        return { ok: result.ok, gate, state: result.state, error: result.error };
      }

      // Red Flag 탐지 또는 필수 질문 실패 → fix
      const result = this.advance('fix');
      return { ok: result.ok, gate, state: result.state, error: result.error };
    },
  };
}

// ── 토큰 벤치마크 훅 ──

let _tokenSnapshotMod = null;

async function loadTokenSnapshot() {
  if (_tokenSnapshotMod) return _tokenSnapshotMod;
  try {
    _tokenSnapshotMod = await import('../../scripts/token-snapshot.mjs');
  } catch {
    _tokenSnapshotMod = null;
  }
  return _tokenSnapshotMod;
}

/**
 * 파이프라인 시작 시 토큰 스냅샷 캡처
 * @param {string} label - 스냅샷 라벨 (e.g. teamName + timestamp)
 * @returns {Promise<{label: string, snapshot: object}|null>}
 */
export async function benchmarkStart(label) {
  const mod = await loadTokenSnapshot();
  if (!mod?.takeSnapshot) return null;
  try {
    const snapshot = mod.takeSnapshot(label);
    return { label, snapshot };
  } catch { return null; }
}

/**
 * 파이프라인 종료 시 diff 계산 + 결과 저장
 * @param {string} preLabel - 시작 스냅샷 라벨
 * @param {string} postLabel - 종료 스냅샷 라벨
 * @param {object} options - { agent?, cli?, id? }
 * @returns {Promise<object|null>} diff 결과
 */
export async function benchmarkEnd(preLabel, postLabel, options = {}) {
  const mod = await loadTokenSnapshot();
  if (!mod?.takeSnapshot || !mod?.computeDiff) return null;
  try {
    // 종료 스냅샷 캡처
    mod.takeSnapshot(postLabel);
    // diff 계산 (결과는 DIFFS_DIR에 자동 저장됨)
    const diff = mod.computeDiff(preLabel, postLabel, options);

    // 추가로 타임스탬프 기반 사본 저장
    const diffsDir = join(homedir(), '.omc', 'state', 'cx-auto-tokens', 'diffs');
    mkdirSync(diffsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = join(diffsDir, `${ts}.json`);
    writeFileSync(outPath, JSON.stringify(diff, null, 2));

    return diff;
  } catch { return null; }
}

/**
 * 트리아지 통합: quickClassify 고신뢰 시 Codex 분류 스킵 판정
 * @param {string} prompt
 * @param {number} [threshold=0.8]
 * @returns {{ skip: boolean, routing: object|null, classification: object }}
 */
export function triageWithIntent(prompt, threshold = 0.8) {
  const classification = _classifyIntent(prompt);
  if (classification.confidence >= threshold) {
    return { skip: true, routing: classification.routing, classification };
  }
  return { skip: false, routing: null, classification };
}

export { ensurePipelineTable } from './state.mjs';
export { PHASES, TERMINAL, ALLOWED, canTransition } from './transitions.mjs';
export { CRITERIA, runConfidenceCheck } from './gates/confidence.mjs';
export { RED_FLAGS, QUESTIONS, runSelfCheck } from './gates/selfcheck.mjs';
export { detectSlop, autoFixSlop, scanDirectory } from '../quality/deslop.mjs';
export { quickClassify, classifyIntent, INTENT_CATEGORIES } from '../intent.mjs';
