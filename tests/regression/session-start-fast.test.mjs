import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("SessionStart MCP guard ordering", () => {
  it("invokes registry sync from the safety guard before hub-ensure runs", () => {
    const sessionStartSource = readFileSync(
      join(PROJECT_ROOT, "hooks", "session-start-fast.mjs"),
      "utf8",
    );
    const guardSource = readFileSync(
      join(PROJECT_ROOT, "scripts", "mcp-safety-guard.mjs"),
      "utf8",
    );

    const guardRunIndex = sessionStartSource.indexOf("guard.run()");
    const hubEnsureIndex = sessionStartSource.indexOf(
      'join(SCRIPTS, "hub-ensure.mjs")',
    );
    const syncCallIndex = guardSource.indexOf(
      "syncRegistryTargets({ registry })",
    );
    const remediationIndex = guardSource.indexOf("remediate(");

    assert.ok(guardRunIndex >= 0, "SessionStart guard.run() call missing");
    assert.ok(hubEnsureIndex >= 0, "hub-ensure import path missing");
    assert.ok(
      guardRunIndex < hubEnsureIndex,
      "mcp-safety-guard must run before hub-ensure",
    );
    assert.ok(syncCallIndex >= 0, "registry sync call missing from guard");
    assert.ok(
      remediationIndex >= 0 && remediationIndex < syncCallIndex,
      "guard must remediate stdio before proactive registry sync",
    );
  });
});
