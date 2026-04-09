import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { generateSkillDocs } from "../gen-skill-docs.mjs";
import { generateSkillManifests } from "../gen-skill-manifest.mjs";

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

      writeFileSync(
        join(templatesDir, "base.md"),
        "BASE {{SKILL_NAME}}",
        "utf8",
      );
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

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: true,
      });
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
      writeFileSync(
        join(templatesDir, "deep.md"),
        "DEEP {{SKILL_NAME}}",
        "utf8",
      );
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

  it("partial 내부의 {{#include}}를 해석한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const templatesDir = join(skillsDir, "_templates");
      const sharedDir = join(skillsDir, "shared");
      const skillDir = join(skillsDir, "tfx-inc");

      mkdirSync(templatesDir, { recursive: true });
      mkdirSync(sharedDir, { recursive: true });
      mkdirSync(skillDir, { recursive: true });

      writeFileSync(join(sharedDir, "args.md"), "ARGS={{SKILL_NAME}}", "utf8");
      writeFileSync(
        join(templatesDir, "base.md"),
        "{{#include shared/args.md}}",
        "utf8",
      );
      writeFileSync(
        join(skillDir, "SKILL.md.tmpl"),
        "---\nname: tfx-inc\ndescription: inc test\n---\n{{> base}}\nend",
        "utf8",
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: true,
      });
      assert.equal(result.count, 1);

      const output = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      assert.match(output, /ARGS=tfx-inc/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gen-skill-manifest", () => {
  it("SKILL.md frontmatter에서 skill.json을 생성한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const skillDir = join(skillsDir, "tfx-manifest-test");

      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: tfx-manifest-test",
          "description: test manifest",
          "triggers:",
          "  - test",
          "  - manifest",
          "argument-hint: <arg>",
          "internal: true",
          "---",
          "body",
        ].join("\n"),
        "utf8",
      );

      const result = generateSkillManifests({ skillsDir, write: true });
      assert.equal(result.count, 1);

      const manifest = JSON.parse(
        readFileSync(join(skillDir, "skill.json"), "utf8"),
      );
      assert.equal(manifest.name, "tfx-manifest-test");
      assert.equal(manifest.description, "test manifest");
      assert.deepEqual(manifest.triggers, ["test", "manifest"]);
      assert.equal(manifest.argument_hint, "<arg>");
      assert.equal(manifest.internal, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("frontmatter가 없는 SKILL.md는 건너뛴다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const skillDir = join(skillsDir, "tfx-no-fm");

      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "no frontmatter", "utf8");

      const result = generateSkillManifests({ skillsDir, write: true });
      assert.equal(result.count, 0);
      assert.equal(existsSync(join(skillDir, "skill.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
