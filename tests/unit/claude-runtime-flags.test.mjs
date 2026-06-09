import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectClaudeRuntimeFlags,
  readBooleanRuntimeFlag,
} from "../../hub/diagnostics/claude-runtime-flags.mjs";

test("readBooleanRuntimeFlag accepts common truthy values", () => {
  assert.equal(readBooleanRuntimeFlag("1"), true);
  assert.equal(readBooleanRuntimeFlag("true"), true);
  assert.equal(readBooleanRuntimeFlag("TRUE"), true);
  assert.equal(readBooleanRuntimeFlag("yes"), true);
  assert.equal(readBooleanRuntimeFlag("0"), false);
  assert.equal(readBooleanRuntimeFlag("false"), false);
  assert.equal(readBooleanRuntimeFlag(undefined), false);
});

test("inspectClaudeRuntimeFlags warns for safe mode and disabled bundled skills", () => {
  const result = inspectClaudeRuntimeFlags({
    env: {
      CLAUDE_CODE_SAFE_MODE: "1",
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "true",
    },
    settings: {},
  });

  assert.equal(result.status, "warning");
  assert.equal(result.safeMode, true);
  assert.equal(result.disableBundledSkills, true);
  assert.match(result.summary, /safe mode/i);
  assert.match(result.summary, /bundled skills/i);
});

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
