#!/usr/bin/env node
// MCP 인벤토리 — 백그라운드 비동기 실행
// Codex/Gemini의 MCP 서버 상태를 캐싱하여 cli-route.sh가 동적 힌트 생성에 사용
//
// 출력: ~/.claude/cache/mcp-inventory.json
// 사용: cli-route.sh의 get_mcp_hint()에서 읽음

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const CACHE_DIR = join(homedir(), ".claude", "cache");
const CACHE_FILE = join(CACHE_DIR, "mcp-inventory.json");

function getCodexMcp() {
  try {
    const output = execSync("codex mcp list", {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "ignore"], // stderr 무시 (Windows 호환)
    });
    // 테이블 파싱: 첫 줄 헤더, 이후 줄에서 Name과 Status 추출
    const lines = output.trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];

    const servers = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(/\s{2,}/);
      if (cols.length >= 2) {
        const name = cols[0].trim();
        // Status는 마지막에서 2번째 컬럼 근처
        const statusMatch = lines[i].match(/\b(enabled|disabled)\b/i);
        const status = statusMatch ? statusMatch[1].toLowerCase() : "unknown";
        if (name && !name.startsWith("-")) {
          servers.push({ name, status });
        }
      }
    }
    return servers;
  } catch {
    return null; // codex 미설치 또는 타임아웃
  }
}

function getGeminiMcp() {
  try {
    const settingsPath = join(homedir(), ".gemini", "settings.json");
    if (!existsSync(settingsPath)) return null;

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const mcpServers = settings.mcpServers || {};
    return Object.keys(mcpServers).map(name => ({
      name,
      status: "configured",
    }));
  } catch {
    return null;
  }
}

function main() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const inventory = {
    timestamp: new Date().toISOString(),
    codex: { available: false, servers: [] },
    gemini: { available: false, servers: [] },
  };

  // Codex MCP
  const codexServers = getCodexMcp();
  if (codexServers !== null) {
    inventory.codex.available = true;
    inventory.codex.servers = codexServers;
  }

  // Gemini MCP
  const geminiServers = getGeminiMcp();
  if (geminiServers !== null) {
    inventory.gemini.available = true;
    inventory.gemini.servers = geminiServers;
  }

  writeFileSync(CACHE_FILE, JSON.stringify(inventory, null, 2));
}

main();
