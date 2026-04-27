import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isWatchedPath,
  loadRegistry,
  remediate,
  resolveHubUrl,
  scanForStdioServers,
} from "../lib/mcp-guard-engine.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const originalHome = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TFX_HUB_PORT: process.env.TFX_HUB_PORT,
};

function createHomeDir(prefix = "mcp-guard-") {
  const base = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(base, { recursive: true });
  mkdirSync(join(base, ".gemini"), { recursive: true });
  mkdirSync(join(base, ".claude", "cache", "tfx-hub"), { recursive: true });
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

  if (originalHome.TFX_HUB_PORT === undefined) delete process.env.TFX_HUB_PORT;
  else process.env.TFX_HUB_PORT = originalHome.TFX_HUB_PORT;
});

describe("mcp guard engine", () => {
  it("loads the MCP registry", () => {
    const registry = loadRegistry();
    assert.equal(registry.version, 1);
    assert.equal(registry.servers["tfx-hub"].url, "http://127.0.0.1:27888/mcp");
    assert.equal(registry.policies.watched_paths.length, 6);
  });

  it("matches watched paths for Gemini, Claude project MCP, and local .mcp.json", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);

    assert.equal(
      isWatchedPath(join(homeDir, ".gemini", "settings.json")),
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
            "safe-url": { url: "http://127.0.0.1:27888/mcp" },
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

    const result = remediate(projectMcpPath, found, {
      stdio_action: "replace-with-hub",
    });
    const updated = JSON.parse(readFileSync(projectMcpPath, "utf8"));

    assert.equal(result.modified, true);
    assert.equal(updated.mcpServers["tfx-hub"].type, "http");
    assert.equal(updated.mcpServers["tfx-hub"].url, resolveHubUrl());
    assert.equal(Object.hasOwn(updated.mcpServers, "unsafe-stdio"), false);
  });

  it("replaces stdio MCP entries with tfx-hub and writes a backup (TFX_HUB_PORT env overrides)", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);
    process.env.TFX_HUB_PORT = "30123";

    // hub.pid port 는 무시되어야 한다 (PR #158: pid = host hint only).
    const pidPath = join(homeDir, ".claude", "cache", "tfx-hub", "hub.pid");
    writeFileSync(
      pidPath,
      JSON.stringify({ host: "127.0.0.1", port: 40404 }),
      "utf8",
    );

    const settingsPath = join(homeDir, ".gemini", "settings.json");
    writeFileSync(
      settingsPath,
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

    const result = remediate(settingsPath, scanForStdioServers(settingsPath), {
      stdio_action: "replace-with-hub",
    });
    const updated = JSON.parse(readFileSync(settingsPath, "utf8"));

    assert.equal(result.modified, true);
    assert.equal(existsSync(`${settingsPath}.bak`), true);
    assert.deepEqual(result.removedServers, ["unsafe-stdio"]);
    assert.equal(
      updated.mcpServers["tfx-hub"].url,
      "http://127.0.0.1:30123/mcp",
    );
    assert.equal(Object.hasOwn(updated.mcpServers, "unsafe-stdio"), false);
  });

  it("uses TFX_HUB_PORT env as single source when resolving Hub URL", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);
    process.env.TFX_HUB_PORT = "29991";

    assert.equal(resolveHubUrl(), "http://127.0.0.1:29991/mcp");
  });

  it("ignores hub.pid port (pid is host hint only, PR #158 policy)", () => {
    const homeDir = createHomeDir();
    withHome(homeDir);
    delete process.env.TFX_HUB_PORT;

    writeFileSync(
      join(homeDir, ".claude", "cache", "tfx-hub", "hub.pid"),
      JSON.stringify({ host: "127.0.0.1", port: 29991 }),
      "utf8",
    );

    // env 없음 + hub.pid port 존재 → registry/default 27888 fallback.
    // pid port cascade 가 제거되어 29991 이 쓰이면 안 됨.
    assert.equal(resolveHubUrl(), "http://127.0.0.1:27888/mcp");
  });
});
