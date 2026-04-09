import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInventory,
  createServerRecord,
} from "../../scripts/mcp-check.mjs";

test("createServerRecord fills tool_count and domain_tags from config and catalog", () => {
  const record = createServerRecord("context7", "configured", {
    includeTools: ["resolve-library-id"],
    args: ["--docs"],
  });

  assert.equal(record.tool_count, 1);
  assert.ok(record.domain_tags.includes("docs"));
  assert.ok(record.domain_tags.includes("reference"));
});

test("buildInventory returns stable MCP cache shape", () => {
  const inventory = buildInventory();

  assert.ok(typeof inventory.timestamp === "string");
  assert.ok(inventory.codex && typeof inventory.codex.available === "boolean");
  assert.ok(Array.isArray(inventory.codex.servers));
  assert.ok(
    inventory.gemini && typeof inventory.gemini.available === "boolean",
  );
  assert.ok(Array.isArray(inventory.gemini.servers));
});
