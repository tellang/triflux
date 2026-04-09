// hub/intent.mjs — Intent Classification Engine
// 사용자 요청의 "진짜 의도"를 분석 → 카테고리 분류 → 최적 에이전트/모델 자동 선택

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { whichCommand } from "./platform.mjs";

/** 캐시 엔트리: { category, confidence, ts } */
const _intentCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

/** codex 설치 여부 (프로세스당 1회 확인) */
let _codexAvailable = null;

/** @experimental 런타임 미연결 — 향후 통합 예정 */
function _isCodexAvailable() {
  if (_codexAvailable !== null) return _codexAvailable;
  _codexAvailable = Boolean(whichCommand("codex"));
  return _codexAvailable;
}

function _promptHash(prompt) {
  return crypto.createHash("md5").update(prompt).digest("hex");
}

function _getCached(hash) {
  const entry = _intentCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _intentCache.delete(hash);
    return null;
  }
  return entry;
}

function _tryCodexClassify(prompt) {
  try {
    const raw = execFileSync(
      "codex",
      ["exec", `Classify intent: ${prompt}. Reply JSON: {intent, confidence}`],
      { timeout: 8000, encoding: "utf8" },
    );
    // JSON 블록 추출 (응답에 다른 텍스트가 섞일 수 있음)
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const intent = typeof parsed.intent === "string" ? parsed.intent : null;
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : null;
    if (!intent || confidence === null) return null;
    // intent가 알려진 카테고리여야 함
    if (!INTENT_CATEGORIES[intent]) return null;
    return { category: intent, confidence };
  } catch {
    return null;
  }
}

/**
 * @experimental
 * triflux 특화 의도 카테고리 (10개)
 */
export const INTENT_CATEGORIES = {
  implement: { agent: "executor", mcp: "implement", effort: "codex53_high" },
  debug: { agent: "debugger", mcp: "implement", effort: "codex53_high" },
  analyze: { agent: "analyst", mcp: "analyze", effort: "gpt54_xhigh" },
  design: { agent: "architect", mcp: "analyze", effort: "gpt54_xhigh" },
  review: { agent: "code-reviewer", mcp: "review", effort: "codex53_high" },
  document: { agent: "writer", mcp: "docs", effort: "pro" },
  research: { agent: "scientist", mcp: "analyze", effort: "codex53_high" },
  "quick-fix": {
    agent: "build-fixer",
    mcp: "implement",
    effort: "codex53_low",
  },
  explain: { agent: "writer", mcp: "docs", effort: "flash" },
  test: { agent: "test-engineer", mcp: null, effort: null },
};

/** @internal 키워드 → 카테고리 매핑 패턴 */
const KEYWORD_PATTERNS = [
  {
    category: "implement",
    keywords: [
      "구현",
      "만들",
      "추가",
      "생성",
      "작성",
      "빌드",
      "implement",
      "create",
      "add",
      "build",
      "make",
      "develop",
    ],
    weight: 1.0,
  },
  {
    category: "debug",
    keywords: [
      "버그",
      "에러",
      "오류",
      "고쳐",
      "수정",
      "디버그",
      "fix",
      "bug",
      "error",
      "debug",
      "troubleshoot",
      "crash",
      "broken",
    ],
    weight: 1.0,
  },
  {
    category: "analyze",
    keywords: [
      "분석",
      "조사",
      "파악",
      "analyze",
      "investigate",
      "examine",
      "inspect",
    ],
    weight: 0.9,
  },
  {
    category: "design",
    keywords: [
      "설계",
      "아키텍처",
      "디자인",
      "구조",
      "design",
      "architect",
      "structure",
    ],
    weight: 0.9,
  },
  {
    category: "review",
    keywords: ["리뷰", "검토", "코드리뷰", "review", "code review", "audit"],
    weight: 1.0,
  },
  {
    category: "document",
    keywords: [
      "문서",
      "도큐먼트",
      "문서화",
      "document",
      "docs",
      "documentation",
      "readme",
    ],
    weight: 0.9,
  },
  {
    category: "research",
    keywords: ["리서치", "연구", "탐색", "research", "explore", "study"],
    weight: 0.8,
  },
  {
    category: "quick-fix",
    keywords: ["빠르게", "간단히", "급한", "quick fix", "hotfix", "quick"],
    weight: 0.85,
  },
  {
    category: "explain",
    keywords: [
      "설명",
      "뭐야",
      "알려",
      "이해",
      "explain",
      "what is",
      "how does",
      "tell me",
      "describe",
    ],
    weight: 1.0,
  },
  {
    category: "test",
    keywords: [
      "테스트",
      "테스팅",
      "시험",
      "검증",
      "test",
      "testing",
      "spec",
      "unit test",
    ],
    weight: 1.0,
  },
];

/**
 * 키워드 기반 빠른 분류 (0-cost, Codex 호출 없이)
 * 고신뢰(>0.8) 시 Codex triage 건너뜀
 * @param {string} prompt - 사용자 프롬프트
 * @returns {{ category: string, confidence: number }}
 */
export function quickClassify(prompt) {
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return { category: "implement", confidence: 0.1 };
  }

  const lower = prompt.toLowerCase().trim();
  let bestCategory = null;
  let bestScore = 0;
  let bestMatchCount = 0;

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
        bestMatchCount = matchCount;
      }
    }
  }

  if (!bestCategory) {
    return { category: "implement", confidence: 0.3 };
  }

  // 매칭 품질 기반 신뢰도 (0.5~0.95 범위) — matchCount 기준으로 정규화 (3개 매칭이면 최대)
  const confidence = Math.min(
    0.95,
    0.5 + (Math.min(bestMatchCount, 3) / 3) * 0.45,
  );
  return { category: bestCategory, confidence };
}

/**
 * 전체 의도 분류 — routing 정보 포함
 * Codex triage 경로: codex 설치 시 실행, confidence > 0.8이면 즉시 반환
 * quickClassify가 고신뢰(>0.8)이면 Codex 건너뜀
 * 결과는 md5 해시 기반 Map에 5분 TTL로 캐싱
 * @param {string} prompt
 * @returns {{ category: string, confidence: number, reasoning: string, routing: { agent: string, mcp: string|null, effort: string|null } }}
 */
export function classifyIntent(prompt) {
  const hash = _promptHash(String(prompt ?? ""));

  // 캐시 확인
  const cached = _getCached(hash);
  if (cached) {
    const routing =
      INTENT_CATEGORIES[cached.category] || INTENT_CATEGORIES.implement;
    return {
      category: cached.category,
      confidence: cached.confidence,
      reasoning: `cache-hit: ${cached.category} (${cached.confidence.toFixed(2)})`,
      routing: {
        agent: routing.agent,
        mcp: routing.mcp,
        effort: routing.effort,
      },
    };
  }

  // quickClassify 먼저
  const quick = quickClassify(prompt);

  let category = quick.category;
  let confidence = quick.confidence;
  let reasoning;

  // quickClassify가 고신뢰(>0.8)이면 Codex 건너뜀
  if (quick.confidence > 0.8) {
    reasoning = `keyword-match: ${category} (${confidence.toFixed(2)})`;
  } else if (_isCodexAvailable()) {
    // Codex triage
    const codexResult = _tryCodexClassify(String(prompt ?? ""));
    if (codexResult && codexResult.confidence > 0.8) {
      category = codexResult.category;
      confidence = codexResult.confidence;
      reasoning = `codex-triage: ${category} (${confidence.toFixed(2)})`;
    } else {
      reasoning = `keyword-match(codex-fallback): ${category} (${confidence.toFixed(2)})`;
    }
  } else {
    reasoning = `keyword-match: ${category} (${confidence.toFixed(2)})`;
  }

  // 캐시 저장
  _intentCache.set(hash, { category, confidence, ts: Date.now() });

  const routing = INTENT_CATEGORIES[category] || INTENT_CATEGORIES.implement;
  return {
    category,
    confidence,
    reasoning,
    routing: { agent: routing.agent, mcp: routing.mcp, effort: routing.effort },
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
