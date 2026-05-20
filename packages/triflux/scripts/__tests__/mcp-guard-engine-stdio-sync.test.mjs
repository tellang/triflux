import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { syncRegistryTargets } from "../lib/mcp-guard-engine.mjs";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TFX_CODEX_CONFIG_SYNC: process.env.TFX_CODEX_CONFIG_SYNC,
  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
  TFX_MISSING_BRAVE_API_KEY: process.env.TFX_MISSING_BRAVE_API_KEY,
};

function createHomeDir(prefix = "mcp-guard-stdio-sync-") {
  const base = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(base, ".codex"), { recursive: true });
  mkdirSync(join(base, ".gemini", "config"), { recursive: true });
  mkdirSync(join(base, "repo", ".claude"), { recursive: true });
  return base;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function registryFor(homeDir, envDescriptor = { env: "BRAVE_API_KEY" }) {
  return {
    version: 1,
    defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
    servers: {
      "brave-search": {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
        env: {
          BRAVE_API_KEY: envDescriptor,
        },
        safe: true,
        targets: ["claude", "gemini", "codex", "antigravity"],
      },
    },
    policies: {
      stdio_action: "replace-with-hub",
      watched_paths: [
        join(homeDir, "repo", ".mcp.json"),
        join(homeDir, "repo", ".claude", "mcp.json"),
        join(homeDir, ".gemini", "settings.json"),
        join(homeDir, ".gemini", "config", "mcp_config.json"),
        join(homeDir, ".codex", "config.toml"),
      ],
    },
  };
}

afterEach(restoreEnv);

describe("syncRegistryTargets stdio servers", () => {
  it("writes stdio command, args, and resolved env to all primary clients", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    process.env.BRAVE_API_KEY = "test-brave-key";

    for (const jsonPath of [
      join(homeDir, "repo", ".mcp.json"),
      join(homeDir, "repo", ".claude", "mcp.json"),
      join(homeDir, ".gemini", "settings.json"),
      join(homeDir, ".gemini", "config", "mcp_config.json"),
    ]) {
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            mcpServers: {
              "brave-search": {
                type: "http",
                url: "https://mcp.brave.com/mcp",
                headers: { Authorization: "Bearer stale" },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    const result = syncRegistryTargets({ registry: registryFor(homeDir) });

    assert.equal(
      result.actions.every((action) => action.status === "updated"),
      true,
    );

    for (const jsonPath of [
      join(homeDir, "repo", ".mcp.json"),
      join(homeDir, "repo", ".claude", "mcp.json"),
      join(homeDir, ".gemini", "settings.json"),
      join(homeDir, ".gemini", "config", "mcp_config.json"),
    ]) {
      const config = JSON.parse(readFileSync(jsonPath, "utf8"));
      assert.deepEqual(config.mcpServers["brave-search"], {
        command: "npx",
        args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
        env: {
          BRAVE_API_KEY: "test-brave-key",
        },
      });
    }

    const codexToml = readFileSync(
      join(homeDir, ".codex", "config.toml"),
      "utf8",
    );
    assert.match(codexToml, /\[mcp_servers\.brave-search\]/);
    assert.match(codexToml, /command = "npx"/);
    assert.match(
      codexToml,
      /args = \["-y", "@brave\/brave-search-mcp-server", "--transport", "stdio"\]/,
    );
    assert.match(codexToml, /env = \{ "BRAVE_API_KEY" = "test-brave-key" \}/);
    assert.doesNotMatch(codexToml, /url = /);
  });

  it("warns on missing stdio env vars without writing empty env values", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    delete process.env.TFX_MISSING_BRAVE_API_KEY;

    const result = syncRegistryTargets({
      registry: registryFor(homeDir, { env: "TFX_MISSING_BRAVE_API_KEY" }),
    });

    assert.ok(
      result.actions.some((action) =>
        (action.warnings || []).some((warning) =>
          warning.includes("TFX_MISSING_BRAVE_API_KEY"),
        ),
      ),
    );

    const projectConfig = JSON.parse(
      readFileSync(join(homeDir, "repo", ".mcp.json"), "utf8"),
    );
    assert.deepEqual(projectConfig.mcpServers["brave-search"], {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
    });

    const codexToml = readFileSync(
      join(homeDir, ".codex", "config.toml"),
      "utf8",
    );
    assert.doesNotMatch(codexToml, /TFX_MISSING_BRAVE_API_KEY/);
    assert.doesNotMatch(codexToml, /env = /);
    assert.doesNotMatch(codexToml, /""/);
  });
});
