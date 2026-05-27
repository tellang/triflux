// tests/unit/gen-skill-docs.test.mjs — gen-skill-docs.mjs deprecation guard
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { generateSkillDocs } from "../../scripts/gen-skill-docs.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-gen-docs-deprecated-"));
}

describe("generateSkillDocs", () => {
  it("SKILL.md.tmpl을 SKILL.md로 생성하지 않는 deprecated no-op이다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      const templatesDir = join(skillsDir, "_templates");
      const skillDir = join(skillsDir, "tfx-sample");

      mkdirSync(templatesDir, { recursive: true });
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(templatesDir, "base.md"), "{{SKILL_NAME}}", "utf8");
      writeFileSync(
        join(skillDir, "SKILL.md.tmpl"),
        "---\nname: tfx-sample\ndescription: sample\n---\n{{> base}}",
        "utf8",
      );

      const result = generateSkillDocs({
        skillsDir,
        templatesDir,
        write: true,
      });

      assert.equal(result.deprecated, true);
      assert.equal(result.count, 0);
      assert.deepEqual(result.generated, []);
      assert.match(result.message, /deprecated/);
      assert.equal(existsSync(join(skillDir, "SKILL.md")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skillsDir 누락은 기존처럼 사용 오류로 실패한다", () => {
    assert.throws(() => generateSkillDocs(), /skillsDir is required/);
  });
});
