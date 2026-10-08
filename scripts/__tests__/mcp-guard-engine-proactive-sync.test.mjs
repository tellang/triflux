import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { syncRegistryTargets } from "../lib/mcp-guard-engine.mjs";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TFX_TEST: process.env.TFX_TEST,
};
const originalCwd = process.cwd();
const tempRoots = [];

function makeTempRoot(prefix = "mcp-guard-proactive-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function useHome(homeDir) {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

function writeGeminiSettings(homeDir, settings) {
  const settingsPath = join(homeDir, ".gemini", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function registryFor(settingsPath, overrides = {}) {
  return {
    version: 1,
    defaults: { transport: "http" },
    servers: {
      context7: {
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        safe: true,
        targets: ["gemini"],
        description: "Context7 MCP 서버",
      },
      ...(overrides.servers || {}),
    },
    policies: {
      unknown_server_action: "warn",
      sync_denylist: [],
      watched_paths: [settingsPath],
      ...(overrides.policies || {}),
    },
  };
}

beforeEach(() => {
  restoreEnv();
  process.env.TFX_TEST = "1";
});

afterEach(() => {
  process.chdir(originalCwd);
  restoreEnv();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root?.startsWith(tmpdir())) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("mcp guard proactive registry sync", () => {
  it("creates the managed server for empty Gemini mcpServers", () => {
    const homeDir = makeTempRoot();
    useHome(homeDir);
    const settingsPath = writeGeminiSettings(homeDir, { mcpServers: {} });

    const result = syncRegistryTargets({ registry: registryFor(settingsPath) });
    const updated = readJson(settingsPath);

    assert.equal(
      updated.mcpServers.context7.url,
      "https://mcp.context7.com/mcp",
    );
    assert.equal(
      result.actions.some((action) => action.status === "updated"),
      true,
    );
  });

  it("adds only the managed server and preserves unrelated Gemini MCP servers", () => {
    const homeDir = makeTempRoot();
    useHome(homeDir);
    const unrelated = {
      url: "https://example.com/mcp",
      header: "keep-me",
    };
    const settingsPath = writeGeminiSettings(homeDir, {
      mcpServers: {
        unrelated,
      },
    });

    syncRegistryTargets({ registry: registryFor(settingsPath) });
    const updated = readJson(settingsPath);

    assert.deepEqual(updated.mcpServers.unrelated, unrelated);
    assert.deepEqual(Object.keys(updated.mcpServers).sort(), [
      "context7",
      "unrelated",
    ]);
  });

  it("preserves direct stdio entries while adding the managed entry", () => {
    const homeDir = makeTempRoot();
    useHome(homeDir);
    const settingsPath = writeGeminiSettings(homeDir, {
      mcpServers: {
        "unsafe-stdio": { command: "node", args: ["server.js"] },
      },
    });

    const result = syncRegistryTargets({ registry: registryFor(settingsPath) });
    const updated = readJson(settingsPath);

    assert.deepEqual(updated.mcpServers["unsafe-stdio"], {
      command: "node",
      args: ["server.js"],
    });
    assert.equal(
      updated.mcpServers.context7.url,
      "https://mcp.context7.com/mcp",
    );
    assert.equal(
      result.actions.some((action) => action.type === "remediate"),
      false,
    );
  });

  it("skips missing managed entries when sync_denylist contains gemini:context7", () => {
    const homeDir = makeTempRoot();
    useHome(homeDir);
    const settingsPath = writeGeminiSettings(homeDir, { mcpServers: {} });

    const result = syncRegistryTargets({
      registry: registryFor(settingsPath, {
        policies: { sync_denylist: ["gemini:context7"] },
      }),
    });
    const updated = readJson(settingsPath);
    const policySkips = result.actions.filter(
      (action) => action.status === "policy-skip",
    );

    assert.deepEqual(updated.mcpServers, {});
    assert.equal(policySkips.length, 1);
    assert.equal(
      policySkips[0].message,
      "[mcp-guard] policy skip: gemini:context7",
    );
    assert.equal(policySkips[0].message.includes("\n"), false);
  });

  it("does not write again when syncRegistryTargets runs twice", async () => {
    const homeDir = makeTempRoot();
    useHome(homeDir);
    const settingsPath = writeGeminiSettings(homeDir, { mcpServers: {} });
    const registry = registryFor(settingsPath);

    syncRegistryTargets({ registry });
    const beforeContent = readFileSync(settingsPath, "utf8");
    const beforeMtime = statSync(settingsPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const second = syncRegistryTargets({ registry });
    const afterContent = readFileSync(settingsPath, "utf8");
    const afterMtime = statSync(settingsPath).mtimeMs;

    assert.equal(
      second.actions.filter((action) => action.status === "updated").length,
      0,
    );
    assert.equal(afterContent, beforeContent);
    assert.equal(afterMtime, beforeMtime);
  });
});
