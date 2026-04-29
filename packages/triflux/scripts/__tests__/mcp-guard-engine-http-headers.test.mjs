import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildDesiredServerRecord,
  validateRegistry,
} from "../lib/mcp-guard-engine.mjs";

const originalEnv = {
  TFX_TEST_TOKEN: process.env.TFX_TEST_TOKEN,
  TFX_OTHER_TOKEN: process.env.TFX_OTHER_TOKEN,
};

function registryWith(server) {
  return {
    version: 1,
    defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
    servers: { auth: server },
    policies: { watched_paths: [] },
  };
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("mcp guard HTTP transport + headers schema", () => {
  it("validates http transport with no headers, literal headers, env headers, and prefixed env headers", () => {
    const cases = [
      {
        transport: "http",
        url: "https://example.com/mcp",
      },
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-Client": { value: "triflux" } },
      },
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-API-Key": { env: "TFX_TEST_TOKEN" } },
      },
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
        },
      },
    ];

    for (const server of cases) {
      assert.deepEqual(validateRegistry(registryWith(server)), []);
    }
  });

  it("rejects malformed header descriptors and stdio-shaped registry servers", () => {
    const invalidServers = [
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "Bad Header": { value: "x" } },
      },
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-Client": "triflux" },
      },
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-API-Key": { env: "" } },
      },
      {
        transport: "stdio",
        url: "https://example.com/mcp",
        headers: { "X-Client": { value: "triflux" } },
      },
      {
        transport: "http",
        url: "https://example.com/mcp",
        command: "node",
      },
      {
        transport: "http",
        url: "https://example.com/mcp",
        args: ["server.js"],
      },
    ];

    for (const server of invalidServers) {
      assert.notDeepEqual(validateRegistry(registryWith(server)), []);
    }
  });

  it("builds header-aware desired records for Codex TOML targets", () => {
    process.env.TFX_TEST_TOKEN = "secret-token";

    const desired = buildDesiredServerRecord(
      "auth",
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
          "X-Client": { value: "triflux" },
        },
      },
      join("home", ".codex", "config.toml"),
    );

    assert.deepEqual(desired.config, {
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Client": "triflux",
      },
    });
    assert.deepEqual(desired.codex, {
      bearer_token_env_var: "TFX_TEST_TOKEN",
      env_http_headers: {},
      http_headers: { "X-Client": "triflux" },
    });
    assert.deepEqual(desired.warnings, []);
  });

  it("builds header-aware desired records for JSON MCP targets", () => {
    process.env.TFX_TEST_TOKEN = "secret-token";
    process.env.TFX_OTHER_TOKEN = "other-token";

    const desired = buildDesiredServerRecord(
      "auth",
      {
        transport: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
          "X-API-Key": { env: "TFX_OTHER_TOKEN" },
          "X-Client": { value: "triflux" },
        },
      },
      join("repo", ".mcp.json"),
    );

    assert.deepEqual(desired.config, {
      type: "http",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer secret-token",
        "X-API-Key": "other-token",
        "X-Client": "triflux",
      },
    });
    assert.deepEqual(desired.warnings, []);
  });

  it("keeps hub-url records URL-only when no headers are configured", () => {
    const desired = buildDesiredServerRecord(
      "tfx-hub",
      {
        transport: "hub-url",
        url: "http://127.0.0.1:27888/mcp",
      },
      join("repo", ".mcp.json"),
    );

    assert.deepEqual(desired.config, {
      type: "http",
      url: "http://127.0.0.1:27888/mcp",
    });
  });
});
