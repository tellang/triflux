import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  resolveAgentRoute,
  resolveCodexAgentPolicy,
  resolveCodexAgentProfile,
  resolveNestedCodexAgentProfile,
} from "../../scripts/lib/agent-route-policy.mjs";

describe("lane2-d routing contract: Codex agent policy SSOT", () => {
  it("unknown Codex role resolves to the canonical executor policy", () => {
    assert.deepEqual(
      resolveCodexAgentPolicy("unknown-lane"),
      resolveCodexAgentPolicy("executor"),
    );
    assert.deepEqual(
      resolveCodexAgentPolicy("explore"),
      resolveCodexAgentPolicy("executor"),
    );
  });

  for (const agent of ["test-engineer", "qa-tester"]) {
    it(`${agent} keeps the canonical 1200 second timeout`, () => {
      assert.equal(resolveCodexAgentPolicy(agent).timeoutSec, 1200);
    });
  }

  it("preserves direct-Codex designer and writer overrides in the policy", () => {
    assert.equal(
      resolveCodexAgentPolicy("designer").profile,
      "gpt6_astra_xhigh",
    );
    assert.equal(resolveCodexAgentPolicy("writer").profile, "gpt6_luna_high");
  });

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

  it("route normalizes legacy profiles, downgrades nested ultra, and rejects invalid routing", () => {
    const map = { explore: "claude", "deep-executor": "codex" };
    assert.deepEqual(
      resolveAgentRoute("explore", map, "gpt56_luna_low"),
      resolveAgentRoute("explore", map, "gpt6_luna_low"),
    );
    const topLevel = resolveAgentRoute("deep-executor", map, "ultra");
    const nested = resolveAgentRoute("deep-executor", map, "ultra", true);
    assert.notEqual(nested[6], topLevel[6]);
    assert.equal(
      nested[6],
      resolveCodexAgentProfile("deep-executor", {
        profileOverride: "ultra",
        nested: true,
      }),
    );
    assert.throws(
      () => resolveAgentRoute("gemini", { explore: "claude" }),
      /알 수 없는 에이전트 타입/,
    );
    assert.throws(
      () => resolveAgentRoute("bad;name", { "bad;name": "codex" }),
      /invalid agent/,
    );
    assert.throws(
      () => resolveAgentRoute("explore", { explore: "shell" }),
      /invalid provider/,
    );
    assert.throws(
      () => resolveAgentRoute("explore", { explore: "claude" }, "bad-profile"),
      /TFX_CODEX_PROFILE/,
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
      /\| 회고\/슬롭 정리 \| `\/gstack-retro` 또는 명시 `tfx-auto --mode consensus` \|/,
    );
    assert.match(
      routing,
      /\| 정리 \| 대상 domain을 먼저 판정; 무수식 AI slop\/deslop은 host ai-slop-cleaner \| D8 참조 \(명시 TFX 3자 cleanup만 `tfx-auto --mode consensus`\) \|/,
    );
  });
});
