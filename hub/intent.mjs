// hub/intent.mjs — Intent Classification Engine
// 사용자 요청의 "진짜 의도"를 분석 → 카테고리 분류 → 최적 에이전트/모델 자동 선택

/** triflux 특화 의도 카테고리 (10개) */
export const INTENT_CATEGORIES = {
  implement:  { agent: 'executor',       mcp: 'implement', effort: 'high' },
  debug:      { agent: 'debugger',       mcp: 'implement', effort: 'high' },
  analyze:    { agent: 'analyst',        mcp: 'analyze',   effort: 'xhigh' },
  design:     { agent: 'architect',      mcp: 'analyze',   effort: 'xhigh' },
  review:     { agent: 'code-reviewer',  mcp: 'review',    effort: 'thorough' },
  document:   { agent: 'writer',         mcp: 'docs',      effort: 'pro' },
  research:   { agent: 'scientist',      mcp: 'analyze',   effort: 'high' },
  'quick-fix':{ agent: 'build-fixer',    mcp: 'implement', effort: 'fast' },
  explain:    { agent: 'writer',         mcp: 'docs',      effort: 'flash' },
  test:       { agent: 'test-engineer',  mcp: null,         effort: null },
};

/** @internal 키워드 → 카테고리 매핑 패턴 */
const KEYWORD_PATTERNS = [
  { category: 'implement', keywords: ['구현', '만들', '추가', '생성', '작성', '빌드', 'implement', 'create', 'add', 'build', 'make', 'develop'], weight: 1.0 },
  { category: 'debug',     keywords: ['버그', '에러', '오류', '고쳐', '수정', '디버그', 'fix', 'bug', 'error', 'debug', 'troubleshoot', 'crash', 'broken'], weight: 1.0 },
  { category: 'analyze',   keywords: ['분석', '조사', '파악', 'analyze', 'investigate', 'examine', 'inspect'], weight: 0.9 },
  { category: 'design',    keywords: ['설계', '아키텍처', '디자인', '구조', 'design', 'architect', 'structure'], weight: 0.9 },
  { category: 'review',    keywords: ['리뷰', '검토', '코드리뷰', 'review', 'code review', 'audit'], weight: 1.0 },
  { category: 'document',  keywords: ['문서', '도큐먼트', '문서화', 'document', 'docs', 'documentation', 'readme'], weight: 0.9 },
  { category: 'research',  keywords: ['리서치', '연구', '탐색', 'research', 'explore', 'study'], weight: 0.8 },
  { category: 'quick-fix', keywords: ['빠르게', '간단히', '급한', 'quick fix', 'hotfix', 'quick'], weight: 0.85 },
  { category: 'explain',   keywords: ['설명', '뭐야', '알려', '이해', 'explain', 'what is', 'how does', 'tell me', 'describe'], weight: 1.0 },
  { category: 'test',      keywords: ['테스트', '테스팅', '시험', '검증', 'test', 'testing', 'spec', 'unit test'], weight: 1.0 },
];

/**
 * 키워드 기반 빠른 분류 (0-cost, Codex 호출 없이)
 * 고신뢰(>0.8) 시 Codex triage 건너뜀
 * @param {string} prompt - 사용자 프롬프트
 * @returns {{ category: string, confidence: number }}
 */
export function quickClassify(prompt) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { category: 'implement', confidence: 0.1 };
  }

  const lower = prompt.toLowerCase().trim();
  let bestCategory = null;
  let bestScore = 0;

  for (const { category, keywords, weight } of KEYWORD_PATTERNS) {
    let matchCount = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) matchCount++;
    }
    if (matchCount > 0) {
      const score = (matchCount / keywords.length) * weight;
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }
  }

  if (!bestCategory) {
    return { category: 'implement', confidence: 0.3 };
  }

  // 매칭 품질 기반 신뢰도 (0.5~0.95 범위)
  const confidence = Math.min(0.95, 0.5 + bestScore * 0.5);
  return { category: bestCategory, confidence };
}

/**
 * 전체 의도 분류 — routing 정보 포함
 * @param {string} prompt
 * @returns {{ category: string, confidence: number, reasoning: string, routing: { agent: string, mcp: string|null, effort: string|null } }}
 */
export function classifyIntent(prompt) {
  const quick = quickClassify(prompt);
  const routing = INTENT_CATEGORIES[quick.category] || INTENT_CATEGORIES.implement;

  return {
    category: quick.category,
    confidence: quick.confidence,
    reasoning: `keyword-match: ${quick.category} (${quick.confidence.toFixed(2)})`,
    routing: {
      agent: routing.agent,
      mcp: routing.mcp,
      effort: routing.effort,
    },
  };
}

/**
 * 분류 히스토리 기반 학습 (reflexion 연동 가능)
 * @param {string} prompt
 * @param {string} actualCategory - 실제 카테고리
 */
export function refineClassification(prompt, actualCategory) {
  // reflexion 연동 시 store에 오분류 기록 저장 예정
  void prompt;
  void actualCategory;
}
