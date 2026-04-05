import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildSkillTemplateContext,
  loadTemplatePartials,
  parseFrontmatter,
  renderSkillTemplate,
} from "../lib/skill-template.mjs";
import { generateSkillDocs } from "../gen-skill-docs.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-skill-template-"));
}

describe("skill-template engine", () => {
  it("변수 치환 + include + 조건부 블록을 렌더링한다", () => {
    const template = [
      "{{> base}}",
      "",
      "{{#if DEEP}}",
      "{{> deep}}",
      "{{/if}}",
      "",
      "name={{SKILL_NAME}}",
    ].join("\n");

    const output = renderSkillTemplate(template, {
      SKILL_NAME: "tfx-deep-plan",
      SKILL_DESCRIPTION: "consensus planner",
      DEEP: true,
    }, {
      partials: {
        base: "desc={{SKILL_DESCRIPTION}}",
        deep: "deep-enabled",
      },
    });

    assert.match(output, /desc=consensus planner/);
    assert.match(output, /deep-enabled/);
    assert.match(output, /name=tfx-deep-plan/);
  });

  it("조건부가 false면 블록을 제거한다", () => {
    const template = "start\n{{#if DEEP}}hidden{{/if}}\nend";
    const output = renderSkillTemplate(template, { DEEP: false }, { partials: {} });
    assert.equal(output, "start\n\nend");
  });

  it("누락된 partial 또는 변수는 에러를 던진다", () => {
    assert.throws(
      () => renderSkillTemplate("{{> missing}}", {}, { partials: {} }),
      /Missing partial: missing/,
    );

    assert.throws(
      () => renderSkillTemplate("{{SKILL_NAME}}", {}, { partials: {} }),
      /Missing template variable: SKILL_NAME/,
    );
  });

  it("frontmatter와 context 기본값을 파싱한다", () => {
    const source = [
      "---",
      "name: tfx-auto",
      "description: >",
      "  auto orchestrator",
      "deep: true",
      "---",
      "{{SKILL_NAME}} / {{SKILL_DESCRIPTION}} / {{DEEP}}",
    ].join("\n");

    const parsed = parseFrontmatter(source);
    assert.equal(parsed.data.name, "tfx-auto");
    assert.equal(parsed.data.description, "auto orchestrator");

    const context = buildSkillTemplateContext({
      frontmatter: parsed.data,
      skillDirName: "fallback-name",
    });

    assert.equal(context.SKILL_NAME, "tfx-auto");
    assert.equal(context.SKILL_DESCRIPTION, "auto orchestrator");
    assert.equal(context.DEEP, true);
  });

  it("partial 디렉토리에서 이름/경로 alias를 함께 로드한다", () => {
    const root = makeTempDir();
    try {
      mkdirSync(join(root, "nested"), { recursive: true });
      writeFileSync(join(root, "base.md"), "base-partial", "utf8");
      writeFileSync(join(root, "nested", "telemetry.md"), "telemetry-partial", "utf8");

      const partials = loadTemplatePartials(root);
      assert.equal(partials.base, "base-partial");
      assert.equal(partials["nested/telemetry"], "telemetry-partial");
      assert.equal(partials.telemetry, "telemetry-partial");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("순환 partial include를 감지한다", () => {
    assert.throws(
      () =>
        renderSkillTemplate("{{> A}}", {}, {
          partials: {
            A: "A -> {{> B}}",
            B: "B -> {{> A}}",
          },
        }),
      /Circular partial include: A -> B -> A/,
    );
  });

  it("빈 frontmatter 블록도 정상 파싱한다", () => {
    const parsed = parseFrontmatter(["---", "---", "body"].join("\n"));
    assert.deepEqual(parsed.data, {});
    assert.equal(parsed.body, "body");
  });

  it("중복 frontmatter 키는 마지막 값을 우선한다", () => {
    const parsed = parseFrontmatter([
      "---",
      "name: first",
      "name: second",
      "---",
      "x",
    ].join("\n"));
    assert.equal(parsed.data.name, "second");
  });

  it("특수문자 변수 키(점/하이픈)를 치환한다", () => {
    const output = renderSkillTemplate("{{FOO.BAR}}/{{FOO-BAR}}", {
      "FOO.BAR": "dot",
      "FOO-BAR": "dash",
    }, { partials: {} });
    assert.equal(output, "dot/dash");
  });

  it("중첩 조건 블록을 안쪽 조건값에 따라 렌더링한다", () => {
    const template = "{{#if A}}open-{{#if B}}inner{{/if}}-close{{/if}}";
    assert.equal(renderSkillTemplate(template, { A: true, B: true }, { partials: {} }), "open-inner-close");
    assert.equal(renderSkillTemplate(template, { A: true, B: false }, { partials: {} }), "open--close");
    assert.equal(renderSkillTemplate(template, { A: false, B: true }, { partials: {} }), "");
  });

  it("1000줄 이상 대형 템플릿도 렌더링한다", () => {
    const lines = Array.from({ length: 1_200 }, (_v, i) => `line-${i}`);
    const template = `${lines.join("\n")}\nname={{SKILL_NAME}}`;
    const output = renderSkillTemplate(template, { SKILL_NAME: "big-template" }, { partials: {} });

    const renderedLines = output.split("\n");
    assert.equal(renderedLines.length, 1_201);
    assert.equal(renderedLines[0], "line-0");
    assert.equal(renderedLines.at(-1), "name=big-template");
  });

  it("gen-skill-docs에서 누락 partial 참조 시 에러를 전파한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const templatesDir = join(skillsDir, "_templates");
      const skillDir = join(skillsDir, "tfx-missing-partial");

      mkdirSync(templatesDir, { recursive: true });
      mkdirSync(skillDir, { recursive: true });

      writeFileSync(join(templatesDir, "base.md"), "base={{SKILL_NAME}}", "utf8");
      writeFileSync(
        join(skillDir, "SKILL.md.tmpl"),
        [
          "---",
          "name: tfx-missing-partial",
          "---",
          "{{> base}}",
          "{{> missing_partial}}",
        ].join("\n"),
        "utf8",
      );

      assert.throws(
        () => generateSkillDocs({ skillsDir, templatesDir, write: false }),
        /Missing partial: missing_partial/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
