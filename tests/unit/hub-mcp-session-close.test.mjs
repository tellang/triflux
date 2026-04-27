import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();

describe("hub MCP session close lifecycle", () => {
  const src = readFileSync(join(ROOT, "hub", "server.mjs"), "utf8");

  it("transport.onclose delegates to the guarded session closer", () => {
    const start = src.indexOf("transport.onclose = () => {");
    assert.notEqual(start, -1, "transport.onclose handler must exist");

    const end = src.indexOf("const mcp = createMcpForSession();", start);
    assert.notEqual(end, -1, "transport.onclose block boundary must exist");

    const block = src.slice(start, end);
    assert.match(block, /closeMcpTransportSession\(/);
    assert.doesNotMatch(
      block,
      /session\.mcp\.close\(/,
      "onclose must not directly call mcp.close(), which recurses through transport.close()",
    );
  });

  it("guarded closer marks the session closing before closing MCP transport", () => {
    const start = src.indexOf("async function closeMcpTransportSession");
    assert.notEqual(start, -1, "guarded closer must exist");

    const end = src.indexOf("function createMcpForSession()", start);
    assert.notEqual(end, -1, "guarded closer boundary must exist");

    const block = src.slice(start, end);
    const closingIndex = block.indexOf("session.closing = true;");
    const deleteIndex = block.indexOf("transports.delete(sid);", closingIndex);
    const mcpCloseIndex = block.indexOf("await session.mcp.close();");
    const transportCloseIndex = block.indexOf(
      "await session.transport.close();",
    );

    assert.ok(closingIndex > 0, "session must be marked closing");
    assert.ok(
      deleteIndex > closingIndex,
      "session must be removed before close callbacks run",
    );
    assert.ok(
      mcpCloseIndex > deleteIndex,
      "mcp.close must run after the guard is active",
    );
    assert.ok(
      transportCloseIndex > mcpCloseIndex,
      "transport.close fallback must run after mcp.close",
    );
  });
});
