import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  syncRegistryTargets,
  validateRegistry,
} from "../lib/mcp-guard-engine.mjs";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TFX_CODEX_CONFIG_SYNC: process.env.TFX_CODEX_CONFIG_SYNC,
  EXA_API_KEY: process.env.EXA_API_KEY,
  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function createHomeDir(prefix = "mcp-policy-sync-") {
  const base = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(base, ".claude"), { recursive: true });
  mkdirSync(join(base, ".codex"), { recursive: true });
  mkdirSync(join(base, ".gemini", "config"), { recursive: true });
  mkdirSync(join(base, "repo"), { recursive: true });
  return base;
}

function policyRegistry(homeDir) {
  return {
    version: 1,
    defaults: {
      transport: "hub-url",
      hub_base: "http://127.0.0.1:27888",
    },
    servers: {
      context7: {
        policy: "hosted",
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        safe: true,
        targets: ["claude", "gemini", "codex", "antigravity"],
      },
      exa: {
        policy: "hosted",
        transport: "http",
        url: "https://mcp.exa.ai/mcp",
        headers: {
          Authorization: { env: "EXA_API_KEY", prefix: "Bearer " },
        },
        safe: true,
        targets: ["claude", "gemini", "codex", "antigravity"],
      },
      serena: {
        policy: "gateway-sse",
        gateway_port: 8105,
        safe: true,
        targets: ["claude", "gemini", "codex", "antigravity"],
      },
      "brave-search": {
        policy: "stdio",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
        env: {
          BRAVE_API_KEY: { env: "BRAVE_API_KEY" },
        },
        safe: true,
        targets: ["claude", "gemini", "codex", "antigravity"],
      },
    },
    policies: {
      stdio_action: "replace-with-hub",
      sync_denylist: [],
      watched_paths: [
        join(homeDir, ".claude.json"),
        join(homeDir, "repo", ".mcp.json"),
        join(homeDir, ".gemini", "settings.json"),
        join(homeDir, ".codex", "config.toml"),
        join(homeDir, ".gemini", "config", "mcp_config.json"),
      ],
    },
  };
}

afterEach(restoreEnv);

describe("mcp guard policy sync", () => {
  it("validates explicit hosted, gateway-sse, and stdio server policies", () => {
    const homeDir = createHomeDir();
    assert.deepEqual(validateRegistry(policyRegistry(homeDir)), []);
  });

  it("syncs policy-specific MCP shapes for all primary clients and preserves ~/.claude.json keys", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    process.env.EXA_API_KEY = "test-exa-key";
    process.env.BRAVE_API_KEY = "test-brave-key";

    const claudeUserPath = join(homeDir, ".claude.json");
    writeFileSync(
      claudeUserPath,
      JSON.stringify(
        {
          additionalModelCostsCache: { keep: true },
          claudeCodeFirstTokenDate: "2026-01-01T00:00:00.000Z",
          mcpServers: {
            gbrain: { command: "node", args: ["gbrain.mjs"] },
            context7: { command: "npx", args: ["stale"] },
          },
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    const result = syncRegistryTargets({ registry: policyRegistry(homeDir) });
    assert.equal(
      result.actions.filter((action) => action.type === "sync").length,
      5,
    );

    const claudeUser = JSON.parse(readFileSync(claudeUserPath, "utf8"));
    assert.deepEqual(claudeUser.additionalModelCostsCache, { keep: true });
    assert.equal(
      claudeUser.claudeCodeFirstTokenDate,
      "2026-01-01T00:00:00.000Z",
    );
    assert.deepEqual(claudeUser.mcpServers.gbrain, {
      command: "node",
      args: ["gbrain.mjs"],
    });
    assert.deepEqual(claudeUser.mcpServers.context7, {
      type: "http",
      url: "https://mcp.context7.com/mcp",
    });
    assert.deepEqual(claudeUser.mcpServers.exa, {
      type: "http",
      url: "https://mcp.exa.ai/mcp",
      headers: { Authorization: "Bearer test-exa-key" },
    });
    assert.deepEqual(claudeUser.mcpServers.serena, {
      type: "sse",
      url: "http://127.0.0.1:8105/sse",
    });
    assert.deepEqual(claudeUser.mcpServers["brave-search"], {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      env: { BRAVE_API_KEY: "test-brave-key" },
    });
    assert.equal((statSync(claudeUserPath).mode & 0o777).toString(8), "600");

    for (const jsonPath of [
      join(homeDir, "repo", ".mcp.json"),
      join(homeDir, ".gemini", "settings.json"),
      join(homeDir, ".gemini", "config", "mcp_config.json"),
    ]) {
      const config = JSON.parse(readFileSync(jsonPath, "utf8"));
      assert.equal(
        config.mcpServers.context7.url,
        "https://mcp.context7.com/mcp",
      );
      assert.equal(
        config.mcpServers.exa.headers.Authorization,
        "Bearer test-exa-key",
      );
      assert.equal(config.mcpServers.serena.url, "http://127.0.0.1:8105/sse");
      assert.equal(config.mcpServers.serena.type, "sse");
      assert.equal(config.mcpServers["brave-search"].command, "npx");
      assert.deepEqual(config.mcpServers["brave-search"].env, {
        BRAVE_API_KEY: "test-brave-key",
      });
    }

    const codexToml = readFileSync(
      join(homeDir, ".codex", "config.toml"),
      "utf8",
    );
    assert.match(codexToml, /\[mcp_servers\.context7\]/);
    assert.match(codexToml, /url = "https:\/\/mcp\.context7\.com\/mcp"/);
    assert.match(codexToml, /\[mcp_servers\.exa\]/);
    assert.match(codexToml, /bearer_token_env_var = "EXA_API_KEY"/);
    assert.match(codexToml, /\[mcp_servers\.serena\]/);
    assert.match(codexToml, /url = "http:\/\/127\.0\.0\.1:8105\/sse"/);
    assert.match(codexToml, /transport = "sse"/);
    assert.match(codexToml, /\[mcp_servers\.brave-search\]/);
    assert.match(codexToml, /command = "npx"/);
    assert.match(codexToml, /env = \{ "BRAVE_API_KEY" = "test-brave-key" \}/);
  });
});
