import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyRiskTier } from "../../hub/lib/risk-tier.mjs";

describe("hub/lib/risk-tier.mjs", () => {
  describe("low classification", () => {
    it("빈 changedFiles 는 low", () => {
      assert.equal(classifyRiskTier({ changedFiles: [] }), "low");
    });

    it("단일 markdown 파일은 low", () => {
      assert.equal(classifyRiskTier({ changedFiles: ["README.md"] }), "low");
    });

    it("단일 txt 파일은 low", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["notes/todo.txt"] }),
        "low",
      );
    });

    it("단일 test 파일은 low", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["tests/unit/foo.test.mjs"] }),
        "low",
      );
    });

    it("단일 하위 경로 markdown 파일도 low", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["docs/guides/howto.md"] }),
        "low",
      );
    });
  });

  describe("medium classification", () => {
    it("기본 fallback 은 medium", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["src/index.mjs"] }),
        "medium",
      );
    });

    it("package.json 변경은 medium", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["package.json"] }),
        "medium",
      );
    });

    it("yaml 변경은 medium", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["ci/workflow.yaml"] }),
        "medium",
      );
    });

    it("toml 변경은 medium", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["settings/app.toml"] }),
        "medium",
      );
    });

    it("config prefix 변경은 medium", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["config/runtime.env.example"] }),
        "medium",
      );
    });

    it("다중 low-only 파일이어도 medium", () => {
      assert.equal(
        classifyRiskTier({
          changedFiles: ["docs/guide.md", "notes/summary.txt"],
        }),
        "medium",
      );
    });
  });

  describe("high classification", () => {
    it("hub prefix 변경은 high", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["hub/core.mjs"] }),
        "high",
      );
    });

    it("scripts prefix 변경은 high", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["scripts/build.mjs"] }),
        "high",
      );
    });

    it(".claude/rules prefix 변경은 high", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: [".claude/rules/policy.md"] }),
        "high",
      );
    });

    it("bin prefix 변경은 high", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["bin/launch.ps1"] }),
        "high",
      );
    });

    it(".github prefix 변경은 high", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: [".github/workflows/ci.yml"] }),
        "high",
      );
    });
  });

  describe("matrix priority", () => {
    it("high + low mixed case 는 high", () => {
      assert.equal(
        classifyRiskTier({
          changedFiles: ["docs/readme.md", "hub/lib/risk-tier.mjs"],
        }),
        "high",
      );
    });

    it("high > medium > low 우선순위를 유지", () => {
      assert.equal(
        classifyRiskTier({
          changedFiles: [
            "package.json",
            "notes/summary.txt",
            "scripts/test.mjs",
          ],
        }),
        "high",
      );
    });

    it("medium + low mixed case 는 medium", () => {
      assert.equal(
        classifyRiskTier({
          changedFiles: ["README.md", "hooks/pre-commit"],
        }),
        "medium",
      );
    });
  });

  describe("auto classification matrix coverage", () => {
    it("단일 non-config markdown 는 low", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["skills/tfx-auto/SKILL.md"] }),
        "low",
      );
    });

    it("단일 non-config txt 는 low", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["docs/changelog.txt"] }),
        "low",
      );
    });

    it("단일 .test 파일만 변경되면 low", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["src/runtime-check.test.mjs"] }),
        "low",
      );
    });

    it("다중 low-only 파일은 auto 에서 medium", () => {
      assert.equal(
        classifyRiskTier({
          changedFiles: ["docs/one.md", "tests/unit/two.test.mjs"],
        }),
        "medium",
      );
    });

    it("다중 파일 + runtime 영향 config 변경은 medium", () => {
      assert.equal(
        classifyRiskTier({
          changedFiles: ["README.md", "config/defaults.json"],
        }),
        "medium",
      );
    });

    it("build json 변경은 medium", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["packages/app/package.json"] }),
        "medium",
      );
    });

    it("아키텍처 경로 변경은 high", () => {
      assert.equal(
        classifyRiskTier({ changedFiles: ["hub/router/index.mjs"] }),
        "high",
      );
    });

    it("mixed high + low 는 auto 에서도 high", () => {
      assert.equal(
        classifyRiskTier({
          changedFiles: ["notes/plan.md", ".github/workflows/release.yml"],
        }),
        "high",
      );
    });
  });
});
