// hub/routing/complexity.mjs — 작업 복잡도 스코어링
// 작업 설명 텍스트에서 복잡도를 0-1 범위로 계산한다.
// 외부 의존성 없음 (순수 텍스트 분석)

/**
 * 복잡도 지표 키워드 사전
 * 카테고리별 키워드와 가중치 (0-1)
 */
const COMPLEXITY_INDICATORS = {
  // 높은 복잡도 (0.7-1.0)
  high: {
    keywords: [
      'refactor', 'architecture', 'security', 'migration', 'distributed',
      'concurrent', 'parallel', 'optimization', 'performance', 'scalability',
      'cryptograph', 'encryption', 'authentication', 'authorization',
      'database schema', 'data model', 'state machine', 'event-driven',
      'microservice', 'orchestrat', 'pipeline', 'workflow',
      // 한국어
      '리팩터링', '리팩토링', '아키텍처', '보안', '마이그레이션', '분산',
      '동시성', '병렬', '최적화', '성능', '확장성',
      '암호화', '인증', '인가', '데이터베이스 스키마', '데이터 모델',
      '상태 머신', '이벤트 드리븐', '마이크로서비스', '오케스트레이션',
    ],
    weight: 0.85,
  },
  // 중간 복잡도 (0.4-0.7)
  medium: {
    keywords: [
      'implement', 'integrate', 'api', 'endpoint', 'middleware',
      'validation', 'error handling', 'testing', 'debug', 'fix bug',
      'configuration', 'deploy', 'ci/cd', 'docker', 'container',
      'cache', 'queue', 'webhook', 'notification', 'logging',
      // 한국어
      '구현', '통합', '엔드포인트', '미들웨어', '유효성 검사',
      '에러 처리', '오류 처리', '테스트', '디버깅', '버그 수정',
      '설정', '배포', '컨테이너', '캐시', '알림', '로깅',
    ],
    weight: 0.55,
  },
  // 낮은 복잡도 (0.1-0.4)
  low: {
    keywords: [
      'readme', 'comment', 'typo', 'rename', 'format', 'lint',
      'update version', 'bump', 'add dependency', 'install',
      'simple', 'trivial', 'minor', 'small change', 'one-liner',
      // 한국어
      '문서화', '주석', '오타', '이름 변경', '포맷', '버전 업데이트',
      '의존성 추가', '설치', '간단', '사소한', '소규모', '한 줄',
    ],
    weight: 0.2,
  },
};

/**
 * 어휘 복잡도 계산 (20%)
 * 고유 단어 비율 + 평균 단어 길이 기반
 * @param {string[]} words
 * @returns {number} 0-1
 */
function lexicalComplexity(words) {
  if (words.length === 0) return 0;
  const unique = new Set(words);
  const typeTokenRatio = unique.size / words.length;
  const avgWordLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  // 긴 단어(기술 용어)가 많을수록 복잡
  const lenScore = Math.min(avgWordLen / 10, 1);
  return typeTokenRatio * 0.5 + lenScore * 0.5;
}

/**
 * 시맨틱 깊이 계산 (35%)
 * 키워드 사전 매칭 기반
 * @param {string} text
 * @returns {number} 0-1
 */
function semanticDepth(text) {
  const lower = text.toLowerCase();
  let maxWeight = 0;
  let matchCount = 0;

  for (const [, category] of Object.entries(COMPLEXITY_INDICATORS)) {
    for (const kw of category.keywords) {
      if (lower.includes(kw)) {
        matchCount++;
        if (category.weight > maxWeight) maxWeight = category.weight;
      }
    }
  }
  // 매칭 키워드 수와 최고 가중치 조합
  const countScore = Math.min(matchCount / 5, 1);
  return maxWeight * 0.6 + countScore * 0.4;
}

/**
 * 작업 범위 계산 (25%)
 * 문장 수, 줄 수, 파일/경로 참조 기반
 * @param {string} text
 * @returns {number} 0-1
 */
function taskScope(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const fileRefs = (text.match(/[\w\-/]+\.\w{1,5}/g) || []).length;

  const lineScore = Math.min(lines.length / 20, 1);
  const sentenceScore = Math.min(sentences.length / 10, 1);
  const fileScore = Math.min(fileRefs / 5, 1);

  return lineScore * 0.3 + sentenceScore * 0.3 + fileScore * 0.4;
}

/**
 * 불확실성 계산 (20%)
 * 모호한 표현, 질문, 조건문 기반
 * @param {string} text
 * @returns {number} 0-1
 */
function uncertainty(text) {
  const lower = text.toLowerCase();
  const uncertainWords = [
    'maybe', 'perhaps', 'might', 'could', 'possibly', 'unclear',
    'not sure', 'investigate', 'explore', 'research', 'try',
    'consider', 'evaluate', 'assess', 'determine', 'figure out',
  ];
  let count = 0;
  for (const w of uncertainWords) {
    if (lower.includes(w)) count++;
  }
  const questions = (text.match(/\?/g) || []).length;
  const wordScore = Math.min(count / 4, 1);
  const questionScore = Math.min(questions / 3, 1);
  return wordScore * 0.6 + questionScore * 0.4;
}

/**
 * 작업 복잡도 스코어링
 * @param {string} taskDescription — 작업 설명 텍스트
 * @returns {{ score: number, breakdown: { lexical: number, semantic: number, scope: number, uncertainty: number } }}
 */
export function scoreComplexity(taskDescription) {
  if (!taskDescription || typeof taskDescription !== 'string') {
    return { score: 0, breakdown: { lexical: 0, semantic: 0, scope: 0, uncertainty: 0 } };
  }

  const words = taskDescription.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const lexical = lexicalComplexity(words);
  const semantic = semanticDepth(taskDescription);
  const scope = taskScope(taskDescription);
  const uncertain = uncertainty(taskDescription);

  // 가중 합산: 어휘(20%) + 시맨틱(35%) + 범위(25%) + 불확실성(20%)
  const score = Math.min(
    lexical * 0.20 + semantic * 0.35 + scope * 0.25 + uncertain * 0.20,
    1,
  );

  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      lexical: Math.round(lexical * 1000) / 1000,
      semantic: Math.round(semantic * 1000) / 1000,
      scope: Math.round(scope * 1000) / 1000,
      uncertainty: Math.round(uncertain * 1000) / 1000,
    },
  };
}
