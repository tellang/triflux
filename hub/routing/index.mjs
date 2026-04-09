// hub/routing/index.mjs — 통합 라우팅 진입점
// Q-Learning 동적 라우팅 + agent-map.json 정적 폴백
// 환경변수 TRIFLUX_DYNAMIC_ROUTING=true 로 옵트인 (기본 false)

import { createRequire } from "node:module";
import { scoreComplexity } from "./complexity.mjs";
import { QLearningRouter } from "./q-learning.mjs";

const _require = createRequire(import.meta.url);

/** agent-map.json 정적 매핑 */
let AGENT_MAP;
try {
  AGENT_MAP = _require("../team/agent-map.json");
} catch {
  AGENT_MAP = {};
}

/** 싱글턴 라우터 인스턴스 (lazy init) */
let _router = null;

/**
 * 라우터 인스턴스 획득 (lazy singleton)
 * @returns {QLearningRouter}
 */
function getRouter() {
  if (!_router) {
    _router = new QLearningRouter();
    _router.load();
  }
  return _router;
}

/**
 * 동적 라우팅 활성화 여부
 * @returns {boolean}
 */
function isDynamicRoutingEnabled() {
  const env = process.env.TRIFLUX_DYNAMIC_ROUTING;
  return env === "true" || env === "1";
}

/**
 * 통합 라우팅 결정
 * 우선순위: Q-Learning 예측 (신뢰도 >= 0.6) -> agent-map.json 기본값
 *
 * @param {string} agentType — 에이전트 역할명 ("executor", "designer" 등)
 * @param {string} [taskDescription=''] — 작업 설명 (동적 라우팅용)
 * @returns {{ cliType: string, source: 'dynamic' | 'static', confidence: number, complexity: number }}
 */
export function resolveRoute(agentType, taskDescription = "") {
  // 정적 기본값
  const staticCli = AGENT_MAP[agentType] || agentType;
  const { score: complexity } = scoreComplexity(taskDescription);

  // 동적 라우팅 비활성화 시 정적 매핑 반환
  if (!isDynamicRoutingEnabled()) {
    return { cliType: staticCli, source: "static", confidence: 1, complexity };
  }

  // 작업 설명 없으면 정적 폴백
  if (!taskDescription || taskDescription.trim().length === 0) {
    return { cliType: staticCli, source: "static", confidence: 1, complexity };
  }

  const router = getRouter();
  const prediction = router.predict(taskDescription);

  // 신뢰도 기준 미달 시 정적 폴백
  if (prediction.confidence < 0.6) {
    return {
      cliType: staticCli,
      source: "static",
      confidence: prediction.confidence,
      complexity,
    };
  }

  return {
    cliType: prediction.action,
    source: "dynamic",
    confidence: prediction.confidence,
    complexity,
  };
}

/**
 * 라우팅 피드백 업데이트
 * @param {string} taskDescription — 작업 설명
 * @param {string} action — 수행한 CLI 타입
 * @param {number} reward — 보상 (-1 ~ 1)
 * @param {boolean} [persist=true] — 영속화 여부
 */
export function updateRoute(taskDescription, action, reward, persist = true) {
  if (!isDynamicRoutingEnabled()) return;

  const router = getRouter();
  router.update(taskDescription, action, reward);
  if (persist) router.save();
}

/**
 * 라우터 상태 조회 (진단용)
 * @returns {{ enabled: boolean, epsilon: number, totalUpdates: number, stateCount: number }}
 */
export function routerStatus() {
  const enabled = isDynamicRoutingEnabled();
  if (!enabled) {
    return { enabled, epsilon: 0, totalUpdates: 0, stateCount: 0 };
  }
  const router = getRouter();
  return {
    enabled,
    epsilon: router.epsilon,
    totalUpdates: router.totalUpdates,
    stateCount: router.stateCount,
  };
}

// re-export for convenience
export { scoreComplexity } from "./complexity.mjs";
export { ACTIONS, QLearningRouter } from "./q-learning.mjs";
