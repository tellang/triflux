// hub/routing/q-learning.mjs — 테이블 기반 Q-Learning 동적 라우팅
// agent-map.json 폴백을 유지하면서, 작업 결과 피드백으로 가중치를 학습한다.
// 외부 의존성 없음 (fs, path, crypto만 사용)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { scoreComplexity } from './complexity.mjs';

const _require = createRequire(import.meta.url);

/** agent-map.json 정적 매핑 (폴백용) */
let AGENT_MAP;
try {
  AGENT_MAP = _require('../team/agent-map.json');
} catch {
  AGENT_MAP = {};
}

/** 사용 가능한 CLI 액션 */
const ACTIONS = ['codex', 'gemini', 'claude', 'haiku', 'sonnet'];

/** 특성 벡터 키워드 (48차원, 에이전트 타입 기반) */
const FEATURE_KEYWORDS = [
  // 실행/구현 (codex 친화)
  'implement', 'execute', 'build', 'fix', 'debug', 'code', 'refactor', 'test',
  // 분석/설계 (claude/sonnet 친화)
  'analyze', 'architect', 'plan', 'review', 'security', 'optimize', 'research', 'evaluate',
  // 디자인/문서 (gemini 친화)
  'design', 'ui', 'ux', 'frontend', 'visual', 'document', 'write', 'explain',
  // 간단/빠른 (haiku 친화)
  'simple', 'quick', 'trivial', 'rename', 'format', 'lint', 'typo', 'minor',
  // 한국어 — 실행/구현 (codex 친화)
  '구현', '빌드', '수정', '디버깅', '리팩터링', '테스트',
  // 한국어 — 분석/설계 (claude/sonnet 친화)
  '분석', '아키텍처', '설계', '검토', '보안', '최적화',
  // 한국어 — 디자인/문서 (gemini 친화)
  '디자인', '문서화',
  // 한국어 — 간단/빠른 (haiku 친화)
  '간단', '사소한',
];

/**
 * 텍스트에서 48차원 특성 벡터 추출
 * 단어 경계를 기준으로 매칭하여 부분 문자열 오탐을 방지한다.
 * @param {string} text
 * @returns {number[]} 48-dim binary feature vector
 */
function extractFeatures(text) {
  const lower = text.toLowerCase();
  return FEATURE_KEYWORDS.map((kw) => {
    // 영문 단일 단어: 단어 경계(\b) 적용
    // 한국어 또는 다중 단어 구문: 공백/문장 경계 기반 포함 여부 확인
    if (/^[a-z]+$/.test(kw)) {
      return new RegExp(`\\b${kw}\\b`).test(lower) ? 1 : 0;
    }
    return lower.includes(kw) ? 1 : 0;
  });
}

/**
 * 특성 벡터를 상태 키로 변환 (해시 기반)
 * @param {number[]} features
 * @returns {string}
 */
function stateKey(features) {
  const hash = createHash('sha256').update(features.join(',')).digest('hex');
  return hash.slice(0, 16);
}

/**
 * LRU 캐시 (예측 결과 캐싱)
 */
class LRUCache {
  /** @param {number} maxSize @param {number} ttlMs */
  constructor(maxSize = 256, ttlMs = 5 * 60 * 1000) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    /** @type {Map<string, { value: *, ts: number }>} */
    this._cache = new Map();
  }

  get(key) {
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this._ttlMs) {
      this._cache.delete(key);
      return undefined;
    }
    // LRU: 다시 삽입하여 순서 갱신
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this._cache.has(key)) this._cache.delete(key);
    this._cache.set(key, { value, ts: Date.now() });
    // 초과 시 가장 오래된 항목 제거
    if (this._cache.size > this._maxSize) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  clear() {
    this._cache.clear();
  }
}

/**
 * Q-Learning 라우터
 * 테이블 기반 Q-Learning으로 작업→CLI 매핑을 학습한다.
 */
export class QLearningRouter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.learningRate=0.1] — 학습률 (alpha)
   * @param {number} [opts.discountFactor=0.9] — 할인율 (gamma)
   * @param {number} [opts.epsilon=0.3] — 탐색 확률 (epsilon-greedy)
   * @param {number} [opts.epsilonDecay=0.995] — 엡실론 감쇠율
   * @param {number} [opts.epsilonMin=0.05] — 최소 엡실론
   * @param {number} [opts.minConfidence=0.6] — 최소 신뢰도 (이하면 폴백)
   * @param {string} [opts.modelPath] — Q-table 영속화 경로
   */
  constructor(opts = {}) {
    this._lr = opts.learningRate ?? 0.1;
    this._gamma = opts.discountFactor ?? 0.9;
    this._epsilon = opts.epsilon ?? 0.3;
    this._epsilonDecay = opts.epsilonDecay ?? 0.995;
    // epsilon=0 시에도 최소 탐색 보장 (pure-exploit 방지)
    this._epsilonMin = opts.epsilonMin ?? Math.max(0.01, Math.min(0.05, this._epsilon));
    this._minConfidence = opts.minConfidence ?? 0.6;
    this._modelPath = opts.modelPath ?? join(homedir(), '.omc', 'routing-model.json');

    /** @type {Map<string, Map<string, number>>} state -> (action -> Q-value) */
    this._qTable = new Map();

    /** @type {Map<string, number>} state -> visit count */
    this._visitCounts = new Map();

    /** 총 업데이트 횟수 */
    this._totalUpdates = 0;

    /** 예측 캐시 */
    this._cache = new LRUCache(256, 5 * 60 * 1000);
  }

  /**
   * 상태에 대한 Q-values 조회 (없으면 초기화)
   * @param {string} state
   * @returns {Map<string, number>}
   */
  _getQValues(state) {
    if (!this._qTable.has(state)) {
      const qValues = new Map();
      for (const action of ACTIONS) {
        qValues.set(action, 0);
      }
      this._qTable.set(state, qValues);
    }
    return this._qTable.get(state);
  }

  /**
   * 작업 설명으로부터 최적 CLI 타입 예측
   * @param {string} taskDescription
   * @returns {{ action: string, confidence: number, exploration: boolean, complexity: number }}
   */
  predict(taskDescription) {
    const features = extractFeatures(taskDescription);
    const state = stateKey(features);

    // 캐시 확인
    const cached = this._cache.get(state);
    if (cached) return cached;

    const qValues = this._getQValues(state);
    const visits = this._visitCounts.get(state) || 0;

    // 엡실론-그리디: 탐색 vs 활용
    const isExploration = Math.random() < this._epsilon;

    let action;
    if (isExploration) {
      // 무작위 탐색
      action = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    } else {
      // 최적 액션 선택 (최대 Q-value)
      let maxQ = -Infinity;
      action = ACTIONS[0];
      for (const [a, q] of qValues) {
        if (q > maxQ) {
          maxQ = q;
          action = a;
        }
      }
    }

    // 신뢰도 계산: 방문 횟수 기반 (최소 10회 이상이면 안정)
    const confidence = visits >= 10
      ? Math.min(visits / 50, 1)
      : visits / 10;

    const { score: complexity } = scoreComplexity(taskDescription);

    const result = { action, confidence, exploration: isExploration, complexity };
    // 탐색(랜덤) 결과는 캐싱하지 않음 — 매번 새로운 랜덤 액션 생성
    if (!isExploration) this._cache.set(state, result);
    return result;
  }

  /**
   * Q-table 업데이트 (보상 피드백)
   * @param {string} taskDescription — 작업 설명
   * @param {string} action — 수행한 액션 (CLI 타입)
   * @param {number} reward — 보상 (-1 ~ 1)
   */
  update(taskDescription, action, reward) {
    if (!ACTIONS.includes(action)) return;

    const features = extractFeatures(taskDescription);
    const state = stateKey(features);
    const qValues = this._getQValues(state);
    const oldQ = qValues.get(action) || 0;

    // 최대 미래 Q-value (단일 상태이므로 현재 상태의 max)
    let maxFutureQ = -Infinity;
    for (const [, q] of qValues) {
      if (q > maxFutureQ) maxFutureQ = q;
    }

    // Q-Learning 업데이트: Q(s,a) = Q(s,a) + lr * (reward + gamma * max_Q(s') - Q(s,a))
    const newQ = oldQ + this._lr * (reward + this._gamma * maxFutureQ - oldQ);
    qValues.set(action, newQ);

    // 방문 횟수 증가
    this._visitCounts.set(state, (this._visitCounts.get(state) || 0) + 1);
    this._totalUpdates++;

    // 엡실론 감쇠
    this._epsilon = Math.max(this._epsilonMin, this._epsilon * this._epsilonDecay);

    // 캐시 무효화 (해당 상태)
    this._cache.clear();
  }

  /**
   * Q-table을 JSON 파일로 영속화
   */
  save() {
    const dir = join(this._modelPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = {
      version: 1,
      epsilon: this._epsilon,
      totalUpdates: this._totalUpdates,
      qTable: {},
      visitCounts: {},
    };

    for (const [state, qValues] of this._qTable) {
      data.qTable[state] = Object.fromEntries(qValues);
    }
    for (const [state, count] of this._visitCounts) {
      data.visitCounts[state] = count;
    }

    writeFileSync(this._modelPath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * 영속화된 Q-table 로드
   * @returns {boolean} 로드 성공 여부
   */
  load() {
    if (!existsSync(this._modelPath)) return false;

    try {
      const raw = readFileSync(this._modelPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.version !== 1) return false;

      this._epsilon = data.epsilon ?? this._epsilon;
      this._totalUpdates = data.totalUpdates ?? 0;
      this._qTable = new Map();
      this._visitCounts = new Map();

      for (const [state, qObj] of Object.entries(data.qTable || {})) {
        const qValues = new Map();
        for (const [action, q] of Object.entries(qObj)) {
          if (ACTIONS.includes(action)) qValues.set(action, q);
        }
        this._qTable.set(state, qValues);
      }
      for (const [state, count] of Object.entries(data.visitCounts || {})) {
        this._visitCounts.set(state, count);
      }

      this._cache.clear();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * agent-map.json 폴백 조회
   * @param {string} agentType — 에이전트 역할명
   * @returns {string} CLI 타입
   */
  static fallback(agentType) {
    return AGENT_MAP[agentType] || agentType;
  }

  /** 현재 엡실론 값 */
  get epsilon() {
    return this._epsilon;
  }

  /** 총 업데이트 횟수 */
  get totalUpdates() {
    return this._totalUpdates;
  }

  /** Q-table 상태 수 */
  get stateCount() {
    return this._qTable.size;
  }
}

// 모듈 레벨 export
export { ACTIONS, FEATURE_KEYWORDS, extractFeatures, stateKey, LRUCache };
