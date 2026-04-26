import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";

import { probeStdio } from "../../scripts/lib/mcp-health.mjs";

const tempDirs = [];

function makeEofBoundMcpServer() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-mcp-bootstrap-eof-"));
  tempDirs.push(dir);
  const serverPath = join(dir, "server.mjs");
  writeFileSync(
    serverPath,
    [
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    jsonrpc: '2.0',",
      "    id: 1,",
      "    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'eof-bound', version: '1.0.0' } },",
      "  }) + '\\n');",
      "  setInterval(() => {}, 60_000);",
      "});",
    ].join("\n"),
    "utf8",
  );
  return serverPath;
}

describe("MCP bootstrap stdin EOF regression", { timeout: 3000 }, () => {
  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes stdio probe stdin after initialize so EOF-gated servers cannot hang", async () => {
    const serverPath = makeEofBoundMcpServer();
    const result = await probeStdio(
      { command: process.execPath, args: [serverPath] },
      1000,
    );

    assert.equal(result.alive, true, JSON.stringify(result));
    assert.ok(
      result.ms < 1000,
      `probe should complete before timeout: ${result.ms}ms`,
    );
  });
});
