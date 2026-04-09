// tests/unit/gen-skill-docs.test.mjs — gen-skill-docs.mjs 단위 테스트
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateSkillDocs } from "../../scripts/gen-skill-docs.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-gen-docs-test-"));
}

function setupSkillsDir(root, skills, templates) {
  const skillsDir = join(root, "skills");
  const templatesDir = join(skillsDir, "_templates");
  mkdirSync(templatesDir, { recursive: true });

  for (const [name, content] of Object.entries(templates)) {
    writeFileSync(join(templatesDir, name), content, "utf8");
  }

  for (const [dirName, tmplContent] of Object.entries(skills)) {
    const dir = join(skillsDir, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md.tmpl"), tmplContent, "utf8");
  }

  return { skillsDir, templatesDir };
}

function normalizeEol(value) {
  return value.replace(/\r\n/g, "\n");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoSkillsDir = join(repoRoot, "skills");

describe("generateSkillDocs", () => {
  it("SKILL.md.tmpl을 렌더링하여 SKILL.md를 생성한다", () => {
    const root = makeTempDir();
    try {
      const { skillsDir, templatesDir } = setupSkillsDir(
        root,
        {
          "tfx-sample": [
            "---",
            "name: tfx-sample",
            "description: sample skill",
            "---",
            "# {{SKILL_NAME}}",
            "{{SKILL_DESCRIPTION}}",
          ].join("\n"),
        },
        { "base.md": "base-partial" },
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: true,
      });
      assert.equal(result.count, 1);

      const output = readFileSync(
        join(skillsDir, "tfx-sample", "SKILL.md"),
        "utf8",
      );
      assert.match(output, /# tfx-sample/);
      assert.match(output, /sample skill/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deep 스킬은 DEEP 조건부 섹션을 포함한다", () => {
    const root = makeTempDir();
    try {
      const { skillsDir, templatesDir } = setupSkillsDir(
        root,
        {
          "tfx-deep-test": [
            "---",
            "name: tfx-deep-test",
            "description: deep tester",
            "---",
            "{{#if DEEP}}DEEP_SECTION{{/if}}",
          ].join("\n"),
        },
        {},
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: true,
      });
      const output = readFileSync(
        join(skillsDir, "tfx-deep-test", "SKILL.md"),
        "utf8",
      );
      assert.match(output, /DEEP_SECTION/);
      assert.equal(result.count, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("non-deep 스킬은 DEEP 블록을 제외한다", () => {
    const root = makeTempDir();
    try {
      const { skillsDir, templatesDir } = setupSkillsDir(
        root,
        {
          "tfx-light": [
            "---",
            "name: tfx-light",
            "description: light skill",
            "---",
            "visible\n{{#if DEEP}}hidden{{/if}}",
          ].join("\n"),
        },
        {},
      );

      generateSkillDocs({ skillsDir, templatesDir, write: true });
      const output = readFileSync(
        join(skillsDir, "tfx-light", "SKILL.md"),
        "utf8",
      );
      assert.match(output, /visible/);
      assert.doesNotMatch(output, /hidden/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("write=false이면 파일을 생성하지 않고 렌더 결과만 반환한다", () => {
    const root = makeTempDir();
    try {
      const { skillsDir, templatesDir } = setupSkillsDir(
        root,
        {
          "tfx-dry": [
            "---",
            "name: tfx-dry",
            "description: dry run",
            "---",
            "{{SKILL_NAME}}",
          ].join("\n"),
        },
        {},
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: false,
      });
      assert.equal(result.count, 1);
      assert.match(result.generated[0].rendered, /tfx-dry/);

      // SKILL.md should NOT exist
      assert.throws(() => {
        readFileSync(join(skillsDir, "tfx-dry", "SKILL.md"), "utf8");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("여러 스킬을 한꺼번에 생성한다", () => {
    const root = makeTempDir();
    try {
      const { skillsDir, templatesDir } = setupSkillsDir(
        root,
        {
          "tfx-a": "---\nname: tfx-a\ndescription: A\n---\n{{SKILL_NAME}}",
          "tfx-b": "---\nname: tfx-b\ndescription: B\n---\n{{SKILL_NAME}}",
        },
        {},
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: true,
      });
      assert.equal(result.count, 2);
      assert.deepEqual(
        result.generated.map((entry) => entry.relativeTemplatePath),
        ["tfx-a/SKILL.md.tmpl", "tfx-b/SKILL.md.tmpl"],
      );

      const a = readFileSync(join(skillsDir, "tfx-a", "SKILL.md"), "utf8");
      const b = readFileSync(join(skillsDir, "tfx-b", "SKILL.md"), "utf8");
      assert.match(a, /tfx-a/);
      assert.match(b, /tfx-b/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("_templates/ 안의 .tmpl 파일은 스킬로 취급하지 않는다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const templatesDir = join(skillsDir, "_templates");
      mkdirSync(templatesDir, { recursive: true });

      // This SKILL.md.tmpl inside _templates should be ignored
      writeFileSync(
        join(templatesDir, "SKILL.md.tmpl"),
        "---\nname: internal\n---\n{{SKILL_NAME}}",
        "utf8",
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: false,
      });
      assert.equal(result.count, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skillsDir가 없으면 에러를 던진다", () => {
    assert.throws(() => generateSkillDocs());
  });

  it("partial include와 변수를 함께 사용하는 통합 시나리오", () => {
    const root = makeTempDir();
    try {
      const { skillsDir, templatesDir } = setupSkillsDir(
        root,
        {
          "tfx-full": [
            "---",
            "name: tfx-full",
            "description: full test",
            "---",
            "{{> base}}",
            "{{#if DEEP}}",
            "{{> deep}}",
            "{{/if}}",
            "End: {{SKILL_NAME}}",
          ].join("\n"),
        },
        {
          "base.md": "Base: {{SKILL_DESCRIPTION}}",
          "deep.md": "Deep consensus block",
        },
      );

      generateSkillDocs({ skillsDir, templatesDir, write: true });
      const output = readFileSync(
        join(skillsDir, "tfx-full", "SKILL.md"),
        "utf8",
      );
      assert.match(output, /Base: full test/);
      assert.doesNotMatch(output, /Deep consensus/);
      assert.match(output, /End: tfx-full/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("실제 tfx-find, tfx-index 템플릿 dry-run 결과가 체크인된 SKILL.md와 일치한다", () => {
    const result = generateSkillDocs({
      skillsDir: repoSkillsDir,
      write: false,
    });
    const selected = result.generated.filter((entry) =>
      ["tfx-find/SKILL.md.tmpl", "tfx-index/SKILL.md.tmpl"].includes(
        entry.relativeTemplatePath,
      ),
    );

    assert.equal(selected.length, 2);

    for (const entry of selected) {
      const committed = readFileSync(entry.outputPath, "utf8");
      assert.equal(normalizeEol(entry.rendered), normalizeEol(committed));
    }
  });
});
