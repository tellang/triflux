import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CODEX_AGENT_POLICY,
  DEFAULT_CODEX_AGENT,
  resolveCodexAgentPolicy,
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
    assert.equal(CODEX_AGENT_POLICY.designer.profile, "gpt56_sol_xhigh");
    assert.equal(CODEX_AGENT_POLICY.writer.profile, "gpt56_luna_low");
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
