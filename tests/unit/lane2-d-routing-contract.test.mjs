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
import {
  compileRules,
  loadRules,
  matchRules,
  resolveConflicts,
} from "../../scripts/lib/keyword-rules.mjs";

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
    assert.equal(CODEX_AGENT_POLICY.designer.profile, "gpt56_sol_xhigh");
    assert.equal(CODEX_AGENT_POLICY.writer.profile, "gpt56_luna_low");
  });

  it("resolves max and top-level eligible ultra in the policy", () => {
    assert.equal(
      resolveCodexAgentProfile("architect", { profileOverride: "max" }),
      "gpt56_sol_max",
    );
    assert.equal(
      resolveCodexAgentProfile("deep-executor", {
        profileOverride: "ultra",
      }),
      "gpt56_sol_ultra",
    );
  });

  it("downgrades ineligible or nested ultra and lets retry snapshots win", () => {
    assert.equal(
      resolveCodexAgentProfile("architect", { profileOverride: "ultra" }),
      "gpt56_sol_max",
    );
    assert.equal(
      resolveCodexAgentProfile("scientist-deep", {
        profileOverride: "ultra",
        nested: true,
      }),
      "gpt56_sol_max",
    );
    assert.equal(
      resolveCodexAgentProfile("deep-executor", {
        profileOverride: "ultra",
        retryProfile: "gpt56_sol_max",
      }),
      "gpt56_sol_max",
    );
  });

  it("headless roles ignore ordinary global profiles but retain max/ultra lanes", () => {
    assert.equal(
      resolveNestedCodexAgentProfile("architect", {
        globalProfile: "gpt56_terra_high",
      }),
      "gpt56_sol_xhigh",
    );
    assert.equal(
      resolveNestedCodexAgentProfile("executor", { globalProfile: "max" }),
      "gpt56_sol_max",
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

describe("lane2-d routing contract: locked prompt matrix", () => {
  const compiledRules = compileRules(
    loadRules(join(process.cwd(), "hooks", "keyword-rules.json")),
  );
  const firstMatch = (prompt) =>
    resolveConflicts(matchRules(compiledRules, prompt))[0];

  for (const [prompt, id, skill] of [
    ["사이트 QA 해줘", "gstack-qa-browser", "qa"],
    ["AI 슬롭 정리해줘", "host-ai-slop-cleaner", "ai-slop-cleaner"],
    ["보안 검토해줘", "gstack-cso", "cso"],
    ["이번 주 회고해줘", "gstack-retro", "retro"],
    ["PR 만들어줘", "gstack-ship", "ship"],
    ["배포 검증해줘", "tfx-ship", "tfx-ship"],
  ]) {
    it(`${prompt} routes to its locked immediate owner`, () => {
      const result = firstMatch(prompt);
      assert.equal(result?.id, id);
      assert.equal(result?.skill, skill);
    });
  }

  it("generic cleanup does not force a cleanup owner", () => {
    assert.equal(firstMatch("정리해줘"), undefined);
  });

  it("explicit TFX cleanup remains qualified", () => {
    const result = firstMatch("tfx-prune으로 3자 합의 정리");
    assert.equal(result?.id, "tfx-prune");
    assert.equal(result?.skill, "tfx-prune");
  });

  it("plain deep interview remains outside TFX hook ownership", () => {
    assert.equal(firstMatch("deep interview 해줘"), undefined);
  });

  it("qualified deep interview remains TFX-owned", () => {
    const result = firstMatch("tfx deep interview");
    assert.equal(result?.id, "tfx-deep-interview");
    assert.equal(result?.skill, "tfx-interview");
  });

  for (const prompt of [
    "계획 짜줘",
    "코드 리뷰해줘",
    "버그 원인 분석해줘",
    "코드에서 이 함수 찾아봐",
    "공식문서 검색해줘",
    "계속 진행해줘",
    "전체를 검토하고 계획해줘",
  ]) {
    it(`${prompt} retains the pre-existing broad winner`, () => {
      const result = firstMatch(prompt);
      assert.equal(result?.id, "tfx-unified");
      assert.equal(result?.skill, "tfx-auto");
    });
  }
});
