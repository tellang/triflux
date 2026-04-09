import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildContextUsageView } from "../../hud/context-monitor.mjs";
import { generateSkillDocs } from "../../scripts/gen-skill-docs.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-lake4-integration-"));
}

describe("lake4 integration", () => {
  it("gen-skill-docs 파이프라인이 템플릿/partial을 실제 출력으로 변환한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const templatesDir = join(skillsDir, "_templates");
      const basicSkillDir = join(skillsDir, "tfx-basic");
      const deepSkillDir = join(skillsDir, "tfx-deep-worker");

      mkdirSync(templatesDir, { recursive: true });
      mkdirSync(basicSkillDir, { recursive: true });
      mkdirSync(deepSkillDir, { recursive: true });

      writeFileSync(
        join(templatesDir, "header.md"),
        "# {{SKILL_NAME}}",
        "utf8",
      );
      writeFileSync(
        join(templatesDir, "summary.md"),
        "desc={{SKILL_DESCRIPTION}}",
        "utf8",
      );
      writeFileSync(
        join(templatesDir, "deep.md"),
        "deep-enabled={{SKILL_NAME}}",
        "utf8",
      );
      writeFileSync(join(templatesDir, "footer.md"), "eof", "utf8");

      writeFileSync(
        join(basicSkillDir, "SKILL.md.tmpl"),
        [
          "---",
          "name: tfx-basic",
          "description: basic mode",
          "---",
          "{{> header}}",
          "{{> summary}}",
          "{{#if DEEP}}",
          "{{> deep}}",
          "{{/if}}",
          "{{> footer}}",
        ].join("\n"),
        "utf8",
      );

      writeFileSync(
        join(deepSkillDir, "SKILL.md.tmpl"),
        [
          "---",
          "name: tfx-deep-worker",
          "description: deep mode",
          "---",
          "{{> header}}",
          "{{> summary}}",
          "{{#if DEEP}}",
          "{{> deep}}",
          "{{/if}}",
          "{{> footer}}",
        ].join("\n"),
        "utf8",
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: true,
      });
      assert.equal(result.count, 2);

      const basicOut = readFileSync(join(basicSkillDir, "SKILL.md"), "utf8");
      const deepOut = readFileSync(join(deepSkillDir, "SKILL.md"), "utf8");

      assert.equal(
        basicOut,
        [
          "---",
          "name: tfx-basic",
          "description: basic mode",
          "---",
          "# tfx-basic",
          "desc=basic mode",
          "",
          "eof",
        ].join("\n"),
      );
      assert.equal(
        deepOut,
        [
          "---",
          "name: tfx-deep-worker",
          "description: deep mode",
          "---",
          "# tfx-deep-worker",
          "desc=deep mode",
          "",
          "deep-enabled=tfx-deep-worker",
          "",
          "eof",
        ].join("\n"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildContextUsageView가 포맷/임계값 분류를 일관되게 연결한다", () => {
    const infoView = buildContextUsageView(
      {
        context_window: {
          context_window_size: 1_000,
          current_usage: {
            input_tokens: 450,
            cache_read_input_tokens: 150,
          },
        },
      },
      {
        usedTokens: 10,
        limitTokens: 1_000,
      },
    );

    assert.equal(infoView.display, "600/1K (60%)");
    assert.equal(infoView.warningLevel, "info");
    assert.equal(infoView.source, "stdin.tokens");

    const criticalView = buildContextUsageView(
      {},
      {
        usedTokens: 900,
        limitTokens: 1_000,
      },
    );

    assert.equal(criticalView.display, "900/1K (90%)");
    assert.equal(criticalView.warningLevel, "critical");
    assert.equal(criticalView.source, "monitor");
  });
});
