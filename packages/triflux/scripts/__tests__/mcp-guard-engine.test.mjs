import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectRegistryStatus,
  isWatchedPath,
  loadRegistry,
  removeServerFromTargets,
  scanForStdioServers,
  syncRegistryTargets,
} from "../lib/mcp-guard-engine.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const originalHome = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  EXA_API_KEY: process.env.EXA_API_KEY,
};

function createHomeDir(prefix = "mcp-guard-") {
  const base = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(base, { recursive: true });
  mkdirSync(join(base, ".gemini"), { recursive: true });
  mkdirSync(join(base, ".codex"), { recursive: true });
  return base;
}

function withHome(homeDir) {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

afterEach(() => {
  if (originalHome.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome.HOME;

  if (originalHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalHome.USERPROFILE;

  if (originalHome.EXA_API_KEY === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalHome.EXA_API_KEY;
});

describe("mcp guard engine", () => {
  it("loads the MCP registry", () => {
    const registry = loadRegistry();
    assert.equal(registry.version, 1);
    assert.equal(registry.servers.context7.url, "https://mcp.context7.com/mcp");
    assert.equal(registry.policies.watched_paths.length, 8);
  });

  it("drops legacy hub-url servers from a user registry and reads its default transport as http", () => {
    const registryPath = join(createHomeDir(), "mcp-registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
        servers: {
          "tfx-hub": {
            policy: "hosted",
            transport: "hub-url",
            url: "http://127.0.0.1:27888/mcp",
          },
          context7: {
            policy: "hosted",
            transport: "http",
            url: "https://mcp.context7.com/mcp",
          },
        },
        policies: { watched_paths: [] },
      }),
    );
    const previous = process.env.TFX_MCP_REGISTRY_PATH;
    process.env.TFX_MCP_REGISTRY_PATH = registryPath;
    try {
      const registry = loadRegistry();
      assert.deepEqual(Object.keys(registry.servers), ["context7"]);
      assert.equal(registry.defaults.transport, "http");
      assert.equal("hub_base" in registry.defaults, false);
    } finally {
      if (previous === undefined) delete process.env.TFX_MCP_REGISTRY_PATH;
      else process.env.TFX_MCP_REGISTRY_PATH = previous;
    }
  });

  it("matches watched paths for Gemini, Antigravity, Claude project MCP, and local .mcp.json", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);

    assert.equal(
      isWatchedPath(join(homeDir, ".gemini", "settings.json")),
      true,
    );
    assert.equal(
      isWatchedPath(join(homeDir, ".gemini", "config", "mcp_config.json")),
      true,
    );
    assert.equal(
      isWatchedPath(join(PROJECT_ROOT, "nested", ".mcp.json")),
      true,
    );
    assert.equal(
      isWatchedPath(join(PROJECT_ROOT, "nested", ".claude", "mcp.json")),
      true,
    );
    assert.equal(
      isWatchedPath(join(PROJECT_ROOT, "nested", "settings.yaml")),
      false,
    );
  });

  it("detects stdio MCP servers from JSON config", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);

    const settingsPath = join(homeDir, ".gemini", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          mcpServers: {
            "unsafe-stdio": { command: "node", args: ["server.js"] },
            "safe-url": { url: "https://mcp.example.com/mcp" },
          },
        },
        null,
        2,
      ),
    );

    const found = scanForStdioServers(settingsPath);
    assert.deepEqual(
      found.map((server) => server.name),
      ["unsafe-stdio"],
    );
  });

  it("treats .claude/mcp.json as a Claude project MCP config", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);

    const projectMcpPath = join(homeDir, "repo", ".claude", "mcp.json");
    mkdirSync(dirname(projectMcpPath), { recursive: true });
    writeFileSync(
      projectMcpPath,
      JSON.stringify(
        {
          mcpServers: {
            "unsafe-stdio": { command: "node", args: ["server.js"] },
          },
        },
        null,
        2,
      ),
    );

    const found = scanForStdioServers(projectMcpPath);
    assert.deepEqual(
      found.map((server) => server.name),
      ["unsafe-stdio"],
    );
  });

  it("treats migrated empty Antigravity mcp_config.json as skipped instead of invalid", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);

    const antigravityPath = join(
      homeDir,
      ".gemini",
      "config",
      "mcp_config.json",
    );
    mkdirSync(dirname(antigravityPath), { recursive: true });
    writeFileSync(join(homeDir, ".gemini", "config", ".migrated"), "", "utf8");
    writeFileSync(antigravityPath, "", "utf8");

    const registry = {
      version: 1,
      defaults: { transport: "http" },
      servers: {
        sample: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          safe: true,
          targets: ["antigravity"],
        },
      },
      policies: {
        unknown_server_action: "warn",
        sync_denylist: [],
        watched_paths: ["~/.gemini/config/mcp_config.json"],
      },
    };

    const status = inspectRegistryStatus(registry);
    assert.equal(status.configs[0].parseError, null);
    assert.equal(status.configs[0].migrated, true);
    assert.equal(status.rows[0].status, "skipped");
    assert.match(status.rows[0].message, /migrated/i);
  });

  it("preserves migrated empty Antigravity mcp_config.json during registry sync", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);

    const antigravityPath = join(
      homeDir,
      ".gemini",
      "config",
      "mcp_config.json",
    );
    mkdirSync(dirname(antigravityPath), { recursive: true });
    writeFileSync(join(homeDir, ".gemini", "config", ".migrated"), "", "utf8");
    writeFileSync(antigravityPath, "", "utf8");

    const registry = {
      version: 1,
      defaults: { transport: "http" },
      servers: {
        sample: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          safe: true,
          targets: ["antigravity"],
        },
      },
      policies: {
        unknown_server_action: "warn",
        sync_denylist: [],
        watched_paths: ["~/.gemini/config/mcp_config.json"],
      },
    };

    const result = syncRegistryTargets({ registry });

    assert.deepEqual(
      result.actions.map((action) => ({
        label: action.label,
        status: action.status,
        migrated: action.migrated,
      })),
      [{ label: "Antigravity", status: "skipped", migrated: true }],
    );
    assert.equal(readFileSync(antigravityPath, "utf8"), "");
  });

  it("skips migrated empty Antigravity mcp_config.json during registry remove", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);

    const antigravityPath = join(
      homeDir,
      ".gemini",
      "config",
      "mcp_config.json",
    );
    mkdirSync(dirname(antigravityPath), { recursive: true });
    writeFileSync(join(homeDir, ".gemini", "config", ".migrated"), "", "utf8");
    writeFileSync(antigravityPath, "", "utf8");

    const registry = {
      version: 1,
      defaults: { transport: "http" },
      servers: {
        sample: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          safe: true,
          targets: ["antigravity"],
        },
      },
      policies: {
        unknown_server_action: "warn",
        sync_denylist: [],
        watched_paths: ["~/.gemini/config/mcp_config.json"],
      },
    };

    const result = removeServerFromTargets("sample", {
      registry,
      targets: ["antigravity"],
    });

    assert.deepEqual(
      result.actions.map((action) => ({
        label: action.label,
        status: action.status,
        migrated: action.migrated,
      })),
      [{ label: "Antigravity", status: "skipped", migrated: true }],
    );
    assert.equal(readFileSync(antigravityPath, "utf8"), "");
  });

  it("syncs antigravity MCP config with Gemini-style JSON and http type", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);
    process.env.EXA_API_KEY = "test-exa-key";

    const antigravityPath = join(
      homeDir,
      ".gemini",
      "config",
      "mcp_config.json",
    );
    const registry = {
      version: 1,
      defaults: { transport: "http" },
      servers: {
        sample: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          safe: true,
          targets: ["gemini", "antigravity"],
        },
        context7: {
          transport: "http",
          url: "https://mcp.context7.com/mcp",
          safe: true,
          targets: ["gemini"],
        },
        exa: {
          transport: "http",
          url: "https://mcp.exa.ai/mcp",
          headers: {
            Authorization: { env: "EXA_API_KEY", prefix: "Bearer " },
          },
          safe: true,
          targets: ["antigravity"],
        },
      },
      policies: {
        unknown_server_action: "warn",
        sync_denylist: [],
        watched_paths: ["~/.gemini/config/mcp_config.json"],
      },
    };

    const result = syncRegistryTargets({ registry });
    const updated = JSON.parse(readFileSync(antigravityPath, "utf8"));

    assert.deepEqual(
      result.actions.map((action) => ({
        label: action.label,
        status: action.status,
        serverCount: action.serverCount,
      })),
      [{ label: "Antigravity", status: "updated", serverCount: 2 }],
    );
    assert.deepEqual(updated, {
      mcpServers: {
        sample: {
          url: "https://mcp.example.com/mcp",
          type: "http",
        },
        exa: {
          url: "https://mcp.exa.ai/mcp",
          type: "http",
          headers: {
            Authorization: "Bearer test-exa-key",
          },
        },
      },
    });
  });
});
