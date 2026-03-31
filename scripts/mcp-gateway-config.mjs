#!/usr/bin/env node
// mcp-gateway-config.mjs — Claude Code MCP stdio↔SSE 전환
// Usage: node mcp-gateway-config.mjs --enable   # stdio → SSE
//        node mcp-gateway-config.mjs --disable  # SSE → stdio (복원)

import { execSync } from 'node:child_process';
import { isServerEnabled } from './lib/mcp-manifest.mjs';

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
  // 여러 scope에서 제거 시도 (user → local)
  run(`claude mcp remove "${name}" -s user`);
  run(`claude mcp remove "${name}" -s local`);
}

function enableSse() {
  console.log('Switching MCP servers to SSE mode...\n');
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
      console.error(`  [FAIL] ${name}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} switched, ${fail} failed`);
}

function disableSse() {
  console.log('Restoring MCP servers to stdio mode...\n');
  let ok = 0;
  let fail = 0;

  for (const { name, stdioCmd } of GATEWAY_SERVERS) {
    if (SKIP_SERVERS.has(name)) continue;
    if (!isServerEnabled(name)) {
      console.log(`  [SKIP] ${name} — manifest에서 비활성`);
      continue;
    }

    removeMcp(name);
    const success = run(`claude mcp add "${name}" -s user -- ${stdioCmd}`);

    if (success) {
      console.log(`  [stdio] ${name} → ${stdioCmd}`);
      ok++;
    } else {
      console.error(`  [FAIL] ${name}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} restored, ${fail} failed`);
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
