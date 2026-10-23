import assert from "node:assert/strict";
import test from "node:test";

import { inspectClaudeRuntimeFlags } from "../../hub/diagnostics/claude-runtime-flags.mjs";

test("inspectClaudeRuntimeFlags reports managed MCP policy counts", () => {
  const result = inspectClaudeRuntimeFlags({
    env: {},
    settings: {
      allowedMcpServers: ["context7", "brave-search"],
      deniedMcpServers: ["*"],
      disableBundledSkills: true,
    },
  });

  assert.equal(result.status, "warning");
  assert.equal(result.disableBundledSkills, true);
  assert.deepEqual(result.managedMcpPolicy, {
    active: true,
    allowedCount: 2,
    deniedCount: 1,
  });
});

test("inspectClaudeRuntimeFlags is ok when no drift-prone flags are present", () => {
  const result = inspectClaudeRuntimeFlags({ env: {}, settings: {} });
  assert.equal(result.status, "ok");
  assert.equal(result.safeMode, false);
  assert.equal(result.disableBundledSkills, false);
  assert.deepEqual(result.managedMcpPolicy, {
    active: false,
    allowedCount: 0,
    deniedCount: 0,
  });
});
