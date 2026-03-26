// tests/unit/token-mode.test.mjs — token efficiency mode 테스트
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_RULES,
  compactify,
  expand,
  isCompactMode,
} from '../../hub/token-mode.mjs';

describe('token-mode', () => {
  // 1. 심볼 치환: "results in" → "→"
  it('심볼 치환: "results in" → "→"', () => {
    assert.equal(compactify('this results in that'), 'this → that');
  });

  // 2. 약어: "configuration" → "cfg"
  it('약어: "configuration" → "cfg"', () => {
    assert.equal(compactify('update configuration file'), 'update cfg file');
  });

  // 3. 한국어: "따라서" → "∴"
  it('한국어: "따라서" → "∴"', () => {
    assert.equal(compactify('따라서 결론은'), '∴ 결론은');
  });

  // 4. 코드 블록 내부 보호 (변환하지 않음)
  it('코드 블록 내부는 변환하지 않음', () => {
    const input = 'check configuration\n```\nconfiguration = true\n```\nupdate configuration';
    const result = compactify(input);
    assert.ok(result.includes('```\nconfiguration = true\n```'), '코드 블록 내부 보호');
    assert.equal(result.split('cfg').length, 3, '코드 블록 밖의 configuration은 cfg로 변환');
  });

  // 5. 대소문자 무관: "CONFIGURATION" → "cfg"
  it('대소문자 무관: "CONFIGURATION" → "cfg"', () => {
    assert.equal(compactify('CONFIGURATION'), 'cfg');
    assert.equal(compactify('Configuration'), 'cfg');
  });

  // 6. 복합: 여러 규칙 동시 적용
  it('복합: 여러 규칙 동시 적용', () => {
    const input = 'therefore the configuration results in success';
    const result = compactify(input);
    assert.ok(result.includes('∴'), 'therefore → ∴');
    assert.ok(result.includes('cfg'), 'configuration → cfg');
    assert.ok(result.includes('→'), 'results in → →');
    assert.ok(result.includes('✓'), 'success → ✓');
  });

  // 7. expand: "→" → "results in" (best-effort)
  it('expand: "→" → "results in"', () => {
    const result = expand('this → that');
    assert.equal(result, 'this results in that');
  });

  // 8. 빈 문자열 처리
  it('빈 문자열 처리', () => {
    assert.equal(compactify(''), '');
    assert.equal(expand(''), '');
    assert.equal(compactify(null), '');
    assert.equal(compactify(undefined), '');
  });

  // 9. compactify 후 토큰 수 감소 확인 (length 비교)
  it('compactify 후 텍스트 길이 감소', () => {
    const input = 'therefore the configuration results in success because the implementation is completed';
    const compacted = compactify(input);
    assert.ok(
      compacted.length < input.length,
      `compact (${compacted.length}) should be shorter than original (${input.length})`,
    );
  });

  // 10. COMPACT_RULES export 확인
  it('COMPACT_RULES가 배열로 export 됨', () => {
    assert.ok(Array.isArray(COMPACT_RULES), 'COMPACT_RULES is an array');
    assert.ok(COMPACT_RULES.length > 0, 'COMPACT_RULES is not empty');
    for (const rule of COMPACT_RULES) {
      assert.ok(Array.isArray(rule.from), 'rule.from is an array');
      assert.ok(typeof rule.to === 'string', 'rule.to is a string');
      assert.ok(['symbol', 'abbrev'].includes(rule.type), 'rule.type is symbol or abbrev');
    }
  });

  // 11. isCompactMode: compactify 호출 후 true
  it('isCompactMode: compactify 호출 후 true', () => {
    compactify('test');
    assert.equal(isCompactMode(), true);
  });

  // 12. expand도 코드 블록 보호
  it('expand도 코드 블록 내부를 보호', () => {
    const input = 'this → that\n```\n→ arrow\n```\nand →';
    const result = expand(input);
    assert.ok(result.includes('```\n→ arrow\n```'), '코드 블록 내부 보호');
  });

  // 13. 한국어 심볼: "성공" → "✓", "실패" → "✗"
  it('한국어 심볼: "성공" → "✓", "실패" → "✗"', () => {
    assert.ok(compactify('테스트 성공').includes('✓'));
    assert.ok(compactify('빌드 실패').includes('✗'));
  });

  // 14. greedy: 긴 매칭 우선 ("in progress" vs 단순 매칭)
  it('greedy: "in progress" 전체가 매칭됨', () => {
    const result = compactify('task is in progress now');
    assert.ok(result.includes('⏳'), 'in progress → ⏳');
  });
});
