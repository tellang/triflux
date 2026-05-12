import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseFrontmatter } from "../lib/skill-template.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");
const skillsDir = join(repoRoot, "skills");

function readSkillFrontmatter(name) {
  const skillPath = join(skillsDir, name, "SKILL.md");
  assert.equal(existsSync(skillPath), true, `${name} SKILL.md missing`);
  return parseFrontmatter(readFileSync(skillPath, "utf8")).data;
}

function listSkillFrontmatter() {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => readSkillFrontmatter(entry.name))
    .filter((data) => data.name);
}

describe("skill surface consolidation (#112)", () => {
  it("keeps the public core skill surface at or below the target size", () => {
    const coreSkills = listSkillFrontmatter().filter(
      (data) => data.internal !== true && data.deprecated !== true,
    );

    assert.ok(
      coreSkills.length <= 15,
      `expected <=15 public core skills, got ${coreSkills.length}: ${coreSkills
        .map((skill) => skill.name)
        .sort()
        .join(", ")}`,
    );
  });

  it("marks legacy compatibility aliases as deprecated and superseded", () => {
    const expectedAliases = [
      "tfx-autopilot",
      "tfx-consensus",
      "tfx-debate",
      "tfx-fullcycle",
      "tfx-multi",
      "tfx-panel",
      "tfx-persist",
      "tfx-psmux-rules",
      "tfx-remote-setup",
      "tfx-remote-spawn",
      "tfx-swarm",
    ];

    for (const name of expectedAliases) {
      const data = readSkillFrontmatter(name);
      assert.equal(data.deprecated, true, `${name} must be deprecated`);
      assert.ok(data["superseded-by"], `${name} must declare superseded-by`);
    }
  });
});
