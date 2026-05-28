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

import { generateSkillManifests } from "../gen-skill-manifest.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-gen-skill-manifest-"));
}

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
          "deprecated: true",
          "superseded-by: tfx-auto",
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
      assert.equal(manifest.deprecated, true);
      assert.equal(manifest.superseded_by, "tfx-auto");
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
