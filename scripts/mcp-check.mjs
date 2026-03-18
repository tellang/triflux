#!/usr/bin/env node
// MCP inventory cache for dynamic MCP filtering.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeServerMetadata } from './lib/mcp-server-catalog.mjs';

const CACHE_DIR = join(homedir(), '.claude', 'cache');
const CACHE_FILE = join(CACHE_DIR, 'mcp-inventory.json');

function countConfiguredTools(config = {}, fallbackToolCount = 0) {
  const directKeys = ['tools', 'toolNames', 'allowedTools', 'includeTools'];
  for (const key of directKeys) {
    if (Array.isArray(config[key])) return config[key].length;
  }

  if (Array.isArray(config.excludeTools)) {
    return Math.max(0, fallbackToolCount - config.excludeTools.length);
  }

  return fallbackToolCount;
}

export function createServerRecord(name, status, config = {}) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
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
    const output = execSync('codex mcp list', {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const lines = output.trim().split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return [];

    const servers = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(/\s{2,}/);
      if (cols.length < 2) continue;

      const name = cols[0].trim();
      const statusMatch = lines[i].match(/\b(enabled|disabled)\b/i);
      const status = statusMatch ? statusMatch[1].toLowerCase() : 'unknown';
      if (!name || name.startsWith('-')) continue;
      servers.push(createServerRecord(name, status));
    }
    return servers;
  } catch {
    return null;
  }
}

export function getGeminiMcp() {
  try {
    const settingsPath = join(homedir(), '.gemini', 'settings.json');
    if (!existsSync(settingsPath)) return null;

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const mcpServers = settings.mcpServers || {};
    return Object.entries(mcpServers).map(([name, config]) => createServerRecord(name, 'configured', config || {}));
  } catch {
    return null;
  }
}

export function buildInventory() {
  const inventory = {
    timestamp: new Date().toISOString(),
    codex: { available: false, servers: [] },
    gemini: { available: false, servers: [] },
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
