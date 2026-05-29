#!/usr/bin/env node
// scripts/codex-mcp-gateway-sync.mjs — Codex config.toml MCP를 gateway Streamable HTTP로 전환
// Usage: node codex-mcp-gateway-sync.mjs [--enable|--disable|--status]
//
// 문제: Codex CLI가 매 호출마다 MCP 서버를 stdio로 spawn → 좀비 Node.js 프로세스
// 해결: mcp-gateway-start.mjs의 싱글톤 Streamable HTTP 데몬을 재사용하도록 config.toml 전환
//
// before: [mcp_servers.context7]
//         command = "npx"
//         args = ["-y", "@upstash/context7-mcp@latest"]
//
// after:  [mcp_servers.context7]
//         url = "http://127.0.0.1:8100/mcp"

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVERS } from "./lib/mcp-gateway-servers.mjs";

const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const BACKUP_SUFFIX = ".pre-gateway.bak";
const CODEX_CONFIG_SYNC_OPT_IN = "TFX_CODEX_CONFIG_SYNC";

// gateway 서버 → Streamable HTTP URL 매핑
const GATEWAY_MAP = new Map(
  SERVERS.map((s) => [s.name, `http://127.0.0.1:${s.port}/mcp`]),
);

// stdio 정의를 보존해야 하는 MCP 서버 (gateway 대상 아님)
const _KEEP_STDIO = new Set([
  "omx_state",
  "omx_memory",
  "omx_code_intel",
  "omx_trace",
  "omx_team_run",
  "tfx-hub",
]);

function parseTomlMcpServers(content) {
  const servers = new Map();
  const re = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
  let match;

  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length;

    // 다음 [section] 또는 파일 끝까지가 이 서버의 범위
    const nextSection = content.indexOf("\n[", startIdx);
    const block = content
      .slice(startIdx, nextSection === -1 ? undefined : nextSection)
      .trim();

    const hasUrl = /^url\s*=/m.test(block);
    const hasCommand = /^command\s*=/m.test(block);
    const urlMatch = block.match(/^url\s*=\s*["']([^"']*)["']/m);
    const url = urlMatch ? urlMatch[1] : null;

    servers.set(name, {
      block,
      hasUrl,
      hasCommand,
      url,
      startIdx,
      headerIdx: match.index,
    });
  }

  return servers;
}

// 블록의 url 값이 이 서버의 기대 gateway /mcp endpoint 와 일치하는지 판정.
// /sse 등 stale endpoint 는 false → enableGateway 가 강제 재작성, getStatus 는
// "needs-migration" 으로 분류한다.
function isCurrentGatewayUrl(srv, expectedUrl) {
  return Boolean(srv) && srv.url === expectedUrl;
}

function buildHttpEntry(name, url) {
  return `[mcp_servers.${name}]\nurl = "${url}"\n`;
}

function _buildStdioEntry(name, block) {
  return `[mcp_servers.${name}]\n${block}\n`;
}

function isProtectedCodexConfigMutationEnv(env = process.env) {
  return env.NODE_ENV === "test" || env.CI === "true" || env.TFX_TEST === "1";
}

function shouldSkipCodexConfigMutation() {
  return (
    process.env[CODEX_CONFIG_SYNC_OPT_IN] !== "1" &&
    isProtectedCodexConfigMutationEnv()
  );
}

// ── enable: stdio → Streamable HTTP ──

export function enableGateway(configPath = CODEX_CONFIG) {
  if (shouldSkipCodexConfigMutation()) {
    console.log("[SKIP] protected environment; config.toml not modified");
    return { changed: 0, skipped: 0, reason: "protected-env" };
  }

  if (!existsSync(configPath)) {
    console.log("[SKIP] ~/.codex/config.toml not found");
    return { changed: 0, skipped: 0 };
  }

  const original = readFileSync(configPath, "utf8");
  const servers = parseTomlMcpServers(original);

  // 백업 (최초 1회만)
  const backupPath = configPath + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    copyFileSync(configPath, backupPath);
    console.log(`[BACKUP] ${backupPath}`);
  }

  let content = original;
  let changed = 0;
  let skipped = 0;

  for (const [name, url] of GATEWAY_MAP) {
    const srv = servers.get(name);

    if (!srv) {
      // 서버 미등록 → HTTP entry 추가
      content += `\n${buildHttpEntry(name, url)}`;
      changed++;
      console.log(`[ADD] ${name} → ${url}`);
      continue;
    }

    if (srv.hasUrl) {
      if (isCurrentGatewayUrl(srv, url)) {
        // 이미 올바른 /mcp gateway URL → 스킵
        skipped++;
        continue;
      }
      // stale URL (예: v10.27.0 이 남긴 /sse) → 올바른 /mcp 로 강제 재작성.
      // 데몬이 streamableHttp /mcp 만 서빙하므로 그대로 두면 dead path 가 된다.
      const oldSection = `[mcp_servers.${name}]\n${srv.block}`;
      const newSection = buildHttpEntry(name, url).trim();
      content = content.replace(oldSection, newSection);
      changed++;
      console.log(`[MIGRATE] ${name}: ${srv.url} → ${url}`);
      continue;
    }

    if (srv.hasCommand) {
      // stdio → Streamable HTTP 전환: 기존 블록을 URL로 교체
      const oldSection = `[mcp_servers.${name}]\n${srv.block}`;
      const newSection = buildHttpEntry(name, url).trim();
      content = content.replace(oldSection, newSection);
      changed++;
      console.log(`[CONVERT] ${name}: stdio → ${url}`);
    }
  }

  // preflight MCP 서버 등록 — Codex 시작 시 gateway 자동 기동 보장
  const preflightName = "tfx-gateway-preflight";
  if (!servers.has(preflightName)) {
    const resolvedPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "codex-gateway-preflight.mjs",
    ).replace(/\\/g, "\\\\");
    content += `\n[mcp_servers.${preflightName}]\ncommand = "node"\nargs = ["${resolvedPath}"]\nenabled = true\nstartup_timeout_sec = 10\n`;
    changed++;
    console.log(`[ADD] ${preflightName} — Codex 시작 시 gateway 자동 기동`);
  }

  if (changed > 0) {
    writeFileSync(configPath, content, "utf8");
    console.log(
      `\n[DONE] ${changed} servers converted, ${skipped} already HTTP`,
    );
  } else {
    console.log(`\n[DONE] No changes needed (${skipped} already HTTP)`);
  }

  return { changed, skipped };
}

// ── disable: HTTP → stdio 복원 ──

export function disableGateway() {
  if (shouldSkipCodexConfigMutation()) {
    console.log("[SKIP] protected environment; config.toml not restored");
    return false;
  }

  const backupPath = CODEX_CONFIG + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    console.log("[SKIP] No backup found — nothing to restore");
    return false;
  }

  copyFileSync(backupPath, CODEX_CONFIG);
  console.log("[RESTORE] config.toml restored from pre-gateway backup");
  return true;
}

// ── status: 현재 상태 확인 ──

export function getStatus(configPath = CODEX_CONFIG) {
  if (!existsSync(configPath)) {
    return { exists: false, servers: [] };
  }

  const content = readFileSync(configPath, "utf8");
  const servers = parseTomlMcpServers(content);
  const result = [];

  for (const [name, url] of GATEWAY_MAP) {
    const srv = servers.get(name);
    if (!srv) {
      result.push({ name, mode: "missing", url });
    } else if (isCurrentGatewayUrl(srv, url)) {
      result.push({ name, mode: "http", url });
    } else if (srv.hasUrl) {
      // url 은 있으나 기대 /mcp endpoint 가 아님 (stale /sse 등) → 마이그레이션 필요
      result.push({ name, mode: "needs-migration", url, currentUrl: srv.url });
    } else {
      result.push({ name, mode: "stdio", url });
    }
  }

  return { exists: true, servers: result };
}

// ── CLI ──

const arg = process.argv[2];

if (arg === "--enable") {
  enableGateway();
} else if (arg === "--disable") {
  disableGateway();
} else if (arg === "--status") {
  const { exists, servers } = getStatus();
  if (!exists) {
    console.log("config.toml not found");
    process.exit(1);
  }
  console.log("\nCodex MCP Gateway Status:");
  console.log("─".repeat(50));
  for (const s of servers) {
    const icon =
      s.mode === "http"
        ? "✅"
        : s.mode === "stdio" || s.mode === "needs-migration"
          ? "⚠️"
          : "❌";
    const note =
      s.mode === "stdio"
        ? "← zombie risk"
        : s.mode === "needs-migration"
          ? `← stale endpoint (${s.currentUrl}) — run --enable`
          : "";
    console.log(`${icon} ${s.name.padEnd(15)} ${s.mode.padEnd(15)} ${note}`);
  }
} else {
  console.log(
    "Usage: codex-mcp-gateway-sync.mjs [--enable|--disable|--status]",
  );
  console.log(
    "  --enable   Convert stdio MCP servers to Streamable HTTP gateway URLs",
  );
  console.log("  --disable  Restore original stdio config from backup");
  console.log("  --status   Show current MCP connection mode per server");
}
