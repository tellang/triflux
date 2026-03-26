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
  { from: ['configuration', '설정'],                to: 'cfg',   type: 'abbrev' },
  { from: ['implementation', '구현'],               to: 'impl',  type: 'abbrev' },
  { from: ['architecture', '아키텍처'],             to: 'arch',  type: 'abbrev' },
  { from: ['dependency', '의존성'],                 to: 'dep',   type: 'abbrev' },
  { from: ['function', '함수'],                     to: 'fn',    type: 'abbrev' },
  { from: ['parameter', '파라미터'],                to: 'param', type: 'abbrev' },
  { from: ['repository', '저장소'],                 to: 'repo',  type: 'abbrev' },
  { from: ['environment', '환경'],                  to: 'env',   type: 'abbrev' },
  { from: ['variable', '변수'],                     to: 'var',   type: 'abbrev' },
  { from: ['directory', '디렉토리'],                to: 'dir',   type: 'abbrev' },
];

// ── 내부: 정렬된 치환 쌍 빌드 (가장 긴 매칭 우선) ──

/** @type {Array<{ pattern: RegExp, to: string }>} */
const _compactPairs = [];

for (const rule of COMPACT_RULES) {
  for (const keyword of rule.from) {
    _compactPairs.push({ pattern: keyword, to: rule.to, len: keyword.length });
  }
}
// greedy: 긴 패턴 먼저
_compactPairs.sort((a, b) => b.len - a.len);

/** @type {Array<{ pattern: RegExp, to: string }>} */
const _expandPairs = [];

for (const rule of COMPACT_RULES) {
  // expand 시 첫 번째 from 값(영어 우선)으로 복원
  _expandPairs.push({ symbol: rule.to, restore: rule.from[0] });
}

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
