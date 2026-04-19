// tests/unit/skill-drift.test.mjs — 스킬 문서 드리프트 감사 테스트

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const SKILLS_DIR = join(process.cwd(), "skills");
const _ROUTE_SH = join(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "scripts",
  "tfx-route.sh",
);

function readSkill(name) {
  const p = join(SKILLS_DIR, name, "SKILL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * 마크다운 문서에서 특정 섹션(## 헤더)의 내용을 추출한다.
 * 다음 동일 레벨 헤더가 나오거나 문서 끝에서 멈춘다.
 */
function extractSection(content, headingRegex) {
  const lines = content.split("\n");
  let inSection = false;
  const sectionLines = [];
  const _headingLevel = headingRegex.source.match(/^\\#{(\d+)}/)?.[1];

  for (const line of lines) {
    if (headingRegex.test(line)) {
      inSection = true;
      sectionLines.push(line);
      continue;
    }
    if (inSection) {
      // 같은 레벨 이상의 헤더가 나오면 섹션 종료
      if (/^#{1,2}\s/.test(line) && !headingRegex.test(line)) {
        break;
      }
      sectionLines.push(line);
    }
  }
  return sectionLines.join("\n");
}

/**
 * YAML 프론트매터에서 특정 필드를 추출한다.
 */
function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : "";
}

describe("스킬 문서 존재 확인", () => {
  // Phase 5 cleanup (b371043) removed tfx-deep-interview, tfx-autoresearch thin
  // aliases. Their semantics were absorbed into tfx-interview / tfx-research
  // main bodies. See `축소된 스킬 본체 이관 완결성` suite for the body-level checks.
  const expected = [
    "tfx-auto",
    "tfx-multi",
    "tfx-hub",
    "tfx-doctor",
    "tfx-setup",
    "tfx-interview",
    "tfx-research",
  ];

  for (const name of expected) {
    it(`${name}/SKILL.md 존재`, () => {
      const content = readSkill(name);
      assert.ok(content, `${name}/SKILL.md not found`);
      assert.ok(content.length > 50, `${name}/SKILL.md is too short`);
    });
  }
});

describe("tfx-auto SKILL.md — 에이전트 매핑 일관성", () => {
  it("에이전트 매핑 섹션에 executor 포함 (단어 경계 일치)", () => {
    const content = readSkill("tfx-auto");
    // "에이전트 매핑" 섹션 또는 "커맨드 숏컷" 섹션에서 executor를 단어 단위로 찾는다
    const agentSection = extractSection(content, /^##\s+에이전트\s+매핑/);
    const shortcutSection = extractSection(content, /^##\s+커맨드\s+숏컷/);
    const combined = agentSection + shortcutSection;
    assert.ok(
      /\bexecutor\b/.test(combined),
      "executor가 에이전트 매핑/커맨드 숏컷 섹션에 없음",
    );
  });

  it("MCP 프로필 섹션에 implement 포함", () => {
    const content = readSkill("tfx-auto");
    // MCP 프로필 자동결정 섹션 또는 에이전트 매핑 섹션에서 implement를 찾는다
    const mcpSection = extractSection(content, /^###\s+MCP\s+프로필/);
    const agentSection = extractSection(content, /^###\s+에이전트\s+매핑/);
    const combined = mcpSection + agentSection;
    assert.ok(
      /\bimplement\b/.test(combined),
      "implement가 MCP 프로필/에이전트 매핑 섹션에 없음",
    );
  });

  it("멀티 태스크 라우팅 섹션에 headless 엔진 참조 포함", () => {
    const content = readSkill("tfx-auto");
    // "멀티 태스크 라우팅" 섹션에서 headless를 찾는다
    const routingSection = extractSection(
      content,
      /^##\s+멀티\s+태스크\s+라우팅/,
    );
    assert.ok(
      /\bheadless\b/.test(routingSection),
      "headless가 멀티 태스크 라우팅 섹션에 없음",
    );
    // 헤드리스가 단순 주석이 아닌 실제 엔진 참조인지 확인 (headless.mjs 또는 headless 직행 언급)
    assert.ok(
      /headless\.(mjs|엔진|직접|직행)/i.test(routingSection) ||
        /headless\s+엔진/i.test(routingSection),
      "headless가 엔진 참조로 사용되지 않음 (headless.mjs 또는 headless 엔진 형태여야 함)",
    );
  });

  it("에이전트 매핑 섹션에 codex와 gemini 모두 포함", () => {
    const content = readSkill("tfx-auto");
    const agentSection = extractSection(content, /^###\s+에이전트\s+매핑/);
    assert.ok(
      /\bcodex\b/i.test(agentSection),
      "codex가 에이전트 매핑 섹션에 없음",
    );
    assert.ok(
      /\bgemini\b/i.test(agentSection),
      "gemini가 에이전트 매핑 섹션에 없음",
    );
  });

  it("false positive 방지: 코멘트나 예시 문맥이 아닌 실제 매핑 테이블에 존재", () => {
    const content = readSkill("tfx-auto");
    const agentSection = extractSection(content, /^###\s+에이전트\s+매핑/);
    // 매핑 테이블은 파이프(|) 구분자를 포함해야 한다
    assert.ok(
      /\|.*codex.*\|/i.test(agentSection),
      "에이전트 매핑 테이블이 올바른 마크다운 테이블 형식이 아님 (| 구분자 없음)",
    );
  });
});

describe("tfx-hub SKILL.md — hub 모듈 참조", () => {
  it("제목 또는 설명에 hub 키워드 포함 (단어 경계)", () => {
    const content = readSkill("tfx-hub");
    const frontmatter = extractFrontmatter(content);
    // 프론트매터 name/description 또는 h1 제목에서 hub를 찾는다
    const titleLine = content.split("\n").find((l) => /^#\s/.test(l)) || "";
    assert.ok(
      /\bhub\b/i.test(frontmatter) || /\bhub\b/i.test(titleLine),
      "hub가 프론트매터 또는 H1 제목에 없음",
    );
  });

  it("MCP 도구 섹션에 메시지 관련 키워드 포함", () => {
    const content = readSkill("tfx-hub");
    const mcpSection = extractSection(content, /^##\s+MCP\s+도구/);
    assert.ok(mcpSection.length > 0, "MCP 도구 섹션이 존재하지 않음");
    // 실제 MCP 도구 목록에 메시지 버스 핵심 동사가 포함되어야 한다
    assert.ok(
      /publish|register|ask|handoff|poll_messages/i.test(mcpSection),
      "MCP 도구 섹션에 핵심 메시지 버스 도구(publish/register/ask 등)가 없음",
    );
  });

  it("CLI 등록/대응 섹션 존재", () => {
    const content = readSkill("tfx-hub");
    assert.ok(
      /##\s+(CLI\s+대응|각\s+CLI\s+등록\s+방법)/.test(content),
      "CLI 등록/대응 섹션이 없음",
    );
  });

  it("false positive 방지: hub가 단순 URL이나 변수명이 아닌 섹션 제목에 존재", () => {
    const content = readSkill("tfx-hub");
    // H1 또는 H2 수준 제목에 hub가 포함되어야 한다
    const headings = content.split("\n").filter((l) => /^#{1,2}\s/.test(l));
    const hubInHeading = headings.some((h) => /\bhub\b/i.test(h));
    assert.ok(
      hubInHeading,
      "hub가 H1/H2 섹션 제목에 없음 (단순 본문 언급은 불충분)",
    );
  });
});

describe("tfx-auto SKILL.md — thin alias 이관 규칙", () => {
  it("tfx-multi 의미가 플래그 표와 legacy 매핑에 남아 있다", () => {
    const content = readSkill("tfx-auto");
    const overrideSection = extractSection(
      content,
      /^##\s+플래그\s+오버라이드/,
    );
    assert.ok(
      /`--parallel`\s*\|\s*`N`/.test(overrideSection) &&
        /tfx-multi/.test(overrideSection),
      "tfx-multi 이관 의미가 플래그 표/legacy 매핑에 없음",
    );
  });

  it("멀티 태스크 라우팅 섹션에 headless 엔진 참조 포함", () => {
    const content = readSkill("tfx-auto");
    const routingSection = extractSection(
      content,
      /^##\s+멀티\s+태스크\s+라우팅/,
    );
    assert.ok(
      /\bheadless\b/i.test(routingSection) &&
        /headless\.(mjs|엔진|직행)/i.test(routingSection),
      "headless 엔진 참조가 멀티 태스크 라우팅 섹션에 없음",
    );
  });

  it("headless 실행 명령이 구체적인 Bash 형태로 존재", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /tfx\s+multi\s+--teammate-mode\s+headless/.test(content),
      "headless 엔진 실행 명령(tfx multi --teammate-mode headless)이 없음",
    );
  });

  it("false positive 방지: headless가 주석이 아닌 MANDATORY 지시문에 포함", () => {
    const content = readSkill("tfx-auto");
    const routingSection = extractSection(
      content,
      /^##\s+멀티\s+태스크\s+라우팅/,
    );
    assert.ok(
      /MANDATORY/i.test(routingSection),
      "멀티 태스크 라우팅 섹션에 MANDATORY 강제 지시문이 없음",
    );
  });

  it("tfx-autoroute 의미가 auto-escalate 체인으로 이관되었다", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /DEFAULT_ESCALATION_CHAIN/.test(content) &&
        /\.claude\/rules\/tfx-escalation-chain\.md/.test(content),
      "autoroute 이관용 escalation chain 규칙이 없음",
    );
  });

  it("tfx-persist 의미가 ralph state machine 계약으로 이관되었다", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /--retry ralph/.test(content) &&
        /\.omc\/state\/ralph-<sessionId>\.json/.test(content),
      "persist 이관용 ralph state machine 규칙이 없음",
    );
  });

  it("tfx-auto-codex 의미가 Codex lead 플래그로 이관되었다", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /--cli codex --lead codex --no-claude-native/.test(content) &&
        /TFX_NO_CLAUDE_NATIVE=1/.test(content),
      "auto-codex 이관용 Codex lead 규칙이 없음",
    );
  });
});

describe("축소된 스킬 본체 이관 완결성", () => {
  it("tfx-interview: 프론트매터에 deep-interview 트리거를 흡수", () => {
    const content = readSkill("tfx-interview");
    const frontmatter = extractFrontmatter(content);
    assert.ok(
      /deep-interview|딥인터뷰|소크라테스|깊이 탐색|요구사항 분석/.test(
        frontmatter,
      ),
      "프론트매터에 deep-interview 계열 트리거가 없음",
    );
  });

  it("tfx-interview: 5개 Stage 헤더가 모두 존재 (Stage 1~5)", () => {
    const content = readSkill("tfx-interview");
    for (let i = 1; i <= 5; i++) {
      assert.ok(
        new RegExp(`#{3,4}\\s+Stage\\s+${i}:`).test(content),
        `Stage ${i} 헤더가 없음`,
      );
    }
  });

  it("tfx-interview: 산출물 저장 경로 명시", () => {
    const content = readSkill("tfx-interview");
    assert.ok(
      /\.tfx\/plans\/interview-/.test(content),
      "산출물 저장 경로(.tfx/plans/interview-{timestamp})가 없음",
    );
  });

  it("tfx-research: auto 리서치 섹션 존재", () => {
    const content = readSkill("tfx-research");
    const autoSection = extractSection(content, /^##\s+Auto\s+모드/);
    assert.ok(autoSection.length > 0, "Auto 모드 섹션이 없음");
  });

  it("tfx-research: 6단계 스텝 헤더가 모두 존재", () => {
    const content = readSkill("tfx-research");
    for (let i = 1; i <= 6; i++) {
      assert.ok(
        new RegExp(`###\\s+Step\\s+${i}:`).test(content),
        `Step ${i} 헤더가 없음`,
      );
    }
  });

  it("tfx-research: 보고서 저장 경로 명시", () => {
    const content = readSkill("tfx-research");
    assert.ok(
      /\.tfx\/reports\/research-/.test(content),
      "보고서 저장 경로(.tfx/reports/research-{timestamp})가 없음",
    );
  });

  it("false positive 방지: tfx-interview에서 Stage가 주석이 아닌 헤더로 존재", () => {
    const content = readSkill("tfx-interview");
    const stageHeadings = content
      .split("\n")
      .filter((l) => /^#{3,4}\s+Stage\s+\d+:/.test(l));
    assert.ok(stageHeadings.length >= 5, "Stage 헤더가 5개 미만임");
  });

  it("tfx-auto: PRE-CONTEXT GATE와 context snapshot 계약을 명시", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /##\s+PRE-CONTEXT\s+GATE/.test(content),
      "PRE-CONTEXT GATE 섹션이 없음",
    );
    assert.ok(
      /task slug/i.test(content) && /context-snapshot\.md/i.test(content),
      "task slug 또는 context-snapshot.md 계약이 없음",
    );
  });

  it("tfx-auto: deep-interview 산출물 재사용 규칙을 명시", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /\.tfx\/plans\/interview-\*/.test(content) ||
        /\.tfx\/plans\/interview-\{timestamp\}/.test(content),
      "deep-interview 산출물 경로 규칙이 없음",
    );
    assert.ok(
      /재사용/.test(content) || /reuse/i.test(content),
      "deep-interview 산출물 재사용 규칙이 없음",
    );
  });

  it("tfx-auto: phase-state/resume 아티팩트 경로를 명시", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /\.tfx\/fullcycle\/\{run-id\}\//.test(content),
      "fullcycle run 아티팩트 디렉토리 규칙이 없음",
    );
    assert.ok(
      /\bresume\b/i.test(content) && /state\.json/i.test(content),
      "resume 또는 state.json 계약이 없음",
    );
  });

  it("tfx-auto: 동일 QA 에러 3회 반복 시 중단 규칙을 명시", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /동일.+3회 반복/.test(content) || /same.+3 times/i.test(content),
      "동일 QA 에러 3회 반복 중단 규칙이 없음",
    );
  });

  it("tfx-auto: cleanup/cancel 메타데이터 규칙을 명시", () => {
    const content = readSkill("tfx-auto");
    assert.ok(
      /##\s+CLEANUP\s+&\s+CANCEL\s+RULES/.test(content),
      "CLEANUP & CANCEL RULES 섹션이 없음",
    );
    assert.ok(
      /failure_reason/i.test(content) && /`?complete`?\s+상태/.test(content),
      "cleanup/cancel 메타데이터 규칙이 충분히 명시되지 않음",
    );
  });
});

describe("tfx-route.sh와 tfx-auto SKILL.md 에이전트 매핑 교차 검증", () => {
  it("에이전트 매핑 테이블에 핵심 에이전트가 행(row)으로 존재", () => {
    const content = readSkill("tfx-auto");
    const agentSection = extractSection(content, /^###\s+에이전트\s+매핑/);
    const agents = [
      "executor",
      "architect",
      "analyst",
      "code-reviewer",
      "writer",
      "debugger",
    ];
    for (const agent of agents) {
      // 에이전트명이 테이블 행(|로 감싸인 셀)에 단어 단위로 있어야 한다
      const inTableRow = new RegExp(`\\|[^|]*\\b${agent}\\b[^|]*\\|`, "i").test(
        agentSection,
      );
      assert.ok(
        inTableRow,
        `agent "${agent}"가 에이전트 매핑 테이블 행에 없음 (섹션 외 본문 언급은 불충분)`,
      );
    }
  });

  it("false positive 방지: 에이전트명이 코드 블록 밖 테이블에 존재", () => {
    const content = readSkill("tfx-auto");
    const agentSection = extractSection(content, /^###\s+에이전트\s+매핑/);
    // 코드 블록(```)을 제거한 후에도 테이블에 executor가 있어야 한다
    const withoutCodeBlocks = agentSection.replace(/```[\s\S]*?```/g, "");
    assert.ok(
      /\|[^|]*\bexecutor\b[^|]*\|/i.test(withoutCodeBlocks),
      "executor가 코드 블록 외부의 테이블 셀에 없음",
    );
  });
});
