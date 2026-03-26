// hub/pipeline/transitions.mjs — 파이프라인 단계 전이 규칙
//
// plan → prd → confidence → exec → deslop → verify → selfcheck → complete/fix
// fix → exec/verify/complete/failed
// complete, failed = 터미널 상태

export const PHASES = [
  'plan', 'prd', 'confidence', 'exec', 'deslop', 'verify', 'selfcheck',
  'fix', 'complete', 'failed',
];

export const TERMINAL = new Set(['complete', 'failed']);

export const ALLOWED = {
  'plan':       ['prd'],
  'prd':        ['confidence'],
  'confidence': ['exec', 'failed'],
  'exec':       ['deslop'],
  'deslop':     ['verify'],
  'verify':     ['selfcheck', 'fix', 'failed'],
  'selfcheck':  ['complete', 'fix'],
  'fix':        ['exec', 'verify', 'complete', 'failed'],
  'complete':   [],
  'failed':     [],
};

/**
 * 전이 가능 여부 확인
 * @param {string} from - 현재 단계
 * @param {string} to - 다음 단계
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const targets = ALLOWED[from];
  if (!targets) return false;
  return targets.includes(to);
}

/**
 * 상태 전이 실행 — fix loop 바운딩 포함
 * @param {object} state - 파이프라인 상태 객체
 * @param {string} nextPhase - 다음 단계
 * @returns {{ ok: boolean, state?: object, error?: string }}
 */
export function transitionPhase(state, nextPhase) {
  const current = state.phase;

  if (!canTransition(current, nextPhase)) {
    return {
      ok: false,
      error: `전이 불가: ${current} → ${nextPhase}. 허용: [${(ALLOWED[current] || []).join(', ')}]`,
    };
  }

  const next = { ...state, phase: nextPhase, updated_at: Date.now() };

  // fix 단계 진입 시 attempt 증가 + 바운딩
  if (nextPhase === 'fix') {
    next.fix_attempt = (state.fix_attempt || 0) + 1;
    if (next.fix_attempt > (state.fix_max || 3)) {
      return {
        ok: false,
        error: `fix loop 초과: ${state.fix_max || 3}회 도달`,
      };
    }
  }

  // fix → exec 재진입 시 (fix 후 재실행)
  if (current === 'fix' && nextPhase === 'exec') {
    // fix_attempt 유지 (이미 fix 진입 시 증가됨)
  }

  // verify → fix → ... → verify 반복 후 fix_max 초과 시 ralph loop
  if (nextPhase === 'failed' && current === 'fix') {
    // ralph loop 반복 증가
    next.ralph_iteration = (state.ralph_iteration || 0) + 1;
    if (next.ralph_iteration > (state.ralph_max || 10)) {
      // 최종 실패 — ralph loop도 초과
      next.phase = 'failed';
    }
  }

  // phase_history 기록
  const history = Array.isArray(state.phase_history) ? [...state.phase_history] : [];
  history.push({ from: current, to: nextPhase, at: Date.now() });
  next.phase_history = history;

  return { ok: true, state: next };
}

/**
 * ralph loop 재시작 전이
 * fix_max 초과 시 plan으로 돌아가며 ralph_iteration 증가
 * @param {object} state - 현재 상태
 * @returns {{ ok: boolean, state?: object, error?: string }}
 */
export function ralphRestart(state) {
  if (TERMINAL.has(state.phase)) {
    return { ok: false, error: '터미널 상태에서 재시작 불가' };
  }

  const iteration = (state.ralph_iteration || 0) + 1;
  if (iteration > (state.ralph_max || 10)) {
    return {
      ok: false,
      error: `ralph loop 초과: ${iteration}/${state.ralph_max || 10}회. 최종 실패.`,
    };
  }

  const history = Array.isArray(state.phase_history) ? [...state.phase_history] : [];
  history.push({ from: state.phase, to: 'plan', at: Date.now(), ralph_restart: true });

  return {
    ok: true,
    state: {
      ...state,
      phase: 'plan',
      fix_attempt: 0,
      ralph_iteration: iteration,
      phase_history: history,
      updated_at: Date.now(),
    },
  };
}
