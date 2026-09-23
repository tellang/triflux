// scripts/lib/mcp-manifest.mjs
// MCP 서버 활성화 매니페스트 — 단일 진실 소스.
// tfx-setup 위저드가 저장하고, gateway/filter가 참조한다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MANIFEST_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "mcp-enabled.json",
);

/** API 키 불필요 — 항상 활성화 for gateway-managed MCP servers (현재 없음 — serena는 2026-06-10 core에서 제거) */
export const CORE_SERVERS = Object.freeze([]);

export function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeManifest(enabledServers) {
  const dir = dirname(MANIFEST_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    enabled: [...new Set([...CORE_SERVERS, ...enabledServers])],
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * 단일 서버 활성화 여부 확인.
 * 매니페스트 미존재 시 true (레거시 호환).
 */
export function isServerEnabled(serverName) {
  const manifest = readManifest();
  if (!manifest) return true;
  if (CORE_SERVERS.includes(serverName)) return true;
  return (manifest.enabled || []).includes(serverName);
}
