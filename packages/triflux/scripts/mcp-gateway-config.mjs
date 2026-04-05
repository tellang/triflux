#!/usr/bin/env node
// mcp-gateway-config.mjs — Claude Code MCP stdio↔SSE 전환
// Usage: node mcp-gateway-config.mjs --enable   # stdio → SSE
//        node mcp-gateway-config.mjs --disable  # SSE → stdio (복원)

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { isServerEnabled } from './lib/mcp-manifest.mjs';

const BACKUP_FILE = join(homedir(), '.claude', 'cache', 'mcp-pre-gateway.json');

export const GATEWAY_SERVERS = [
  { name: 'context7',     port: 8100, stdioCmd: 'cmd /c npx -y @upstash/context7-mcp@latest' },
  { name: 'brave-search', port: 8101, stdioCmd: 'cmd /c npx -y @brave/brave-search-mcp-server' },
  { name: 'exa',          port: 8102, stdioCmd: 'cmd /c npx -y exa-mcp-server' },
  { name: 'tavily',       port: 8103, stdioCmd: 'cmd /c npx -y tavily-mcp@latest' },
  { name: 'jira',         port: 8104, stdioCmd: 'cmd /c npx -y mcp-jira-cloud@latest' },
  { name: 'serena',       port: 8105, stdioCmd: 'uvx --from git+https://github.com/oraios/serena serena start-mcp-server' },
  { name: 'notion',       port: 8106, stdioCmd: 'cmd /c npx -y @notionhq/notion-mcp-server' },
  { name: 'notion-guest', port: 8107, stdioCmd: 'cmd /c npx -y @notionhq/notion-mcp-server' },
];

const SKIP_SERVERS = new Set([
  'playwright',
  'claude.ai Notion',
  'plugin:oh-my-claudecode:t',
]);

// Git Bash에서 /c → C:/ 경로 변환 방지
const EXEC_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8', timeout: 15000, env: EXEC_ENV });
    return true;
  } catch {
    return false;
  }
}

function removeMcp(name) {
  run(`claude mcp remove "${name}" -s user`);
  run(`claude mcp remove "${name}" -s local`);
}

// ── 스냅샷: enable 전 기존 MCP 설정 백업 ──

function captureCurrentMcpState() {
  const servers = {};
  for (const { name } of GATEWAY_SERVERS) {
    if (SKIP_SERVERS.has(name)) continue;
    // claude mcp get으로 현재 등록 상태 확인
    try {
      const out = execSync(`claude mcp get "${name}" -s user`, {
        stdio: 'pipe', encoding: 'utf8', timeout: 5000, env: EXEC_ENV,
      }).trim();
      servers[name] = { scope: 'user', raw: out };
    } catch {
      // user에 없으면 local 확인
      try {
        const out = execSync(`claude mcp get "${name}" -s local`, {
          stdio: 'pipe', encoding: 'utf8', timeout: 5000, env: EXEC_ENV,
        }).trim();
        servers[name] = { scope: 'local', raw: out };
      } catch {
        servers[name] = null; // 기존에 없었음
      }
    }
  }
  return servers;
}

function saveBackup(servers) {
  const dir = dirname(BACKUP_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const backup = { captured_at: new Date().toISOString(), servers };
  writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`  [BACKUP] ${BACKUP_FILE}`);
}

function loadBackup() {
  if (!existsSync(BACKUP_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BACKUP_FILE, 'utf8'));
  } catch { return null; }
}

// ── enable: 스냅샷 → remove → SSE add (실패 시 rollback) ──

function enableSse() {
  console.log('Switching MCP servers to SSE mode...\n');

  // 1) 현재 상태 스냅샷
  const snapshot = captureCurrentMcpState();
  saveBackup(snapshot);

  let ok = 0;
  let fail = 0;

  for (const { name, port } of GATEWAY_SERVERS) {
    if (SKIP_SERVERS.has(name)) continue;
    if (!isServerEnabled(name)) {
      console.log(`  [SKIP] ${name} — manifest에서 비활성`);
      continue;
    }

    removeMcp(name);
    const url = `http://localhost:${port}/sse`;
    const success = run(`claude mcp add --transport sse -s user "${name}" ${url}`);

    if (success) {
      console.log(`  [SSE] ${name} → ${url}`);
      ok++;
    } else {
      // add 실패 → 원본 복원 시도
      console.error(`  [FAIL] ${name} — rollback 시도`);
      const orig = snapshot[name];
      if (orig) {
        // H1 fix: orig.raw를 shell-escape하여 injection 방지
      const safeRaw = (orig.raw || '').replace(/[;`$(){}|&<>]/g, '');
      const restored = safeRaw ? run(`claude mcp add "${name}" -s ${orig.scope} -- ${safeRaw}`) : false;
        console.error(`  [ROLLBACK] ${name}: ${restored ? 'ok' : 'FAIL'}`);
      }
      fail++;
    }
  }

  console.log(`\nDone: ${ok} switched, ${fail} failed`);
}

// ── disable: 백업에서 서버별 원복 ──

function disableSse() {
  console.log('Restoring MCP servers from backup...\n');
  const backup = loadBackup();

  // C1 fix: 백업 없으면 전체 삭제 방지
  if (!backup) {
    console.error('No backup found — cannot restore. Run --enable first to create a backup.');
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;

  for (const { name, stdioCmd } of GATEWAY_SERVERS) {
    if (SKIP_SERVERS.has(name)) continue;

    const orig = backup.servers?.[name];

    if (orig === null || orig === undefined) {
      // 기존에 없었던 서버 → triflux가 추가한 것 → remove만
      removeMcp(name);
      console.log(`  [REMOVE] ${name} — triflux가 추가한 서버, 원본 없음`);
      ok++;
      continue;
    }

    // H2 fix: 백업의 scope/raw를 사용하여 원본 복원, fallback으로 stdioCmd
    removeMcp(name);
    const restoreScope = orig.scope || 'user';
    const restoreCmd = orig.raw && orig.raw.trim() ? orig.raw.trim() : stdioCmd;
    const success = run(`claude mcp add "${name}" -s ${restoreScope} -- ${restoreCmd}`);

    if (success) {
      console.log(`  [RESTORE] ${name} → scope=${restoreScope}`);
      ok++;
    } else {
      // fallback: stdioCmd로 재시도
      const fallback = run(`claude mcp add "${name}" -s user -- ${stdioCmd}`);
      if (fallback) {
        console.log(`  [FALLBACK] ${name} → stdio (원본 복원 실패, 기본값 사용)`);
        ok++;
      } else {
        console.error(`  [FAIL] ${name}`);
        fail++;
      }
    }
  }

  console.log(`\nDone: ${ok} restored, ${fail} failed`);
  console.log(`Backup preserved at: ${BACKUP_FILE}`);
}

function printUsage() {
  console.log(`Usage: node mcp-gateway-config.mjs [--enable|--disable]

  --enable   Switch Claude Code MCP servers from stdio to SSE (supergateway)
  --disable  Restore Claude Code MCP servers to original stdio mode

Servers managed: ${GATEWAY_SERVERS.map((s) => s.name).join(', ')}
Servers skipped: ${[...SKIP_SERVERS].join(', ')}`);
}

// ── main ──
const flag = process.argv[2];

if (flag === '--enable') {
  enableSse();
} else if (flag === '--disable') {
  disableSse();
} else {
  printUsage();
  process.exit(flag ? 1 : 0);
}
