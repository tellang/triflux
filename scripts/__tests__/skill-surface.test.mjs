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

  it("keeps removed legacy compatibility aliases out of the packaged surface", () => {
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
      assert.equal(
        existsSync(join(skillsDir, name, "SKILL.md")),
        false,
        `${name} must stay removed from the packaged skill surface`,
      );
    }
  });
});

describe("skill surface cleanup (9 + Windows 1)", () => {
  const KEPT = [
    "tfx-auto",
    "tfx-doctor",
    "tfx-harness",
    "tfx-live",
    "tfx-remote",
    "tfx-research",
    "tfx-review",
    "tfx-setup",
    "tfx-ship",
    "tfx-wt",
  ];

  for (const root of ["skills", join("packages", "triflux", "skills")]) {
    it(`${root}: 스킬은 승인된 10개뿐이다`, () => {
      const names = readdirSync(join(repoRoot, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => existsSync(join(repoRoot, root, name, "SKILL.md")))
        .sort();
      assert.deepEqual(names, [...KEPT].sort());
    });
  }

  it("tfx-wt 는 frontmatter platform 으로 win32 전용을 선언한다", () => {
    assert.deepEqual(readSkillFrontmatter("tfx-wt").platform, ["win32"]);
  });

  it("tfx-setup 은 설정을 안내하고 tfx-doctor 는 hub 관리를 안내한다", () => {
    const setup = readFileSync(
      join(skillsDir, "tfx-setup", "SKILL.md"),
      "utf8",
    );
    const doctor = readFileSync(
      join(skillsDir, "tfx-doctor", "SKILL.md"),
      "utf8",
    );
    assert.match(setup, /^#### 단계 1: 파일 동기화$/m);
    assert.doesNotMatch(setup, /triflux hooks apply/);
    assert.match(doctor, /^## tfx-hub 관리$/m);
    assert.match(doctor, /tfx hub status/);
  });
});
