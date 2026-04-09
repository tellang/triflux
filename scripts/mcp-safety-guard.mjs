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

export async function run(stdinData) {
  void stdinData;

  let registry;
  try {
    registry = loadRegistry();
  } catch {
    return { code: 0, stdout: "", stderr: "" };
  }

  const stdioServers = scanForStdioServers(GEMINI_SETTINGS);

  if (stdioServers.length === 0) {
    return { code: 0, stdout: "", stderr: "" };
  }

  const result = remediate(GEMINI_SETTINGS, stdioServers, registry.policies);
  const names = stdioServers.map((server) => server.name).join(", ");
  const stdout = [];

  if (result.modified) {
    const actionLabel = result.replacement ? "자동 치환" : "자동 제거";
    stdout.push(
      `[mcp-safety] ${stdioServers.length}개 stdio MCP ${actionLabel}: ${names}`,
    );
    if (result.replacement?.name && result.replacement?.url) {
      stdout.push(
        `[mcp-safety] 대체 서버: ${result.replacement.name} -> ${result.replacement.url}`,
      );
    }
    if (result.backupPath) {
      stdout.push(`[mcp-safety] 백업: ${result.backupPath}`);
    }
    stdout.push(
      "[mcp-safety] Gemini는 Hub URL만 사용합니다. stdio MCP는 spawn EPERM을 유발합니다.",
    );
  }

  for (const warning of result.warnings || []) {
    stdout.push(warning);
  }

  return {
    code: 0,
    stdout: stdout.length > 0 ? `${stdout.join("\n")}\n` : "",
    stderr: "",
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

if (isMain) {
  const result = await run();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
