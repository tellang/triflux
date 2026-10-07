import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CODEX_AGENT_POLICY,
  DEFAULT_CODEX_AGENT,
  resolveCodexAgentPolicy,
  resolveCodexAgentProfile,
  resolveNestedCodexAgentProfile,
} from "../../scripts/lib/agent-route-policy.mjs";

describe("lane2-d routing contract: Codex agent policy SSOT", () => {
  it("unknown Codex role resolves to the canonical executor policy", () => {
    assert.equal(DEFAULT_CODEX_AGENT, "executor");
    assert.deepEqual(
      resolveCodexAgentPolicy("unknown-lane"),
      resolveCodexAgentPolicy("executor"),
    );
  });

  for (const agent of ["test-engineer", "qa-tester"]) {
    it(`${agent} keeps the canonical 1200 second timeout`, () => {
      assert.equal(resolveCodexAgentPolicy(agent).timeoutSec, 1200);
    });
  }

  it("preserves direct-Codex designer and writer overrides in the policy", () => {
    assert.equal(CODEX_AGENT_POLICY.designer.profile, "gpt6_astra_xhigh");
    assert.equal(CODEX_AGENT_POLICY.writer.profile, "gpt6_luna_high");
  });

  it("resolves max and top-level eligible ultra in the policy", () => {
    assert.equal(
      resolveCodexAgentProfile("architect", { profileOverride: "max" }),
      "gpt6_astra_max",
    );
    assert.equal(
      resolveCodexAgentProfile("deep-executor", {
        profileOverride: "ultra",
      }),
      "gpt6_astra_ultra",
    );
  });

  it("downgrades ineligible or nested ultra and lets retry snapshots win", () => {
    assert.equal(
      resolveCodexAgentProfile("architect", { profileOverride: "ultra" }),
      "gpt6_astra_max",
    );
    assert.equal(
      resolveCodexAgentProfile("scientist-deep", {
        profileOverride: "ultra",
        nested: true,
      }),
      "gpt6_astra_max",
    );
    assert.equal(
      resolveCodexAgentProfile("deep-executor", {
        profileOverride: "ultra",
        retryProfile: "gpt6_astra_max",
      }),
      "gpt6_astra_max",
    );
  });

  for (const [legacy, canonical] of [
    ["gpt56_sol_xhigh", "gpt6_astra_xhigh"],
    ["gpt56_sol_max", "gpt6_astra_max"],
    ["gpt56_sol_ultra", "gpt6_astra_ultra"],
    ["gpt56_terra_high", "gpt61_sol_high"],
    ["gpt56_terra_med", "gpt61_sol_med"],
    ["gpt56_luna_low", "gpt6_luna_low"],
    ["gpt6_sol_high", "gpt61_sol_high"],
    ["gpt6_sol_med", "gpt61_sol_med"],
  ]) {
    it(`${legacy} override를 ${canonical}으로 정규화한다`, () => {
      assert.equal(
        resolveCodexAgentProfile("deep-executor", {
          profileOverride: legacy,
        }),
        canonical,
      );
    });
  }

  it("headless roles ignore ordinary global profiles but retain max/ultra lanes", () => {
    assert.equal(
      resolveNestedCodexAgentProfile("architect", {
        globalProfile: "gpt61_sol_high",
      }),
      "gpt6_astra_xhigh",
    );
    assert.equal(
      resolveNestedCodexAgentProfile("executor", { globalProfile: "max" }),
      "gpt6_astra_max",
    );
  });
});

describe("lane2-d routing contract: Agent model guard", () => {
  it("generated native handoff resolves and includes model=", () => {
    const route = readFileSync(
      join(process.cwd(), "scripts/tfx-route.sh"),
      "utf8",
    );
    assert.match(route, /cli-claude\.mjs/);
    assert.match(route, /model="\$\{native_model\}"/);
    assert.match(route, /handoff model 해석 실패/);
  });
});

describe("lane2-d routing contract: SSOT-reading harness adapters", () => {
  const rootHarness = join(process.cwd(), "skills", "tfx-harness", "SKILL.md");
  const codexHarness = join(
    process.cwd(),
    "adapters",
    "codex",
    "skills",
    "tfx-harness",
    "SKILL.md",
  );

  for (const harness of [rootHarness, codexHarness]) {
    it(`${harness} returns exactly one branch and owner without copying a routing table`, () => {
      const content = readFileSync(harness, "utf8");
      assert.match(content, /\.claude\/rules\/tfx-routing\.md/);
      assert.match(content, /branch: D<n>/);
      assert.match(content, /owner: <exactly one immediate owner>/);
      assert.doesNotMatch(content, /\|\s*D0\s*\|/);
      assert.doesNotMatch(content, /\|\s*owner\s*\|/i);
    });
  }
});

describe("lane2-b trigger reduction: D2/D8 surfaces stay explicit-only", () => {
  const read = (...parts) =>
    readFileSync(join(process.cwd(), ...parts), "utf8");

  it("keeps quick references derived from the D8 owner boundary", () => {
    const routing = read(".claude", "rules", "tfx-routing.md");
    assert.match(
      routing,
      /\| 회고\/슬롭 정리 \| `\/gstack \/retro` 또는 명시 `tfx-auto --mode consensus` \|/,
    );
    assert.match(
      routing,
      /\| 정리 \| 대상 domain을 먼저 판정; 무수식 AI slop\/deslop은 host ai-slop-cleaner \| D8 참조 \(명시 TFX 3자 cleanup만 `tfx-auto --mode consensus`\) \|/,
    );
  });

  for (const [skill, forbiddenExamples] of [
    ["tfx-interview", ["/요구사항 분석", "/인터뷰"]],
  ]) {
    it(`${skill} does not advertise generic activation aliases`, () => {
      const content = read("skills", skill, "SKILL.md");
      assert.match(content, /명시 `tfx-/);
      for (const example of forbiddenExamples) {
        assert.doesNotMatch(
          content,
          new RegExp(example.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      }
    });
  }
});
