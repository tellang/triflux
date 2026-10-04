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
    // ADR-0021: tfx-ship 은 맨 명사 "배포"가 아니라 배포·릴리즈 동사형만 받는다.
    ["릴리즈 해줘", "tfx-ship", "tfx-ship"],
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

  // ADR-0021: 사용 0회인 tfx-prune 토큰 규칙은 지웠다. 3자 cleanup 은
  // tfx-auto --mode consensus 명시 호출로 받는다.
  it("removed tfx-prune token no longer owns cleanup; tfx-auto token does", () => {
    assert.equal(firstMatch("tfx-prune으로 3자 합의 정리"), undefined);
    const result = firstMatch("/tfx-auto --mode consensus 로 3자 합의 정리");
    assert.equal(result?.id, "tfx-unified");
    assert.equal(result?.skill, "tfx-auto");
    assert.equal(result?.strength, "explicit");
  });

  it("plain deep interview remains outside TFX hook ownership", () => {
    assert.equal(firstMatch("deep interview 해줘"), undefined);
  });

  it("qualified deep interview remains TFX-owned", () => {
    const result = firstMatch("tfx deep interview");
    assert.equal(result?.id, "tfx-deep-interview");
    assert.equal(result?.skill, "tfx-interview");
  });

  // ADR-0021 이 잠금을 대체한다: 광역 동사 단독(리뷰·분석·계획·검색·진행)은
  // 60일 코퍼스에서 주입 63건 중 55건이 오탐이었다. 이제 hook 은 이것들을 잡지
  // 않고, 세분화는 D-트리(모델 계층)가 맡는다.
  for (const prompt of [
    "계획 짜줘",
    "코드 리뷰해줘",
    "코드에서 이 함수 찾아봐",
    "공식문서 검색해줘",
    "계속 진행해줘",
    "전체를 검토하고 계획해줘",
  ]) {
    it(`${prompt} is no longer captured by the hook`, () => {
      assert.equal(firstMatch(prompt), undefined);
    });
  }

  it("버그 원인 분석해줘 is an investigate suggestion (tfx-unified no longer outranks it)", () => {
    const result = firstMatch("버그 원인 분석해줘");
    assert.equal(result?.id, "gstack-investigate");
    assert.equal(result?.strength, "suggest");
  });

  for (const prompt of ["로그인 기능 구현해줘", "이 함수 버그 고쳐줘"]) {
    it(`${prompt} is a tfx-auto suggestion, not a forced invocation`, () => {
      const result = firstMatch(prompt);
      assert.equal(result?.id, "tfx-unified");
      assert.equal(result?.skill, "tfx-auto");
      assert.equal(result?.strength, "suggest");
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
