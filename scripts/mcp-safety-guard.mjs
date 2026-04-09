#!/usr/bin/env node

// mcp-safety-guard.mjs — Gemini stdio MCP 자동 감지 + 치환
// SessionStart 훅으로 실행. stdio MCP는 Windows에서 spawn EPERM → Gemini stall 유발.
// 감지 시 공통 guard engine으로 제거/치환하고 백업 파일 생성.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  remediate,
  scanForStdioServers,
} from "./lib/mcp-guard-engine.mjs";

const GEMINI_SETTINGS = join(homedir(), ".gemini", "settings.json");

function run() {
  let registry;
  try {
    registry = loadRegistry();
  } catch {
    return;
  }

  const stdioServers = scanForStdioServers(GEMINI_SETTINGS);

  if (stdioServers.length === 0) return; // 모두 안전

  const result = remediate(GEMINI_SETTINGS, stdioServers, registry.policies);
  const names = stdioServers.map((server) => server.name).join(", ");

  if (result.modified) {
    const actionLabel = result.replacement ? "자동 치환" : "자동 제거";
    console.log(
      `[mcp-safety] ${stdioServers.length}개 stdio MCP ${actionLabel}: ${names}`,
    );
    if (result.replacement?.name && result.replacement?.url) {
      console.log(
        `[mcp-safety] 대체 서버: ${result.replacement.name} -> ${result.replacement.url}`,
      );
    }
    if (result.backupPath) {
      console.log(`[mcp-safety] 백업: ${result.backupPath}`);
    }
    console.log(
      "[mcp-safety] Gemini는 Hub URL만 사용합니다. stdio MCP는 spawn EPERM을 유발합니다.",
    );
  }

  for (const warning of result.warnings || []) {
    console.log(warning);
  }
}

run();
