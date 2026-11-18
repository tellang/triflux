// MCP 서버 활성화 매니페스트 (tfx-setup 저장, MCP 필터 참조)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MANIFEST_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "mcp-enabled.json",
);

/** API 키 불필요 서버 (현재 없음) */
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

// 매니페스트 미존재 시 true (레거시 호환)
export function isServerEnabled(serverName) {
  const manifest = readManifest();
  if (!manifest) return true;
  if (CORE_SERVERS.includes(serverName)) return true;
  return (manifest.enabled || []).includes(serverName);
}
