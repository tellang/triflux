// tests/unit/skill-template.test.mjs — skill-template.mjs 단위 테스트
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
} from "../../scripts/lib/skill-template.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-skill-tpl-test-"));
}

// ── parseFrontmatter ──

describe("parseFrontmatter", () => {
  it("frontmatter 블록을 파싱하고 body를 분리한다", () => {
    const source = [
      "---",
      "name: tfx-auto",
      "description: orchestrator",
      "---",
      "# Title",
      "Body content here.",
    ].join("\n");

    const { data, body } = parseFrontmatter(source);
    assert.equal(data.name, "tfx-auto");
    assert.equal(data.description, "orchestrator");
    assert.ok(body.includes("# Title"));
    assert.ok(body.includes("Body content here."));
    assert.ok(!body.includes("---"));
  });

  it("frontmatter가 없으면 data={}, body=원본을 반환한다", () => {
    const source = "# No frontmatter\nJust content.";
    const { data, body } = parseFrontmatter(source);
    assert.deepEqual(data, {});
    assert.equal(body, source);
  });

  it("빈 frontmatter 블록을 처리한다", () => {
    const source = "---\n---\nContent after empty frontmatter.";
    const { data, body } = parseFrontmatter(source);
    assert.deepEqual(data, {});
    assert.ok(body.includes("Content after empty frontmatter."));
  });

  it("quoted 문자열 값을 언래핑한다", () => {
    const source = '---\nname: "tfx-find"\ntag: \'single\'\n---\nbody';
    const { data } = parseFrontmatter(source);
    assert.equal(data.name, "tfx-find");
    assert.equal(data.tag, "single");
  });

  it("boolean 값을 파싱한다", () => {
    const source = "---\ndeep: true\nenabled: false\n---\nbody";
    const { data } = parseFrontmatter(source);
    assert.equal(data.deep, true);
    assert.equal(data.enabled, false);
  });

  it("list 값을 배열로 파싱한다", () => {
    const source = [
      "---",
      "triggers:",
      "  - 코드 검색",
      "  - find in code",
      "---",
      "body",
    ].join("\n");

    const { data } = parseFrontmatter(source);
    assert.deepEqual(data.triggers, ["코드 검색", "find in code"]);
  });

  it("multiline fold (>) 값을 한 줄로 합친다", () => {
    const source = [
      "---",
      "description: >",
      "  first line",
      "  second line",
      "---",
      "body",
    ].join("\n");

    const { data } = parseFrontmatter(source);
    assert.equal(data.description, "first line second line");
  });

  it("multiline literal (|) 값을 줄바꿈으로 유지한다", () => {
    const source = [
      "---",
      "notes: |",
      "  line one",
      "  line two",
      "---",
      "body",
    ].join("\n");

    const { data } = parseFrontmatter(source);
    assert.equal(data.notes, "line one\nline two");
  });
});

// ── buildSkillTemplateContext ──

describe("buildSkillTemplateContext", () => {
  it("frontmatter에서 SKILL_NAME, SKILL_DESCRIPTION을 설정한다", () => {
    const ctx = buildSkillTemplateContext({
      frontmatter: { name: "tfx-auto", description: "auto orchestrator" },
    });
    assert.equal(ctx.SKILL_NAME, "tfx-auto");
    assert.equal(ctx.SKILL_DESCRIPTION, "auto orchestrator");
  });

  it("name이 없으면 skillDirName을 fallback으로 사용한다", () => {
    const ctx = buildSkillTemplateContext({
      frontmatter: {},
      skillDirName: "tfx-review",
    });
    assert.equal(ctx.SKILL_NAME, "tfx-review");
  });

  it("deep 이름 패턴에서 DEEP=true를 자동 추론한다", () => {
    const ctx = buildSkillTemplateContext({
      frontmatter: { name: "tfx-deep-plan" },
    });
    assert.equal(ctx.DEEP, true);
  });

  it("deep이 아닌 이름에서 DEEP=false를 반환한다", () => {
    const ctx = buildSkillTemplateContext({
      frontmatter: { name: "tfx-auto" },
    });
    assert.equal(ctx.DEEP, false);
  });

  it("frontmatter에 deep 값이 명시되면 이름 추론보다 우선한다", () => {
    const ctx = buildSkillTemplateContext({
      frontmatter: { name: "tfx-auto", deep: "true" },
    });
    assert.equal(ctx.DEEP, true);
  });

  it("인자 없이 호출해도 에러 없이 기본값을 반환한다", () => {
    const ctx = buildSkillTemplateContext();
    assert.equal(ctx.SKILL_NAME, "");
    assert.equal(ctx.SKILL_DESCRIPTION, "");
    assert.equal(ctx.DEEP, false);
  });

  it("frontmatter의 커스텀 필드를 context에 보존한다", () => {
    const ctx = buildSkillTemplateContext({
      frontmatter: { name: "tfx-qa", custom_field: "value123" },
    });
    assert.equal(ctx.custom_field, "value123");
    assert.equal(ctx.SKILL_NAME, "tfx-qa");
  });
});

// ── renderSkillTemplate ──

describe("renderSkillTemplate", () => {
  it("변수를 치환한다", () => {
    const output = renderSkillTemplate(
      "Hello {{NAME}}, welcome to {{PLACE}}.",
      { NAME: "Alice", PLACE: "Wonderland" },
    );
    assert.equal(output, "Hello Alice, welcome to Wonderland.");
  });

  it("#if 조건부 블록 — truthy이면 포함한다", () => {
    const template = "start\n{{#if FLAG}}included{{/if}}\nend";
    const output = renderSkillTemplate(template, { FLAG: true });
    assert.equal(output, "start\nincluded\nend");
  });

  it("#if 조건부 블록 — falsy이면 제거한다", () => {
    const template = "start\n{{#if FLAG}}hidden{{/if}}\nend";
    const output = renderSkillTemplate(template, { FLAG: false });
    assert.equal(output, "start\n\nend");
  });

  it("#if 조건부 — 빈 문자열은 falsy로 취급한다", () => {
    const template = "{{#if EMPTY}}shown{{/if}}rest";
    const output = renderSkillTemplate(template, { EMPTY: "" });
    assert.equal(output, "rest");
  });

  it("#if 조건부 — 비어있지 않은 문자열은 truthy로 취급한다", () => {
    const template = "{{#if STR}}shown{{/if}}";
    const output = renderSkillTemplate(template, { STR: "hello" });
    assert.equal(output, "shown");
  });

  it("중첩 #if 블록을 처리한다", () => {
    const template = [
      "{{#if A}}",
      "A-start",
      "{{#if B}}",
      "AB-inner",
      "{{/if}}",
      "A-end",
      "{{/if}}",
    ].join("\n");

    const output = renderSkillTemplate(template, { A: true, B: true });
    assert.match(output, /A-start/);
    assert.match(output, /AB-inner/);
    assert.match(output, /A-end/);
  });

  it("중첩 #if — 외부 false면 내부도 제거한다", () => {
    const template = "{{#if A}}{{#if B}}inner{{/if}}{{/if}}rest";
    const output = renderSkillTemplate(template, { A: false, B: true });
    assert.equal(output, "rest");
  });

  it("partial include를 처리한다", () => {
    const output = renderSkillTemplate(
      "before\n{{> header}}\nafter",
      { TITLE: "Test" },
      { partials: { header: "# {{TITLE}}" } },
    );
    assert.equal(output, "before\n# Test\nafter");
  });

  it("partial 안의 변수도 치환한다", () => {
    const output = renderSkillTemplate(
      "{{> greeting}}",
      { WHO: "World" },
      { partials: { greeting: "Hello {{WHO}}!" } },
    );
    assert.equal(output, "Hello World!");
  });

  it("#include 디렉티브로 shared 템플릿 파일을 인라인 확장한다", () => {
    const root = makeTempDir();
    try {
      mkdirSync(join(root, "shared"), { recursive: true });
      writeFileSync(
        join(root, "shared", "telemetry-segment.md"),
        ["> **Telemetry**", ">", "> - Skill: `{{SKILL_NAME}}`"].join("\n"),
        "utf8",
      );

      const output = renderSkillTemplate("{{#include shared/telemetry-segment.md}}", {
        SKILL_NAME: "tfx-auto",
      }, {
        includeBaseDir: root,
      });

      assert.equal(output, ["> **Telemetry**", ">", "> - Skill: `tfx-auto`"].join("\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("변수 + #if + partial 통합 렌더링", () => {
    const template = [
      "{{> base}}",
      "{{#if DEEP}}",
      "{{> deep}}",
      "{{/if}}",
      "name={{SKILL_NAME}}",
    ].join("\n");

    const output = renderSkillTemplate(
      template,
      { SKILL_NAME: "tfx-deep-plan", SKILL_DESCRIPTION: "planner", DEEP: true },
      { partials: { base: "desc={{SKILL_DESCRIPTION}}", deep: "deep-on" } },
    );

    assert.match(output, /desc=planner/);
    assert.match(output, /deep-on/);
    assert.match(output, /name=tfx-deep-plan/);
  });

  // ── edge cases: errors ──

  it("누락된 변수는 Error를 던진다", () => {
    assert.throws(
      () => renderSkillTemplate("{{MISSING}}", {}),
      /Missing template variable: MISSING/,
    );
  });

  it("누락된 partial은 Error를 던진다", () => {
    assert.throws(
      () => renderSkillTemplate("{{> absent}}", {}, { partials: {} }),
      /Missing partial: absent/,
    );
  });

  it("누락된 #include 대상은 Error를 던진다", () => {
    const root = makeTempDir();
    try {
      assert.throws(
        () =>
          renderSkillTemplate("{{#include shared/missing.md}}", {}, {
            includeBaseDir: root,
          }),
        /Missing include: shared\/missing\.md/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("닫히지 않은 #if는 Error를 던진다", () => {
    assert.throws(
      () => renderSkillTemplate("{{#if A}}open", { A: true }),
      /Unclosed/,
    );
  });

  it("짝 없는 /if는 Error를 던진다", () => {
    assert.throws(
      () => renderSkillTemplate("content{{/if}}", {}),
      /Unexpected.*without matching/,
    );
  });

  it("순환 partial include는 Error를 던진다", () => {
    assert.throws(
      () =>
        renderSkillTemplate(
          "{{> a}}",
          {},
          { partials: { a: "{{> b}}", b: "{{> a}}" } },
        ),
      /Circular partial include/,
    );
  });

  it("자기 자신을 include하는 partial도 순환 에러를 던진다", () => {
    assert.throws(
      () =>
        renderSkillTemplate("{{> self}}", {}, { partials: { self: "{{> self}}" } }),
      /Circular partial include/,
    );
  });
});

// ── loadTemplatePartials ──

describe("loadTemplatePartials", () => {
  it("디렉토리에서 .md 파일을 partial로 로드한다", () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "header.md"), "# Header", "utf8");
      writeFileSync(join(root, "footer.md"), "---\nFooter", "utf8");

      const partials = loadTemplatePartials(root);
      assert.equal(partials.header, "# Header");
      assert.equal(partials.footer, "---\nFooter");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("중첩 디렉토리 파일을 경로 alias + basename alias로 로드한다", () => {
    const root = makeTempDir();
    try {
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", "telemetry.md"), "tel-content", "utf8");

      const partials = loadTemplatePartials(root);
      assert.equal(partials["sub/telemetry"], "tel-content");
      assert.equal(partials.telemetry, "tel-content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(".tmpl 파일도 partial로 로드한다", () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "snippet.tmpl"), "tmpl-content", "utf8");

      const partials = loadTemplatePartials(root);
      assert.equal(partials.snippet, "tmpl-content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("빈 디렉토리에서 빈 객체를 반환한다", () => {
    const root = makeTempDir();
    try {
      const partials = loadTemplatePartials(root);
      assert.deepEqual(partials, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("존재하지 않는 partial 디렉토리도 빈 객체로 처리한다", () => {
    const root = makeTempDir();
    try {
      const partials = loadTemplatePartials(join(root, "missing"));
      assert.deepEqual(partials, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("basename 충돌 시 먼저 발견된 것을 유지한다", () => {
    const root = makeTempDir();
    try {
      mkdirSync(join(root, "a"), { recursive: true });
      mkdirSync(join(root, "b"), { recursive: true });
      writeFileSync(join(root, "a", "note.md"), "from-a", "utf8");
      writeFileSync(join(root, "b", "note.md"), "from-b", "utf8");

      const partials = loadTemplatePartials(root);
      // basename "note" should exist and be one of them (first found wins)
      assert.ok(partials.note === "from-a" || partials.note === "from-b");
      // full paths should be distinct
      assert.equal(partials["a/note"], "from-a");
      assert.equal(partials["b/note"], "from-b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("edge cases — PRD lake4d 잔여", () => {
  it("frontmatter 중복 키는 마지막 값이 우선한다", () => {
    const src = "---\nname: first\nname: second\n---\nbody";
    const { data, body } = parseFrontmatter(src);
    assert.equal(data.name, "second");
    assert.equal(body, "body");
  });

  it("특수문자 포함 변수(FOO-BAR, FOO.BAR)를 치환한다", () => {
    const ctx = { "FOO-BAR": "dash", "FOO.BAR": "dot" };
    assert.equal(renderSkillTemplate("{{FOO-BAR}}", ctx), "dash");
    assert.equal(renderSkillTemplate("{{FOO.BAR}}", ctx), "dot");
  });

  it("1000줄 이상 템플릿을 에러 없이 렌더링한다", () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `line ${i}: {{NAME}}`);
    const tmpl = lines.join("\n");
    const result = renderSkillTemplate(tmpl, { NAME: "ok" });
    assert.ok(result.includes("line 0: ok"));
    assert.ok(result.includes("line 1199: ok"));
    assert.equal(result.split("\n").length, 1200);
  });
});
