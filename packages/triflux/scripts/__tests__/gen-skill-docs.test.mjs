import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { generateSkillDocs } from "../gen-skill-docs.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-gen-skill-docs-"));
}

describe("gen-skill-docs", () => {
  it("SKILL.md.tmpl 파일을 SKILL.md로 생성한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const templatesDir = join(skillsDir, "_templates");
      const skillDir = join(skillsDir, "tfx-sample");

      mkdirSync(templatesDir, { recursive: true });
      mkdirSync(skillDir, { recursive: true });

      writeFileSync(join(templatesDir, "base.md"), "BASE {{SKILL_NAME}}", "utf8");
      writeFileSync(join(templatesDir, "deep.md"), "DEEP BLOCK", "utf8");

      writeFileSync(
        join(skillDir, "SKILL.md.tmpl"),
        [
          "---",
          "name: tfx-sample",
          "description: sample skill",
          "---",
          "{{> base}}",
          "{{#if DEEP}}",
          "{{> deep}}",
          "{{/if}}",
        ].join("\n"),
        "utf8",
      );

      const result = generateSkillDocs({ skillsDir, templatesDir, write: true });
      assert.equal(result.count, 1);

      const output = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      assert.match(output, /BASE tfx-sample/);
      assert.doesNotMatch(output, /DEEP BLOCK/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deep 스킬은 DEEP 조건부 섹션을 포함한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const templatesDir = join(skillsDir, "_templates");
      const skillDir = join(skillsDir, "tfx-deep-sample");

      mkdirSync(templatesDir, { recursive: true });
      mkdirSync(skillDir, { recursive: true });

      writeFileSync(join(templatesDir, "base.md"), "BASE", "utf8");
      writeFileSync(join(templatesDir, "deep.md"), "DEEP {{SKILL_NAME}}", "utf8");
      writeFileSync(
        join(skillDir, "SKILL.md.tmpl"),
        [
          "---",
          "name: tfx-deep-sample",
          "description: deep sample",
          "---",
          "{{> base}}",
          "{{#if DEEP}}",
          "{{> deep}}",
          "{{/if}}",
        ].join("\n"),
        "utf8",
      );

      generateSkillDocs({ skillsDir, templatesDir, write: true });
      const output = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      assert.match(output, /DEEP tfx-deep-sample/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
