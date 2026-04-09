// tests/unit/token-mode.test.mjs — token efficiency mode 테스트

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyCompactRules,
  COMPACT_RULES,
  compactify,
  DESIGN_RULES,
  DOCS_RULES,
  expand,
  REVIEW_RULES,
} from "../../hub/token-mode.mjs";

// ── 모듈 레벨 상태(_compactMode) 초기화 헬퍼 ──
// hub/token-mode.mjs의 _compactMode는 모듈 싱글턴이므로
// 각 테스트 전에 동적 임포트(nonce)로 신선한 모듈을 얻어 상태를 초기화한다.
async function freshModule() {
  const nonce = Date.now() + Math.random();
  const mod = await import(`../../hub/token-mode.mjs?nonce=${nonce}`);
  return mod;
}

describe("token-mode", () => {
  // _compactMode 상태를 매 테스트 전에 expand() 호출로 초기화
  // (expand는 _compactMode = false로 설정)
  beforeEach(() => {
    expand("");
  });

  // 1. 심볼 치환: "results in" → "→"
  it('심볼 치환: "results in" → "→"', () => {
    assert.equal(compactify("this results in that"), "this → that");
  });

  // 2. 약어: "configuration" → "cfg"
  it('약어: "configuration" → "cfg"', () => {
    assert.equal(compactify("update configuration file"), "update cfg file");
  });

  // 3. 한국어: "따라서" → "∴"
  it('한국어: "따라서" → "∴"', () => {
    assert.equal(compactify("따라서 결론은"), "∴ 결론은");
  });

  // 4. 코드 블록 내부 보호 (변환하지 않음)
  it("코드 블록 내부는 변환하지 않음", () => {
    const input =
      "check configuration\n```\nconfiguration = true\n```\nupdate configuration";
    const result = compactify(input);
    assert.ok(
      result.includes("```\nconfiguration = true\n```"),
      "코드 블록 내부 보호",
    );
    assert.equal(
      result.split("cfg").length,
      3,
      "코드 블록 밖의 configuration은 cfg로 변환",
    );
  });

  // 5. 대소문자 무관: "CONFIGURATION" → "cfg"
  it('대소문자 무관: "CONFIGURATION" → "cfg"', () => {
    assert.equal(compactify("CONFIGURATION"), "cfg");
    assert.equal(compactify("Configuration"), "cfg");
  });

  // 6. 복합: 여러 규칙 동시 적용
  it("복합: 여러 규칙 동시 적용", () => {
    const input = "therefore the configuration results in success";
    const result = compactify(input);
    assert.ok(result.includes("∴"), "therefore → ∴");
    assert.ok(result.includes("cfg"), "configuration → cfg");
    assert.ok(result.includes("→"), "results in → →");
    assert.ok(result.includes("✓"), "success → ✓");
  });

  // 7. expand: "→" → "results in" (best-effort)
  it('expand: "→" → "results in"', () => {
    const result = expand("this → that");
    assert.equal(result, "this results in that");
  });

  // 8. 빈 문자열 처리
  it("빈 문자열 처리", () => {
    assert.equal(compactify(""), "");
    assert.equal(expand(""), "");
    assert.equal(compactify(null), "");
    assert.equal(compactify(undefined), "");
  });

  // 9. compactify 후 토큰 수 감소 확인 (length 비교)
  it("compactify 후 텍스트 길이 감소", () => {
    const input =
      "therefore the configuration results in success because the implementation is completed";
    const compacted = compactify(input);
    assert.ok(
      compacted.length < input.length,
      `compact (${compacted.length}) should be shorter than original (${input.length})`,
    );
  });

  // 10. COMPACT_RULES export 확인
  it("COMPACT_RULES가 배열로 export 됨", () => {
    assert.ok(Array.isArray(COMPACT_RULES), "COMPACT_RULES is an array");
    assert.ok(COMPACT_RULES.length > 0, "COMPACT_RULES is not empty");
    for (const rule of COMPACT_RULES) {
      assert.ok(Array.isArray(rule.from), "rule.from is an array");
      assert.ok(typeof rule.to === "string", "rule.to is a string");
      assert.ok(
        ["symbol", "abbrev"].includes(rule.type),
        "rule.type is symbol or abbrev",
      );
    }
  });

  // 11. isCompactMode: 신선한 모듈에서 초기값 false, compactify 후 true
  it("isCompactMode: 초기값 false, compactify 호출 후 true", async () => {
    const mod = await freshModule();
    assert.equal(mod.isCompactMode(), false, "초기값은 false");
    mod.compactify("test");
    assert.equal(mod.isCompactMode(), true, "compactify 후 true");
  });

  // 12. expand도 코드 블록 보호
  it("expand도 코드 블록 내부를 보호", () => {
    const input = "this → that\n```\n→ arrow\n```\nand →";
    const result = expand(input);
    assert.ok(result.includes("```\n→ arrow\n```"), "코드 블록 내부 보호");
  });

  // 13. 한국어 심볼: "성공" → "✓", "실패" → "✗"
  it('한국어 심볼: "성공" → "✓", "실패" → "✗"', () => {
    assert.ok(compactify("테스트 성공").includes("✓"));
    assert.ok(compactify("빌드 실패").includes("✗"));
  });

  // 14. greedy: 긴 매칭 우선 ("in progress" vs 단순 매칭)
  it('greedy: "in progress" 전체가 매칭됨', () => {
    const result = compactify("task is in progress now");
    assert.ok(result.includes("⏳"), "in progress → ⏳");
  });

  // ── 한국어 약어 규칙 테스트 ──

  // 15. 한국어 동사 약어: "구현해" → "impl"
  it('한국어 동사: "구현해" → "impl"', () => {
    assert.ok(compactify("기능을 구현해").includes("impl"));
  });

  // 16. 한국어 동사 약어: "확인해" → "check"
  it('한국어 동사: "확인해" → "check"', () => {
    assert.ok(compactify("코드를 확인해").includes("check"));
  });

  // 17. 한국어 동사 약어: "수정해" → "fix"
  it('한국어 동사: "수정해" → "fix"', () => {
    assert.ok(compactify("버그를 수정해").includes("fix"));
  });

  // 18. 한국어 약어: "테스트" → "test"
  it('한국어 약어: "테스트" → "test"', () => {
    assert.ok(compactify("테스트 실행").includes("test"));
  });

  // 19. 한국어 약어: "리뷰" → "review"
  it('한국어 약어: "리뷰" → "review"', () => {
    assert.ok(compactify("코드 리뷰 요청").includes("review"));
  });

  // 20. 한국어 약어: "분석" → "analyze"
  it('한국어 약어: "분석" → "analyze"', () => {
    assert.ok(compactify("성능 분석 필요").includes("analyze"));
  });

  // 21. 한국어 약어: "설계" → "design"
  it('한국어 약어: "설계" → "design"', () => {
    assert.ok(compactify("시스템 설계 문서").includes("design"));
  });

  // 22. 한국어 약어: "문서화" → "docs"
  it('한국어 약어: "문서화" → "docs"', () => {
    assert.ok(compactify("API 문서화 작업").includes("docs"));
  });

  // ── 도메인 프로필 테스트 ──

  // 23. REVIEW_RULES export 확인
  it("REVIEW_RULES가 배열로 export 됨", () => {
    assert.ok(Array.isArray(REVIEW_RULES), "REVIEW_RULES is an array");
    assert.ok(REVIEW_RULES.length > 0, "REVIEW_RULES is not empty");
  });

  // 24. DESIGN_RULES export 확인
  it("DESIGN_RULES가 배열로 export 됨", () => {
    assert.ok(Array.isArray(DESIGN_RULES), "DESIGN_RULES is an array");
    assert.ok(DESIGN_RULES.length > 0, "DESIGN_RULES is not empty");
  });

  // 25. DOCS_RULES export 확인
  it("DOCS_RULES가 배열로 export 됨", () => {
    assert.ok(Array.isArray(DOCS_RULES), "DOCS_RULES is an array");
    assert.ok(DOCS_RULES.length > 0, "DOCS_RULES is not empty");
  });

  // 26. applyCompactRules: default 프로필은 compactify와 동일 결과
  it("applyCompactRules default 프로필은 compactify와 동일", () => {
    const input = "therefore the configuration results in success";
    assert.equal(applyCompactRules(input, "default"), compactify(input));
  });

  // 27. applyCompactRules: review 프로필 — REVIEW_RULES 규칙 적용
  it('applyCompactRules review 프로필: "approved" → "✓apv"', () => {
    const result = applyCompactRules("PR approved by reviewer", "review");
    assert.ok(result.includes("✓apv"), `approved → ✓apv, got: ${result}`);
  });

  // 28. applyCompactRules: review 프로필 — 기본 규칙도 적용됨
  it("applyCompactRules review 프로필: 기본 규칙도 유지", () => {
    const result = applyCompactRules("configuration approved", "review");
    assert.ok(result.includes("cfg"), "configuration → cfg (기본 규칙)");
    assert.ok(result.includes("✓apv"), "approved → ✓apv (review 규칙)");
  });

  // 29. applyCompactRules: design 프로필 — "component" → "cmp"
  it('applyCompactRules design 프로필: "component" → "cmp"', () => {
    const result = applyCompactRules("create a new component", "design");
    assert.ok(result.includes("cmp"), `component → cmp, got: ${result}`);
  });

  // 30. applyCompactRules: docs 프로필 — "description" → "desc"
  it('applyCompactRules docs 프로필: "description" → "desc"', () => {
    const result = applyCompactRules(
      "add description for the function",
      "docs",
    );
    assert.ok(result.includes("desc"), `description → desc, got: ${result}`);
  });

  // 31. applyCompactRules: 프로필 미지정 시 default 동작
  it("applyCompactRules 프로필 미지정 시 default", () => {
    const input = "update configuration";
    assert.equal(applyCompactRules(input), applyCompactRules(input, "default"));
  });

  // 32. applyCompactRules: 빈 문자열 처리
  it("applyCompactRules 빈 문자열 처리", () => {
    assert.equal(applyCompactRules(""), "");
    assert.equal(applyCompactRules(null), "");
    assert.equal(applyCompactRules(undefined), "");
  });

  // 33. applyCompactRules: 코드 블록 보호
  it("applyCompactRules 코드 블록 내부는 변환하지 않음", () => {
    const input = "component\n```\ncomponent = true\n```\ncomponent";
    const result = applyCompactRules(input, "design");
    assert.ok(
      result.includes("```\ncomponent = true\n```"),
      "코드 블록 내부 보호",
    );
  });

  // isCompactMode: expand 호출 후 false로 리셋
  it("isCompactMode: expand 호출 후 false로 리셋", async () => {
    const mod = await freshModule();
    mod.compactify("test");
    assert.equal(mod.isCompactMode(), true, "compactify 후 true");
    mod.expand("test");
    assert.equal(mod.isCompactMode(), false, "expand 후 false");
  });
});
