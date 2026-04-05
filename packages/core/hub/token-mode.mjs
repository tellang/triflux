// hub/token-mode.mjs — Token Efficiency Mode
// GAP 분석 P2 #7: 심볼 통신 + 약어로 30-50% 토큰 절감

/** @type {Array<{ from: string[], to: string, type: 'symbol'|'abbrev' }>} */
export const COMPACT_RULES = [
  // ── 심볼 치환 (긴 매칭 우선 정렬) ──
  { from: ['greater than or equal'],                to: '≥',  type: 'symbol' },
  { from: ['less than or equal'],                   to: '≤',  type: 'symbol' },
  { from: ['results in', '결과적으로'],             to: '→',  type: 'symbol' },
  { from: ['therefore', '따라서'],                  to: '∴',  type: 'symbol' },
  { from: ['because', '왜냐하면'],                  to: '∵',  type: 'symbol' },
  { from: ['approximately', '대략'],                to: '≈',  type: 'symbol' },
  { from: ['not equal', '같지 않'],                 to: '≠',  type: 'symbol' },
  { from: ['in progress', '진행 중'],               to: '⏳', type: 'symbol' },
  { from: ['completed', '완료'],                    to: '✓',  type: 'symbol' },
  { from: ['success', '성공'],                      to: '✓',  type: 'symbol' },
  { from: ['failure', '실패'],                      to: '✗',  type: 'symbol' },
  { from: ['warning', '경고'],                      to: '⚠',  type: 'symbol' },
  { from: ['error', '에러'],                        to: '✗',  type: 'symbol' },
  { from: ['pending', '대기'],                      to: '⏸',  type: 'symbol' },

  // ── 약어 (긴 매칭 우선 정렬) ──
  { from: ['configuration', '설정'],                to: 'cfg',    type: 'abbrev' },
  { from: ['implementation', '구현'],               to: 'impl',   type: 'abbrev' },
  { from: ['architecture', '아키텍처'],             to: 'arch',   type: 'abbrev' },
  { from: ['dependency', '의존성'],                 to: 'dep',    type: 'abbrev' },
  { from: ['function', '함수'],                     to: 'fn',     type: 'abbrev' },
  { from: ['parameter', '파라미터'],                to: 'param',  type: 'abbrev' },
  { from: ['repository', '저장소'],                 to: 'repo',   type: 'abbrev' },
  { from: ['environment', '환경'],                  to: 'env',    type: 'abbrev' },
  { from: ['variable', '변수'],                     to: 'var',    type: 'abbrev' },
  { from: ['directory', '디렉토리'],                to: 'dir',    type: 'abbrev' },

  // ── 한국어 동사/명령형 약어 ──
  { from: ['구현해'],   to: 'impl',    type: 'abbrev' },
  { from: ['확인해'],   to: 'check',   type: 'abbrev' },
  { from: ['수정해'],   to: 'fix',     type: 'abbrev' },
  { from: ['테스트'],   to: 'test',    type: 'abbrev' },
  { from: ['리뷰'],     to: 'review',  type: 'abbrev' },
  { from: ['분석'],     to: 'analyze', type: 'abbrev' },
  { from: ['설계'],     to: 'design',  type: 'abbrev' },
  { from: ['문서화'],   to: 'docs',    type: 'abbrev' },
];

/** @type {Array<{ from: string[], to: string, type: 'symbol'|'abbrev' }>} */
export const REVIEW_RULES = [
  { from: ['looks good to me', 'lgtm'],    to: '✓lgtm',   type: 'abbrev' },
  { from: ['needs changes', '수정 필요'],  to: '✗chg',    type: 'abbrev' },
  { from: ['nitpick', '사소한'],           to: 'nit',     type: 'abbrev' },
  { from: ['blocking', '블로킹'],          to: 'blk',     type: 'abbrev' },
  { from: ['suggestion', '제안'],          to: 'sug',     type: 'abbrev' },
  { from: ['question', '질문'],            to: 'q',       type: 'abbrev' },
  { from: ['approved', '승인'],            to: '✓apv',    type: 'abbrev' },
  { from: ['request changes', '변경 요청'], to: '✗req',   type: 'abbrev' },
];

/** @type {Array<{ from: string[], to: string, type: 'symbol'|'abbrev' }>} */
export const DESIGN_RULES = [
  { from: ['component', '컴포넌트'],       to: 'cmp',     type: 'abbrev' },
  { from: ['interface', '인터페이스'],     to: 'iface',   type: 'abbrev' },
  { from: ['abstraction', '추상화'],       to: 'abs',     type: 'abbrev' },
  { from: ['pattern', '패턴'],             to: 'ptn',     type: 'abbrev' },
  { from: ['dependency injection', '의존성 주입'], to: 'di', type: 'abbrev' },
  { from: ['single responsibility', '단일 책임'],  to: 'srp', type: 'abbrev' },
  { from: ['open closed', '개방 폐쇄'],    to: 'ocp',     type: 'abbrev' },
  { from: ['inheritance', '상속'],         to: 'inh',     type: 'abbrev' },
];

/** @type {Array<{ from: string[], to: string, type: 'symbol'|'abbrev' }>} */
export const DOCS_RULES = [
  { from: ['description', '설명'],         to: 'desc',    type: 'abbrev' },
  { from: ['example', '예시'],             to: 'ex',      type: 'abbrev' },
  { from: ['reference', '참조'],           to: 'ref',     type: 'abbrev' },
  { from: ['introduction', '소개'],        to: 'intro',   type: 'abbrev' },
  { from: ['deprecated', '사용 중단'],     to: 'dep',     type: 'abbrev' },
  { from: ['optional', '선택적'],          to: 'opt',     type: 'abbrev' },
  { from: ['required', '필수'],            to: 'req',     type: 'abbrev' },
  { from: ['returns', '반환'],             to: 'ret',     type: 'abbrev' },
];

// ── 프로필 맵 ──

/** @type {Record<string, Array<{ from: string[], to: string, type: 'symbol'|'abbrev' }>>} */
const PROFILE_MAP = {
  default: COMPACT_RULES,
  review:  [...COMPACT_RULES, ...REVIEW_RULES],
  design:  [...COMPACT_RULES, ...DESIGN_RULES],
  docs:    [...COMPACT_RULES, ...DOCS_RULES],
};

// ── 내부: 정렬된 치환 쌍 빌드 헬퍼 ──

/**
 * 규칙 배열로부터 패턴 쌍을 빌드하고 긴 패턴 우선 정렬
 * @param {Array<{ from: string[], to: string }>} rules
 * @returns {Array<{ pattern: string, to: string, len: number }>}
 */
function buildCompactPairs(rules) {
  const pairs = [];
  for (const rule of rules) {
    for (const keyword of rule.from) {
      pairs.push({ pattern: keyword, to: rule.to, len: keyword.length });
    }
  }
  pairs.sort((a, b) => b.len - a.len);
  return pairs;
}

/**
 * 규칙 배열로부터 확장 쌍을 빌드
 * @param {Array<{ from: string[], to: string }>} rules
 * @returns {Array<{ symbol: string, restore: string }>}
 */
function buildExpandPairs(rules) {
  return rules.map((rule) => ({ symbol: rule.to, restore: rule.from[0] }));
}

// 기본 프로필 쌍 (기존 동작 유지)
const _compactPairs = buildCompactPairs(COMPACT_RULES);
const _expandPairs = buildExpandPairs(COMPACT_RULES);

// ── 코드 블록 보호 유틸 ──

const CODE_BLOCK_RE = /```[\s\S]*?```/g;

/**
 * 코드 블록을 플레이스홀더로 치환, 변환 후 복원
 * @param {string} text
 * @param {(segment: string) => string} transform
 * @returns {string}
 */
function withCodeProtection(text, transform) {
  const blocks = [];
  const placeholder = '\x00CB';
  let idx = 0;
  const masked = text.replace(CODE_BLOCK_RE, (match) => {
    blocks.push(match);
    return `${placeholder}${idx++}${placeholder}`;
  });

  const transformed = transform(masked);

  // 플레이스홀더 복원
  return transformed.replace(
    new RegExp(`${placeholder}(\\d+)${placeholder}`, 'g'),
    (_, i) => blocks[Number(i)],
  );
}

// ── compact 모드 상태 ──

let _compactMode = false;

/**
 * compact 모드 활성 여부
 * @returns {boolean}
 */
export function isCompactMode() {
  return _compactMode;
}

/**
 * 텍스트를 compact 모드로 변환
 * 심볼 치환 + 약어 적용, 코드 블록 내부는 보호
 * @param {string} text
 * @returns {string}
 */
export function compactify(text) {
  if (!text || typeof text !== 'string') return text ?? '';
  _compactMode = true;

  return withCodeProtection(text, (segment) => {
    let result = segment;
    for (const { pattern, to } of _compactPairs) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      result = result.replace(re, to);
    }
    return result;
  });
}

/**
 * 텍스트를 compact 모드로 변환 (도메인 프로필 선택 가능)
 * @param {string} text
 * @param {'default'|'review'|'design'|'docs'} [profile='default'] — 도메인 프로필
 * @returns {string}
 */
export function applyCompactRules(text, profile = 'default') {
  if (!text || typeof text !== 'string') return text ?? '';

  const rules = PROFILE_MAP[profile] ?? COMPACT_RULES;
  const pairs = buildCompactPairs(rules);

  return withCodeProtection(text, (segment) => {
    let result = segment;
    for (const { pattern, to } of pairs) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      result = result.replace(re, to);
    }
    return result;
  });
}

/**
 * compact 텍스트를 원래 형태로 복원 (best-effort)
 * @param {string} text
 * @returns {string}
 */
export function expand(text) {
  if (!text || typeof text !== 'string') return text ?? '';
  _compactMode = false;

  return withCodeProtection(text, (segment) => {
    let result = segment;
    for (const { symbol, restore } of _expandPairs) {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      result = result.replace(re, restore);
    }
    return result;
  });
}
