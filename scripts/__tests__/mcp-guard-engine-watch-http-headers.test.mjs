import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  remediate,
  scanForStdioServers,
  validateRegistry,
} from "../lib/mcp-guard-engine.mjs";

const originalEnv = {
  TFX_TEST_TOKEN: process.env.TFX_TEST_TOKEN,
};

function tempPath(name) {
  return join(
    tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

afterEach(() => {
  if (originalEnv.TFX_TEST_TOKEN === undefined)
    delete process.env.TFX_TEST_TOKEN;
  else process.env.TFX_TEST_TOKEN = originalEnv.TFX_TEST_TOKEN;
});

describe("watched MCP remediation with HTTP headers", () => {
  it("replaces a stdio offender with an HTTP registry server that includes headers", () => {
    process.env.TFX_TEST_TOKEN = "watch-secret";
    const filePath = join(tempPath("mcp-watch"), ".mcp.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          mcpServers: {
            auth: { command: "node", args: ["server.js"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = {
      version: 1,
      defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
      servers: {
        auth: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: {
            Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
            "X-Client": { value: "triflux" },
          },
        },
      },
      policies: { watched_paths: [filePath], stdio_action: "replace-with-hub" },
    };

    const result = remediate(filePath, scanForStdioServers(filePath), {
      ...registry.policies,
      registry,
    });
    const updated = JSON.parse(readFileSync(filePath, "utf8"));

    assert.equal(result.modified, true);
    assert.deepEqual(updated.mcpServers.auth, {
      type: "http",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer watch-secret",
        "X-Client": "triflux",
      },
    });
  });

  it("redacts secret values from remediation output", () => {
    process.env.TFX_TEST_TOKEN = "watch-secret";
    const filePath = join(tempPath("mcp-watch-redact"), ".mcp.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify(
        { mcpServers: { auth: { command: "node", args: ["server.js"] } } },
        null,
        2,
      ),
      "utf8",
    );

    const registry = {
      version: 1,
      defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
      servers: {
        auth: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: {
            Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
          },
        },
      },
      policies: { watched_paths: [filePath], stdio_action: "replace-with-hub" },
    };

    const result = remediate(filePath, scanForStdioServers(filePath), {
      ...registry.policies,
      registry,
    });

    assert.doesNotMatch(JSON.stringify(result), /watch-secret/);
    assert.match(JSON.stringify(result), /\*\*\*REDACTED\*\*\*/);
  });

  it("keeps stdio-only registry entries unsupported", () => {
    const errors = validateRegistry({
      version: 1,
      defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
      servers: {
        stdio: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
      policies: { watched_paths: [] },
    });

    assert.ok(errors.some((error) => error.includes("transport")));
    assert.ok(errors.some((error) => error.includes("command")));
    assert.ok(errors.some((error) => error.includes("args")));
  });
});
