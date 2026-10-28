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

  it("역할 정책과 route 출력은 가족과 effort를 분리한다", () => {
    assert.deepEqual(resolveCodexAgentPolicy("architect").codex, {
      family: "astra",
      effort: "xhigh",
    });
    const route = resolveAgentRoute("architect", { architect: "codex" });
    assert.equal(route[1], "astra_xhigh");
    assert.equal(route[8], 600);
    assert.equal(route.at(-2), "xhigh");
    assert.equal(route.at(-1), "astra");
  });

  it("headless roles ignore ordinary global profiles but retain max/ultra lanes", () => {
    assert.equal(
      resolveNestedCodexAgentProfile("architect", {
        globalProfile: "sol_high",
      }),
      "astra_xhigh",
    );
    assert.equal(
      resolveNestedCodexAgentProfile("executor", { globalProfile: "max" }),
      "astra_max",
    );
  });

  it("route normalizes legacy profiles, downgrades nested ultra, and rejects invalid routing", () => {
    const map = { explore: "claude", "deep-executor": "codex" };
    assert.deepEqual(
      resolveAgentRoute("explore", map, "gpt56_luna_low"),
      resolveAgentRoute("explore", map, "luna_low"),
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
