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
    defaults: { transport: "http" },
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
  it("writes stdio command, args, and env references to all primary clients", () => {
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
          BRAVE_API_KEY: "${BRAVE_API_KEY}",
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
    assert.match(codexToml, /env_vars = \["BRAVE_API_KEY"\]/);
    assert.doesNotMatch(codexToml, /url = /);
  });

  it("warns on missing stdio env vars without writing empty env values", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    delete process.env.BRAVE_API_KEY;

    const result = syncRegistryTargets({
      registry: registryFor(homeDir),
    });

    assert.ok(
      result.actions.some((action) =>
        (action.warnings || []).some((warning) =>
          warning.includes("BRAVE_API_KEY"),
        ),
      ),
    );

    const projectConfig = JSON.parse(
      readFileSync(join(homeDir, "repo", ".mcp.json"), "utf8"),
    );
    assert.deepEqual(projectConfig.mcpServers["brave-search"], {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
    });

    const codexToml = readFileSync(
      join(homeDir, ".codex", "config.toml"),
      "utf8",
    );
    assert.match(codexToml, /env_vars = \["BRAVE_API_KEY"\]/);
    assert.doesNotMatch(codexToml, /env = /);

    const remapped = syncRegistryTargets({
      registry: registryFor(homeDir, { env: "TFX_MISSING_BRAVE_API_KEY" }),
    });
    assert.equal(
      readFileSync(join(homeDir, ".codex", "config.toml"), "utf8"),
      codexToml,
    );
    assert.ok(
      remapped.actions.some(
        (action) =>
          action.filePath === join(homeDir, ".codex", "config.toml") &&
          action.status === "warning" &&
          action.message?.includes("TFX_MISSING_BRAVE_API_KEY"),
      ),
    );
  });

  it("keeps user-changed stdio entries and only pins version differences", () => {
    const homeDir = createHomeDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const registry = registryFor(homeDir);
    const brave = registry.servers["brave-search"];
    brave.args = ["-y", "@brave/brave-search-mcp-server@2.1.4"];
    const write = (file, args) =>
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: { "brave-search": { command: "npx", args } },
        }),
      );
    const unpinned = join(homeDir, "repo", ".mcp.json");
    const custom = join(homeDir, "repo", ".claude", "mcp.json");
    const userArgs = ["-y", "@brave/brave-search-mcp-server", "--x"];
    write(unpinned, ["-y", "@brave/brave-search-mcp-server"]);
    write(custom, userArgs);

    const { actions } = syncRegistryTargets({ registry });
    const args = (file) =>
      JSON.parse(readFileSync(file, "utf8")).mcpServers["brave-search"].args;
    assert.deepEqual(args(unpinned), brave.args);
    assert.deepEqual(args(custom), userArgs);
    assert.ok(
      actions.some(
        (action) => action.filePath === custom && action.status === "warning",
      ),
    );
    // 작은따옴표와 줄 끝 주석이 있는 Codex 항목도 버전 차이로 보고 고정한다.
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
    const codex = join(homeDir, ".codex", "config.toml");
    writeFileSync(
      codex,
      "[mcp_servers.brave-search]\ncommand = 'npx'\nargs = ['-y', '@brave/brave-search-mcp-server@2.0.0'] # pin\n",
    );
    syncRegistryTargets({ registry });
    assert.match(readFileSync(codex, "utf8"), /mcp-server@2\.1\.4/);

    // 여러 줄 배열은 닫는 ] 까지 바꿔 파일이 깨지지 않는다(TOML 1.0 여러 줄 문자열이 같이 있어도).
    writeFileSync(
      codex,
      'note = """Say "hi""""\n\n[mcp_servers.brave-search]\ncommand = "npx"\nargs = ["-y", "@brave/brave-search-mcp-server"]\nenv_vars = [\n  "BRAVE_API_KEY",\n]\n',
    );
    syncRegistryTargets({ registry });
    const rewritten = readFileSync(codex, "utf8");
    assert.match(rewritten, /mcp-server@2\.1\.4/);
    assert.doesNotMatch(rewritten, /^\s*"BRAVE_API_KEY",$|^\s*\]$/m);
  });
});
