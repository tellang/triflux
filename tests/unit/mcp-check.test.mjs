import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildInventory,
  createServerRecord,
  getClaudeMcp,
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

test("getClaudeMcp discovers project .claude/mcp.json", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-mcp-check-"));
  try {
    const projectMcpPath = join(root, ".claude", "mcp.json");
    const cwd = join(root, "nested", "workspace");
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      projectMcpPath,
      JSON.stringify({
        mcpServers: {
          "project-hub": { type: "http", url: "http://127.0.0.1:27888/mcp" },
        },
      }),
      "utf8",
    );

    const servers = getClaudeMcp(cwd);
    assert.ok(servers.some((server) => server.name === "project-hub"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
