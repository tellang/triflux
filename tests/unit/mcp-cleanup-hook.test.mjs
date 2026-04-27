import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const PROJECT_ROOT = process.cwd();

describe("mcp-cleanup Stop hook safety", () => {
  it("does not run MCP process cleanup by default", () => {
    const script = readFileSync(
      join(PROJECT_ROOT, "scripts", "mcp-cleanup.ps1"),
      "utf8",
    );

    assert.match(script, /TFX_ENABLE_STOP_MCP_CLEANUP/);
    assert.match(script, /exit 0/);
  });

  it("keeps ext-mcp-cleanup disabled in the hook registry", () => {
    const registry = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "hooks", "hook-registry.json"), "utf8"),
    );
    const stopHooks = registry.events?.Stop ?? [];
    const cleanup = stopHooks.find((hook) => hook.id === "ext-mcp-cleanup");

    assert.ok(cleanup, "ext-mcp-cleanup entry should stay explicit");
    assert.equal(cleanup.enabled, false);
  });
});
