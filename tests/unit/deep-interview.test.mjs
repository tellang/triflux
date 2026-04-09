import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, describe, it } from "node:test";

const SKILL_PATH = new URL(
  "../../skills/tfx-deep-interview/SKILL.md",
  import.meta.url,
);

describe("tfx-deep-interview SKILL.md — 구조 검증", () => {
  let content;

  before(async () => {
    content = await readFile(SKILL_PATH, "utf-8");
  });

  it("SKILL.md 파일이 존재하고 읽을 수 있어야 한다", () => {
    assert.ok(content, "content must be non-empty");
    assert.ok(content.length > 100, "SKILL.md must have substantial content");
  });

  it("트리거 키워드가 모두 포함되어야 한다", () => {
    const triggers = [
      "deep-interview",
      "딥인터뷰",
      "소크라테스",
      "깊이 탐색",
      "요구사항 분석",
    ];
    for (const trigger of triggers) {
      assert.ok(content.includes(trigger), `트리거 "${trigger}" 누락`);
    }
  });

  it("5단계 프롬프트가 모두 정의되어야 한다", () => {
    const stages = [
      "Clarify",
      "Decompose",
      "Challenge",
      "Alternatives",
      "Synthesize",
    ];
    for (const stage of stages) {
      assert.ok(content.includes(`### Stage`), "Stage 헤더 필요");
      assert.ok(content.includes(stage), `단계 "${stage}" 누락`);
    }
  });

  it("산출물 경로 형식이 올바르어야 한다", () => {
    assert.ok(
      content.includes(".tfx/plans/interview-{timestamp}"),
      "산출물 경로 .tfx/plans/interview-{timestamp} 패턴 필요",
    );
  });

  it("각 단계별 질문 템플릿이 존재해야 한다", () => {
    assert.ok(content.includes("질문 템플릿"), "질문 템플릿 섹션 필요");

    // 각 Stage에 최소 1개의 번호 + 따옴표 질문이 있어야 함
    const numberedQuestions = content.match(/\d+\.\s*"/g);
    assert.ok(
      numberedQuestions && numberedQuestions.length >= 15,
      `질문 수 부족: ${numberedQuestions?.length || 0} (5단계 x 3 = 15개 이상 필요)`,
    );
  });

  it("마크다운 구조가 유효해야 한다", () => {
    // Frontmatter
    assert.ok(content.startsWith("---"), "frontmatter 시작 --- 필요");
    const secondDash = content.indexOf("---", 3);
    assert.ok(secondDash > 0, "frontmatter 종료 --- 필요");

    // Frontmatter 필수 필드
    const frontmatter = content.substring(0, secondDash);
    assert.ok(frontmatter.includes("name:"), "frontmatter name 필드 필요");
    assert.ok(
      frontmatter.includes("description:"),
      "frontmatter description 필드 필요",
    );
    assert.ok(
      frontmatter.includes("triggers:"),
      "frontmatter triggers 필드 필요",
    );

    // Heading 구조
    assert.ok(content.includes("# "), "H1 제목 필요");
    assert.ok(content.includes("## "), "H2 섹션 필요");
    assert.ok(content.includes("### "), "H3 하위 섹션 필요");

    // 코드 블록 쌍 검증
    const codeBlocks = content.match(/```/g);
    assert.ok(
      codeBlocks && codeBlocks.length % 2 === 0,
      "코드 블록 쌍이 맞아야 한다",
    );
  });
});
