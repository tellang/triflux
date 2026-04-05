// hub/pipeline/gates/consensus.mjs — Consensus Quality Gate
//
// N개 결과의 합의도를 평가하여 5단계 분기 결정
// proceed(>=90%) / proceed_warn(>=75%) / retry(<75%+재시도) / escalate(<75%+감독) / abort

/** 단계별 합의 임계값 (%) */
export const STAGE_THRESHOLDS = {
  plan: 50,
  define: 75,
  execute: 75,
  verify: 80,
  security: 100,
};

/** 환경변수 기반 기본 임계값 (기본 75) */
function getDefaultThreshold() {
  const env = typeof process !== 'undefined' && process.env?.TRIFLUX_CONSENSUS_THRESHOLD;
  if (env != null && env !== '') {
    const parsed = Number(env);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) return parsed;
  }
  return 75;
}

/**
 * 성공률 기반 5단계 분기 결정
 * @param {number} successRate - 합의 성공률 (0-100)
 * @param {number} retryCount - 현재 재시도 횟수
 * @param {number} maxRetries - 최대 재시도 횟수
 * @param {string} [mode] - 실행 모드 ('supervised' | 기타)
 * @returns {'proceed' | 'proceed_warn' | 'retry' | 'escalate' | 'abort'}
 */
export function evaluateQualityBranch(successRate, retryCount, maxRetries, mode) {
  if (successRate >= 90) return 'proceed';
  if (successRate >= 75) return 'proceed_warn';

  // <75%: 재시도 가능 여부에 따라 분기
  if (retryCount < maxRetries) return 'retry';
  if (mode === 'supervised') return 'escalate';
  return 'abort';
}

/**
 * N개 결과의 합의도 평가
 * @param {Array<{ success: boolean }>} results - 평가 대상 결과 배열
 * @param {object} [options]
 * @param {string} [options.stage] - 파이프라인 단계 (STAGE_THRESHOLDS 키)
 * @param {number} [options.threshold] - 합의 임계값 직접 지정 (stage보다 우선)
 * @param {number} [options.retryCount=0] - 현재 재시도 횟수
 * @param {number} [options.maxRetries=2] - 최대 재시도 횟수
 * @param {string} [options.mode] - 실행 모드 ('supervised' 등)
 * @returns {{ successRate: number, threshold: number, decision: string, reasoning: string, results: Array }}
 */
export function evaluateConsensus(results, options = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      successRate: 0,
      threshold: options.threshold ?? getDefaultThreshold(),
      decision: 'abort',
      reasoning: '평가 대상 결과가 없습니다.',
      results: [],
    };
  }

  const retryCount = options.retryCount ?? 0;
  const maxRetries = options.maxRetries ?? 2;
  const mode = options.mode;

  // 임계값 결정: 직접 지정 > stage별 > 환경변수 > 기본 75
  const threshold = options.threshold
    ?? (options.stage && STAGE_THRESHOLDS[options.stage])
    ?? getDefaultThreshold();

  const successCount = results.filter(r => r.success).length;
  const successRate = Math.round((successCount / results.length) * 100);

  const decision = evaluateQualityBranch(successRate, retryCount, maxRetries, mode);

  const reasoningMap = {
    proceed: `합의율 ${successRate}% (>= 90%): 전원 합의. 진행.`,
    proceed_warn: `합의율 ${successRate}% (>= 75%): 부분 합의. 경고와 함께 진행.`,
    retry: `합의율 ${successRate}% (< 75%): 재시도 ${retryCount + 1}/${maxRetries} 가능.`,
    escalate: `합의율 ${successRate}% (< 75%): 감독 모드 에스컬레이션.`,
    abort: `합의율 ${successRate}% (< 75%): 합의 실패. 중단.`,
  };

  return {
    successRate,
    threshold,
    decision,
    reasoning: reasoningMap[decision],
    results,
  };
}
