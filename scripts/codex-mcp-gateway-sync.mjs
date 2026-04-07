#!/usr/bin/env node
// scripts/codex-mcp-gateway-sync.mjs — Codex config.toml MCP를 gateway SSE로 전환
// Usage: node codex-mcp-gateway-sync.mjs [--enable|--disable|--status]
//
// 문제: Codex CLI가 매 호출마다 MCP 서버를 stdio로 spawn → 좀비 Node.js 프로세스
// 해결: mcp-gateway-start.mjs의 싱글톤 SSE 데몬을 재사용하도록 config.toml 전환
//
// before: [mcp_servers.context7]
//         command = "npx"
//         args = ["-y", "@upstash/context7-mcp@latest"]
//
// after:  [mcp_servers.context7]
//         url = "http://127.0.0.1:8100/sse"

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SERVERS } from './mcp-gateway-start.mjs';

const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml');
const BACKUP_SUFFIX = '.pre-gateway.bak';

// gateway 서버 → SSE URL 매핑
const GATEWAY_MAP = new Map(
  SERVERS.map((s) => [s.name, `http://127.0.0.1:${s.port}/sse`]),
);

// stdio 정의를 보존해야 하는 MCP 서버 (gateway 대상 아님)
const KEEP_STDIO = new Set([
  'omx_state', 'omx_memory', 'omx_code_intel', 'omx_trace', 'omx_team_run',
  'tfx-hub',
]);

function parseTomlMcpServers(content) {
  const servers = new Map();
  const re = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
  let match;

  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length;

    // 다음 [section] 또는 파일 끝까지가 이 서버의 범위
    const nextSection = content.indexOf('\n[', startIdx);
    const block = content.slice(startIdx, nextSection === -1 ? undefined : nextSection).trim();

    const hasUrl = /^url\s*=/m.test(block);
    const hasCommand = /^command\s*=/m.test(block);

    servers.set(name, { block, hasUrl, hasCommand, startIdx, headerIdx: match.index });
  }

  return servers;
}

function buildSseEntry(name, url) {
  return `[mcp_servers.${name}]\nurl = "${url}"\n`;
}

function buildStdioEntry(name, block) {
  return `[mcp_servers.${name}]\n${block}\n`;
}

// ── enable: stdio → SSE ──

export function enableGateway() {
  if (!existsSync(CODEX_CONFIG)) {
    console.log('[SKIP] ~/.codex/config.toml not found');
    return { changed: 0, skipped: 0 };
  }

  const original = readFileSync(CODEX_CONFIG, 'utf8');
  const servers = parseTomlMcpServers(original);

  // 백업 (최초 1회만)
  const backupPath = CODEX_CONFIG + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    copyFileSync(CODEX_CONFIG, backupPath);
    console.log(`[BACKUP] ${backupPath}`);
  }

  let content = original;
  let changed = 0;
  let skipped = 0;

  for (const [name, url] of GATEWAY_MAP) {
    const srv = servers.get(name);

    if (!srv) {
      // 서버 미등록 → SSE entry 추가
      content += `\n${buildSseEntry(name, url)}`;
      changed++;
      console.log(`[ADD] ${name} → ${url}`);
      continue;
    }

    if (srv.hasUrl) {
      // 이미 URL 기반 → 스킵
      skipped++;
      continue;
    }

    if (srv.hasCommand) {
      // stdio → SSE 전환: 기존 블록을 URL로 교체
      const oldSection = `[mcp_servers.${name}]\n${srv.block}`;
      const newSection = buildSseEntry(name, url).trim();
      content = content.replace(oldSection, newSection);
      changed++;
      console.log(`[CONVERT] ${name}: stdio → ${url}`);
    }
  }

  // preflight MCP 서버 등록 — Codex 시작 시 gateway 자동 기동 보장
  const preflightName = 'tfx-gateway-preflight';
  if (!servers.has(preflightName)) {
    const resolvedPath = join(dirname(fileURLToPath(import.meta.url)), 'codex-gateway-preflight.mjs')
      .replace(/\\/g, '\\\\');
    content += `\n[mcp_servers.${preflightName}]\ncommand = "node"\nargs = ["${resolvedPath}"]\nenabled = true\nstartup_timeout_sec = 10\n`;
    changed++;
    console.log(`[ADD] ${preflightName} — Codex 시작 시 gateway 자동 기동`);
  }

  if (changed > 0) {
    writeFileSync(CODEX_CONFIG, content, 'utf8');
    console.log(`\n[DONE] ${changed} servers converted, ${skipped} already SSE`);
  } else {
    console.log(`\n[DONE] No changes needed (${skipped} already SSE)`);
  }

  return { changed, skipped };
}

// ── disable: SSE → stdio 복원 ──

export function disableGateway() {
  const backupPath = CODEX_CONFIG + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    console.log('[SKIP] No backup found — nothing to restore');
    return false;
  }

  copyFileSync(backupPath, CODEX_CONFIG);
  console.log('[RESTORE] config.toml restored from pre-gateway backup');
  return true;
}

// ── status: 현재 상태 확인 ──

export function getStatus() {
  if (!existsSync(CODEX_CONFIG)) {
    return { exists: false, servers: [] };
  }

  const content = readFileSync(CODEX_CONFIG, 'utf8');
  const servers = parseTomlMcpServers(content);
  const result = [];

  for (const [name, url] of GATEWAY_MAP) {
    const srv = servers.get(name);
    if (!srv) {
      result.push({ name, mode: 'missing', url });
    } else if (srv.hasUrl) {
      result.push({ name, mode: 'sse', url });
    } else {
      result.push({ name, mode: 'stdio', url });
    }
  }

  return { exists: true, servers: result };
}

// ── CLI ──

const arg = process.argv[2];

if (arg === '--enable') {
  enableGateway();
} else if (arg === '--disable') {
  disableGateway();
} else if (arg === '--status') {
  const { exists, servers } = getStatus();
  if (!exists) {
    console.log('config.toml not found');
    process.exit(1);
  }
  console.log('\nCodex MCP Gateway Status:');
  console.log('─'.repeat(50));
  for (const s of servers) {
    const icon = s.mode === 'sse' ? '✅' : s.mode === 'stdio' ? '⚠️' : '❌';
    console.log(`${icon} ${s.name.padEnd(15)} ${s.mode.padEnd(8)} ${s.mode === 'stdio' ? '← zombie risk' : ''}`);
  }
} else {
  console.log('Usage: codex-mcp-gateway-sync.mjs [--enable|--disable|--status]');
  console.log('  --enable   Convert stdio MCP servers to SSE gateway URLs');
  console.log('  --disable  Restore original stdio config from backup');
  console.log('  --status   Show current MCP connection mode per server');
}
