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

describe("skill surface cleanup (12 + Windows 1)", () => {
  const KEPT = [
    "tfx-auto",
    "tfx-doctor",
    "tfx-harness",
    "tfx-interview",
    "tfx-live",
    "tfx-plan",
    "tfx-profile",
    "tfx-remote",
    "tfx-research",
    "tfx-review",
    "tfx-setup",
    "tfx-ship",
    "tfx-wt",
  ];
  const REMOVED = [
    "tfx-analysis",
    "tfx-find",
    "tfx-forge",
    "tfx-goal-clarify",
    "tfx-hooks",
    "tfx-hub",
    "tfx-index",
    "tfx-prune",
    "tfx-qa",
    "tfx-ralph",
  ];

  for (const root of ["skills", join("packages", "triflux", "skills")]) {
    it(`${root}: tfx-* 스킬은 승인된 13개뿐이다`, () => {
      const names = readdirSync(join(repoRoot, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name.startsWith("tfx-"))
        .filter((name) => existsSync(join(repoRoot, root, name, "SKILL.md")))
        .sort();
      assert.deepEqual(names, [...KEPT].sort());
      for (const name of REMOVED) {
        assert.equal(names.includes(name), false, `${name} must stay removed`);
      }
    });
  }

  it("tfx-wt 는 frontmatter platform 으로 win32 전용을 선언한다", () => {
    assert.deepEqual(readSkillFrontmatter("tfx-wt").platform, ["win32"]);
  });

  it("tfx-interview 는 /goal 블록 모드를 흡수했다", () => {
    const content = readFileSync(
      join(skillsDir, "tfx-interview", "SKILL.md"),
      "utf8",
    );
    assert.match(readSkillFrontmatter("tfx-interview").description, /\/goal/);
    assert.match(content, /--format goal/);
    for (const axis of [
      "End state",
      "Stated check",
      "Constraints",
      "Stop bound",
    ]) {
      assert.match(content, new RegExp(axis), `${axis} 축 누락`);
    }
  });

  it("tfx-setup 은 훅 우선순위 관리를, tfx-doctor 는 hub 관리를 흡수했다", () => {
    const setup = readFileSync(
      join(skillsDir, "tfx-setup", "SKILL.md"),
      "utf8",
    );
    const doctor = readFileSync(
      join(skillsDir, "tfx-doctor", "SKILL.md"),
      "utf8",
    );
    assert.match(setup, /^## 훅 우선순위 관리$/m);
    assert.match(setup, /triflux hooks apply/);
    assert.match(doctor, /^## tfx-hub 관리$/m);
    assert.match(doctor, /tfx hub status/);
  });
});
