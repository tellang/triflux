// scripts/lib/mcp-manifest.mjs
// MCP 서버 활성화 매니페스트 — 단일 진실 소스.
// tfx-setup 위저드가 저장하고, gateway/filter가 참조한다.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const MANIFEST_PATH = join(homedir(), '.claude', 'cache', 'mcp-enabled.json');

/** API 키 불필요 — 항상 활성화 */
export const CORE_SERVERS = Object.freeze(['context7', 'serena']);

/** 검색 MCP — API 키 필요 */
export const SEARCH_SERVERS = Object.freeze([
  { name: 'brave-search', envVars: ['BRAVE_API_KEY'] },
  { name: 'exa',          envVars: ['EXA_API_KEY'] },
  { name: 'tavily',       envVars: ['TAVILY_API_KEY'] },
]);

/** 통합 MCP — API 키 + 추가 설정 필요 */
export const INTEGRATION_SERVERS = Object.freeze([
  { name: 'jira',         envVars: ['JIRA_API_TOKEN', 'JIRA_EMAIL', 'JIRA_INSTANCE_URL'] },
  { name: 'notion',       envVars: ['NOTION_TOKEN'] },
  { name: 'notion-guest', envVars: ['NOTION_TOKEN'] },
]);

export function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
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
 * 매니페스트 기준으로 활성 서버만 필터링.
 * @param {Array<string|{name:string}>} allServers — 전체 서버 목록
 * @returns {Array} 활성 서버 목록. 매니페스트 미존재 시 null (레거시 모드).
 */
export function filterByManifest(allServers) {
  const manifest = readManifest();
  if (!manifest) return null;
  const enabled = new Set(manifest.enabled || []);
  for (const core of CORE_SERVERS) enabled.add(core);
  return allServers.filter((s) => enabled.has(typeof s === 'string' ? s : s.name));
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

/** 특정 서버에 필요한 환경변수 중 누락된 것 반환 */
export function getMissingEnvVars(serverName) {
  const all = [...SEARCH_SERVERS, ...INTEGRATION_SERVERS];
  const entry = all.find((s) => s.name === serverName);
  if (!entry) return [];
  return entry.envVars.filter((k) => !process.env[k]);
}
