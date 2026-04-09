#!/usr/bin/env node
// MCP inventory cache for dynamic MCP filtering.

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_SERVER_TOOL_CATALOG,
  normalizeServerMetadata,
} from "./lib/mcp-server-catalog.mjs";

const CACHE_DIR = join(homedir(), ".claude", "cache");
const CACHE_FILE = join(CACHE_DIR, "mcp-inventory.json");

function countConfiguredTools(config = {}, fallbackToolCount = 0) {
  const directKeys = ["tools", "toolNames", "allowedTools", "includeTools"];
  for (const key of directKeys) {
    if (Array.isArray(config[key])) return config[key].length;
  }

  if (Array.isArray(config.excludeTools)) {
    return Math.max(0, fallbackToolCount - config.excludeTools.length);
  }

  return fallbackToolCount;
}

export function createServerRecord(name, status, config = {}) {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  const fallback = normalizeServerMetadata(normalizedName, {});
  const toolCount = countConfiguredTools(config, fallback.tool_count);
  const domainTags = Array.isArray(config.domain_tags)
    ? config.domain_tags
    : Array.isArray(config.domainTags)
      ? config.domainTags
      : [];

  const metadata = normalizeServerMetadata(normalizedName, {
    ...config,
    tool_count: toolCount,
    domain_tags: domainTags,
  });

  return {
    name: normalizedName,
    status,
    tool_count: metadata.tool_count,
    domain_tags: metadata.domain_tags,
  };
}

export function getCodexMcp() {
  try {
    const output = execSync("codex mcp list", {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = output
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim());
    if (lines.length < 2) return [];

    const servers = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(/\s{2,}/);
      if (cols.length < 2) continue;

      const name = cols[0].trim();
      const statusMatch = lines[i].match(/\b(enabled|disabled)\b/i);
      const status = statusMatch ? statusMatch[1].toLowerCase() : "unknown";
      if (!name || name.startsWith("-")) continue;
      servers.push(createServerRecord(name, status));
    }
    return servers;
  } catch {
    return null;
  }
}

export function getGeminiMcp() {
  try {
    const settingsPath = join(homedir(), ".gemini", "settings.json");
    if (!existsSync(settingsPath)) return null;

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const mcpServers = settings.mcpServers || {};
    return Object.entries(mcpServers).map(([name, config]) =>
      createServerRecord(name, "configured", config || {}),
    );
  } catch {
    return null;
  }
}

// ── Claude MCP 서버 발견 ──

const CLAUDE_DIR = join(homedir(), ".claude");

// Anthropic 클라우드 호스팅 MCP 서버 — Claude Code 런타임에서 항상 가용.
// mcp-server-catalog.mjs의 MCP_SERVER_TOOL_CATALOG에 정의된 서버 중
// 로컬 설치가 불필요한 클라우드 제공 서버.
const WELL_KNOWN_CLOUD_SERVERS = Object.freeze([
  "brave-search",
  "exa",
  "context7",
]);

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function extractMcpServerNames(mcpJsonPath) {
  const data = readJsonSafe(mcpJsonPath);
  if (!data?.mcpServers || typeof data.mcpServers !== "object") return [];
  return Object.entries(data.mcpServers)
    .filter(([name]) => typeof name === "string" && name.trim())
    .map(([name, config]) => ({ name: name.trim(), config: config || {} }));
}

function walkUpForMcpJson(startDir, maxDepth = 5) {
  const found = [];
  let dir = resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = join(dir, ".mcp.json");
    if (existsSync(candidate)) found.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function scanPluginsMcpJson() {
  const pluginsDir = join(CLAUDE_DIR, "plugins");
  if (!existsSync(pluginsDir)) return [];
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(dir, entry.name);
        if (entry.isFile() && entry.name === ".mcp.json") {
          found.push(full);
        } else if (entry.isDirectory()) {
          walk(full, depth + 1);
        }
      }
    } catch {
      /* permission errors */
    }
  };
  walk(pluginsDir);
  return found;
}

export function getClaudeMcp(cwd = process.cwd()) {
  const serverMap = new Map();

  // 1) .mcp.json 파일 트리 스캔 (CWD → root)
  for (const mcpJson of walkUpForMcpJson(cwd)) {
    for (const { name, config } of extractMcpServerNames(mcpJson)) {
      if (!serverMap.has(name)) {
        serverMap.set(name, createServerRecord(name, "configured", config));
      }
    }
  }

  // 2) ~/.claude/plugins/ 스캔
  for (const mcpJson of scanPluginsMcpJson()) {
    for (const { name, config } of extractMcpServerNames(mcpJson)) {
      if (!serverMap.has(name)) {
        serverMap.set(name, createServerRecord(name, "configured", config));
      }
    }
  }

  // 3) ~/.claude/settings.json + settings.local.json의 mcpServers
  for (const settingsFile of ["settings.json", "settings.local.json"]) {
    const data = readJsonSafe(join(CLAUDE_DIR, settingsFile));
    if (!data?.mcpServers) continue;
    for (const [name, config] of Object.entries(data.mcpServers)) {
      if (typeof name !== "string" || !name.trim()) continue;
      if (!serverMap.has(name.trim())) {
        serverMap.set(
          name.trim(),
          createServerRecord(name.trim(), "configured", config || {}),
        );
      }
    }
  }

  // 4) Well-known Anthropic 클라우드 MCP 서버 (카탈로그에 정의된 것만)
  for (const name of WELL_KNOWN_CLOUD_SERVERS) {
    if (serverMap.has(name)) continue;
    if (!MCP_SERVER_TOOL_CATALOG[name]) continue;
    serverMap.set(name, createServerRecord(name, "available"));
  }

  return [...serverMap.values()];
}

export function buildInventory(cwd = process.cwd()) {
  const inventory = {
    timestamp: new Date().toISOString(),
    codex: { available: false, servers: [] },
    gemini: { available: false, servers: [] },
    claude: { available: true, servers: [] },
  };

  const codexServers = getCodexMcp();
  if (codexServers !== null) {
    inventory.codex.available = true;
    inventory.codex.servers = codexServers;
  }

  const geminiServers = getGeminiMcp();
  if (geminiServers !== null) {
    inventory.gemini.available = true;
    inventory.gemini.servers = geminiServers;
  }

  inventory.claude.servers = getClaudeMcp(cwd);

  return inventory;
}

export function writeInventoryCache(inventory = buildInventory()) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(inventory, null, 2));
  return inventory;
}

export function main() {
  writeInventoryCache();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
