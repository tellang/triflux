import assert from "node:assert/strict";
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
