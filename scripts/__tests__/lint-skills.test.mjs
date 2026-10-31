import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DISTRIBUTED_RULES,
  formatProblems,
  lintSkills,
} from "../lint-skills.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 실제 tarball 은 packages/triflux 에서 만든다. 루트 목록만 고치면 설치본에 안 들어간다.
describe("배포 규칙 문서 목록", () => {
  for (const manifest of ["package.json", "packages/triflux/package.json"]) {
    it(`${manifest} files 에 DISTRIBUTED_RULES 가 모두 있다`, () => {
      const { files } = JSON.parse(
        readFileSync(join(REPO_ROOT, manifest), "utf8"),
      );
      for (const rule of DISTRIBUTED_RULES) {
        assert.ok(files.includes(`.claude/rules/${rule}`), rule);
      }
    });
  }
});

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-lint-skills-"));
}

const FRONT = "---\nname: tfx-x\ndescription: 한국어 설명\n---\n";
const lines = (n, prefix = "줄") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");

function writeRef(root, skill, file, content) {
  const path = join(root, "skills", skill, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function codesOf(root) {
  return lintSkills({ skillsDir: join(root, "skills") }).problems.map(
    (problem) => problem.code,
  );
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

  it("문자열 안의 괄호가 있어도 model=이 있는 실행형 Agent를 통과시킨다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      writeSkill(
        root,
        "tfx-agent-nested-model",
        '---\nname: tfx-agent-nested-model\ndescription: 한국어 설명\n---\nAgent(subagent_type="x", prompt="do (this)", model="haiku")',
      );
      const result = lintSkills({ skillsDir });
      assert.equal(result.ok, true);
      assert.deepEqual(result.problems, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("문자열 안의 괄호가 있어도 model= 없는 실행형 Agent를 실패 처리한다", () => {
    const root = makeTempDir();
    try {
      const skillsDir = join(root, "skills");
      writeSkill(
        root,
        "tfx-agent-nested-missing-model",
        '---\nname: tfx-agent-nested-missing-model\ndescription: 한국어 설명\n---\nAgent(prompt="foo(bar)", subagent_type="x")',
      );
      const result = lintSkills({ skillsDir });
      assert.equal(result.ok, false);
      assert.equal(result.problems.length, 1);
      assert.equal(result.problems[0]?.code, "agent-model-required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("스킬 품질 규칙", () => {
    it("본문이 500줄을 넘으면 실패하고 frontmatter는 세지 않는다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-long", FRONT + lines(501));
        writeSkill(root, "tfx-ok", FRONT + lines(500));
        const problems = lintSkills({
          skillsDir: join(root, "skills"),
        }).problems;
        assert.deepEqual(
          problems.map((p) => [p.file, p.code]),
          [["skills/tfx-long/SKILL.md", "skill-body-too-long"]],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("100줄 넘는 reference는 앞부분에 목차가 있어야 한다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-x", `${FRONT}references/a.md references/b.md`);
        writeRef(root, "tfx-x", "references/a.md", lines(101));
        writeRef(root, "tfx-x", "references/b.md", `## 목차\n${lines(101)}`);
        assert.deepEqual(codesOf(root), ["reference-missing-toc"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("SKILL.md가 언급하지 않는 reference를 실패 처리한다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-x", FRONT + "본문");
        writeRef(root, "tfx-x", "references/orphan.md", "내용");
        assert.deepEqual(codesOf(root), ["reference-not-linked"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("reference가 같은 스킬의 다른 reference를 가리키면 실패한다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-x", `${FRONT}a.md b.md`);
        writeRef(root, "tfx-x", "a.md", "b.md 를 보라");
        writeRef(root, "tfx-x", "b.md", "끝");
        assert.deepEqual(codesOf(root), ["reference-nested-link"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("마지막 개행은 줄 수에 더하지 않는다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-x", `${FRONT}${lines(499)}\nreferences/a.md\n`);
        writeRef(root, "tfx-x", "references/a.md", `${lines(100)}\n`);
        assert.deepEqual(codesOf(root), []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("파일명이 다른 이름의 일부일 뿐이면 연결로 보지 않는다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-x", `${FRONT}references/long-guide.md`);
        writeRef(root, "tfx-x", "references/long-guide.md", "내용");
        writeRef(root, "tfx-x", "references/guide.md", "내용");
        assert.deepEqual(codesOf(root), ["reference-not-linked"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("이름이 같은 reference는 경로로 구분한다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-x", `${FRONT}references/a/guide.md`);
        writeRef(root, "tfx-x", "references/a/guide.md", "내용");
        writeRef(root, "tfx-x", "references/b/guide.md", "내용");
        assert.deepEqual(codesOf(root), ["reference-not-linked"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("reference 안의 비슷한 파일명은 2단계 참조로 보지 않는다", () => {
      const root = makeTempDir();
      try {
        writeSkill(root, "tfx-x", `${FRONT}a.md guide.md`);
        writeRef(root, "tfx-x", "a.md", "long-guide.md 는 다른 스킬 문서다");
        writeRef(root, "tfx-x", "guide.md", "끝");
        assert.deepEqual(codesOf(root), []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("배포되지 않는 .claude/rules 문서를 가리키면 실패하고 허용 목록은 통과한다", () => {
      const root = makeTempDir();
      try {
        writeSkill(
          root,
          "tfx-bad",
          `${FRONT}.claude/rules/tfx-escalation-chain.md`,
        );
        writeSkill(
          root,
          "tfx-good",
          `${FRONT}.claude/rules/tfx-routing.md .claude/rules/tfx-psmux.md`,
        );
        const problems = lintSkills({
          skillsDir: join(root, "skills"),
        }).problems;
        assert.deepEqual(
          problems.map((p) => [p.file, p.code]),
          [["skills/tfx-bad/SKILL.md", "undistributed-rules-reference"]],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
