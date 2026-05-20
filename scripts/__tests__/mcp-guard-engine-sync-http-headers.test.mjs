import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { syncRegistryTargets } from "../lib/mcp-guard-engine.mjs";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TFX_CODEX_CONFIG_SYNC: process.env.TFX_CODEX_CONFIG_SYNC,
  TFX_TEST_TOKEN: process.env.TFX_TEST_TOKEN,
  TFX_MISSING_TOKEN: process.env.TFX_MISSING_TOKEN,
};

function createHomeDir(prefix = "mcp-guard-sync-") {
  const base = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(base, ".codex"), { recursive: true });
  return base;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function registryFor(homeDir, extraServer) {
  return {
    version: 1,
    defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
    servers: {
      auth: { safe: true, ...extraServer },
    },
    policies: {
      stdio_action: "replace-with-hub",
      watched_paths: [
        join(homeDir, ".codex", "config.toml"),
        join(homeDir, "repo", ".mcp.json"),
      ],
    },
  };
}

afterEach(restoreEnv);

describe("syncRegistryTargets HTTP headers", () => {
  it("writes authenticated HTTP records to Codex TOML and .mcp.json configs", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    process.env.TFX_TEST_TOKEN = "sync-secret";

    const projectMcpPath = join(homeDir, "repo", ".mcp.json");
    mkdirSync(dirname(projectMcpPath), { recursive: true });

    const result = syncRegistryTargets({
      registry: registryFor(homeDir, {
        transport: "http",
        url: "https://example.com/mcp",
        targets: ["codex", "claude"],
        headers: {
          Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
          "X-Client": { value: "triflux" },
        },
      }),
    });

    assert.equal(
      result.actions.every((action) => action.status === "updated"),
      true,
    );

    const codexToml = readFileSync(
      join(homeDir, ".codex", "config.toml"),
      "utf8",
    );
    assert.match(codexToml, /\[mcp_servers\.auth\]/);
    assert.match(codexToml, /url = "https:\/\/example\.com\/mcp"/);
    assert.match(codexToml, /bearer_token_env_var = "TFX_TEST_TOKEN"/);
    assert.match(codexToml, /http_headers = \{ "X-Client" = "triflux" \}/);
    assert.doesNotMatch(codexToml, /sync-secret/);

    const projectConfig = JSON.parse(readFileSync(projectMcpPath, "utf8"));
    assert.deepEqual(projectConfig.mcpServers.auth, {
      type: "http",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer sync-secret",
        "X-Client": "triflux",
      },
    });
  });

  it("preserves unrelated MCP entries and unrelated fields on the managed server", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    process.env.TFX_TEST_TOKEN = "sync-secret";

    const codexPath = join(homeDir, ".codex", "config.toml");
    writeFileSync(
      codexPath,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.auth]",
        'command = "node"',
        'args = ["old.js"]',
        "enabled = false",
        "",
        "[mcp_servers.auth.tools.read]",
        'approval_mode = "auto"',
        "",
        "[mcp_servers.other]",
        'url = "https://other.example/mcp"',
        "",
      ].join("\n"),
      "utf8",
    );

    const projectMcpPath = join(homeDir, "repo", ".mcp.json");
    mkdirSync(dirname(projectMcpPath), { recursive: true });
    writeFileSync(
      projectMcpPath,
      JSON.stringify(
        {
          mcpServers: {
            auth: {
              type: "http",
              url: "https://old.example/mcp",
              disabled: true,
            },
            other: { url: "https://other.example/mcp" },
          },
          workspace: "keep",
        },
        null,
        2,
      ),
      "utf8",
    );

    syncRegistryTargets({
      registry: registryFor(homeDir, {
        transport: "http",
        url: "https://example.com/mcp",
        targets: ["codex", "claude"],
        headers: {
          Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
        },
      }),
    });

    const codexToml = readFileSync(codexPath, "utf8");
    assert.match(codexToml, /^model = "gpt-5"/m);
    assert.match(codexToml, /^enabled = false$/m);
    assert.match(codexToml, /\[mcp_servers\.auth\.tools\.read\]/);
    assert.match(codexToml, /approval_mode = "auto"/);
    assert.match(codexToml, /\[mcp_servers\.other\]/);
    assert.doesNotMatch(codexToml, /command = "node"/);
    assert.doesNotMatch(codexToml, /args = \["old\.js"\]/);

    const projectConfig = JSON.parse(readFileSync(projectMcpPath, "utf8"));
    assert.equal(projectConfig.workspace, "keep");
    assert.deepEqual(projectConfig.mcpServers.other, {
      url: "https://other.example/mcp",
    });
    assert.equal(projectConfig.mcpServers.auth.disabled, true);
    assert.equal(projectConfig.mcpServers.auth.url, "https://example.com/mcp");
    assert.deepEqual(projectConfig.mcpServers.auth.headers, {
      Authorization: "Bearer sync-secret",
    });
  });

  it("warns on missing env vars without writing empty secret headers", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    delete process.env.TFX_MISSING_TOKEN;

    const projectMcpPath = join(homeDir, "repo", ".mcp.json");
    mkdirSync(dirname(projectMcpPath), { recursive: true });

    const result = syncRegistryTargets({
      registry: registryFor(homeDir, {
        transport: "http",
        url: "https://example.com/mcp",
        targets: ["codex", "claude"],
        headers: {
          Authorization: { env: "TFX_MISSING_TOKEN", prefix: "Bearer " },
          "X-Client": { value: "triflux" },
        },
      }),
    });

    assert.ok(
      result.actions.some((action) =>
        (action.warnings || []).some((warning) =>
          warning.includes("TFX_MISSING_TOKEN"),
        ),
      ),
    );

    const codexToml = readFileSync(
      join(homeDir, ".codex", "config.toml"),
      "utf8",
    );
    assert.doesNotMatch(codexToml, /Authorization/);
    assert.doesNotMatch(codexToml, /bearer_token_env_var/);
    assert.doesNotMatch(codexToml, /""/);

    const projectConfig = JSON.parse(readFileSync(projectMcpPath, "utf8"));
    assert.deepEqual(projectConfig.mcpServers.auth.headers, {
      "X-Client": "triflux",
    });
  });

  it("warns and locks permissions when Gemini sync writes env secrets as plaintext headers", () => {
    const homeDir = createHomeDir();
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_TEST_TOKEN = "sync-secret";

    const settingsPath = join(homeDir, ".gemini", "settings.json");
    const result = syncRegistryTargets({
      registry: {
        version: 1,
        defaults: { transport: "hub-url", hub_base: "http://127.0.0.1:27888" },
        servers: {
          auth: {
            safe: true,
            transport: "http",
            url: "https://example.com/mcp",
            targets: ["gemini"],
            headers: {
              Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
            },
          },
        },
        policies: {
          stdio_action: "replace-with-hub",
          watched_paths: [settingsPath],
        },
      },
    });

    const syncAction = result.actions.find(
      (action) => action.filePath === settingsPath,
    );
    assert.equal(syncAction.status, "updated");
    assert.deepEqual(syncAction.warnings, [
      "[tfx mcp sync] warn: gemini server 'auth' headers contain plaintext secret resolved from $TFX_TEST_TOKEN. Ensure ~/.gemini/settings.json permissions stay 600.",
    ]);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(
      settings.mcpServers.auth.headers.Authorization,
      "Bearer sync-secret",
    );
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  });
});
