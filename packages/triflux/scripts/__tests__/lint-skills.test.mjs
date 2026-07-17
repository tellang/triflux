import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { formatProblems, lintSkills } from "../lint-skills.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-lint-skills-"));
}

function writeSkill(root, name, content) {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
}

describe("lint-skills", () => {
  it("필수 frontmatter와 프로필 참조만 있는 스킬을 통과시킨다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      writeSkill(
        root,
        "tfx-valid",
        [
          "---",
          "name: tfx-valid",
          "description: >",
          "  한국어 설명으로 활성화 조건을 적는다.",
          "---",
          "",
          "# tfx-valid",
          "",
          "모델 선택은 `gpt55_high` 같은 프로필을 참조한다.",
        ].join("\n"),
      );

      const result = lintSkills({ skillsDir });
      assert.equal(result.ok, true);
      assert.equal(result.checked, 1);
      assert.deepEqual(result.problems, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("frontmatter description 누락을 problem/cause/fix로 보고한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      writeSkill(
        root,
        "tfx-missing-description",
        "---\nname: tfx-missing-description\n---\n본문",
      );

      const result = lintSkills({ skillsDir });
      assert.equal(result.ok, false);
      assert.equal(result.problems.length, 1);

      const report = formatProblems(result.problems);
      assert.match(report, /Problem: .*frontmatter description/);
      assert.match(report, /Cause: .*description/);
      assert.match(report, /Fix: .*description/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("본문에 하드코딩된 모델명을 실패 처리한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      writeSkill(
        root,
        "tfx-hardcoded-model",
        [
          "---",
          "name: tfx-hardcoded-model",
          "description: 한국어 설명",
          "---",
          "",
          "이 본문은 `gpt-5.5`를 직접 지정한다.",
        ].join("\n"),
      );

      const result = lintSkills({ skillsDir });
      assert.equal(result.ok, false);
      assert.equal(result.problems.length, 1);

      const report = formatProblems(result.problems);
      assert.match(report, /Problem: .*hardcoded model name.*gpt-5\.5/);
      assert.match(report, /Cause: .*프로필/);
      assert.match(report, /Fix: .*프로필/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("실행형 Agent 호출은 model=이 없으면 실패한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      writeSkill(
        root,
        "tfx-agent",
        '---\nname: tfx-agent\ndescription: 한국어 설명\n---\nAgent(subagent_type="explore", prompt="x")',
      );
      const result = lintSkills({ skillsDir });
      assert.equal(result.ok, false);
      assert.equal(result.problems[0]?.code, "agent-model-required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("model=이 있는 실행형 Agent와 prose signature는 통과한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      writeSkill(
        root,
        "tfx-agent-ok",
        '---\nname: tfx-agent-ok\ndescription: 한국어 설명\n---\nAgent()\nAgent(subagent_type="explore", model="haiku", prompt="x")',
      );
      const result = lintSkills({ skillsDir });
      assert.equal(result.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
