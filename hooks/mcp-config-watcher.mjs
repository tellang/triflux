#!/usr/bin/env node
// hooks/mcp-config-watcher.mjs — PostToolUse:Edit|Write 훅
//
// 감시 대상 MCP 설정 파일 변경을 감지해 stdio 서버를 즉시 차단/치환한다.
// 경로가 watched_paths와 매칭되지 않으면 바로 종료해 일반 편집 성능에 영향이 없도록 한다.

import { readFileSync } from "node:fs";
import {
  isWatchedPath,
  loadRegistry,
  remediate,
  scanForStdioServers,
} from "../scripts/lib/mcp-guard-engine.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function buildSystemMessage(filePath, stdioServers, result) {
  const lines = [`[mcp-guard] 감시 대상 MCP 설정 변경 감지: ${filePath}`];

  if (result.modified) {
    const actionLabel = result.replacement ? "자동 치환" : "자동 제거";
    lines.push(`[mcp-guard] stdio MCP ${actionLabel}: ${stdioServers.map((server) => server.name).join(", ")}`);

    if (result.replacement?.name && result.replacement?.url) {
      lines.push(`[mcp-guard] 대체 서버: ${result.replacement.name} -> ${result.replacement.url}`);
    }

    if (result.backupPath) {
      lines.push(`[mcp-guard] 백업: ${result.backupPath}`);
    }
  }

  for (const warning of result.warnings || []) {
    lines.push(warning);
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name || "";
  if (toolName !== "Edit" && toolName !== "Write") process.exit(0);

  const filePath = input.tool_input?.file_path || "";
  if (!filePath || !isWatchedPath(filePath)) process.exit(0);

  let registry;
  try {
    registry = loadRegistry();
  } catch {
    process.exit(0);
  }

  const stdioServers = scanForStdioServers(filePath);
  if (stdioServers.length === 0) process.exit(0);

  const result = remediate(filePath, stdioServers, registry.policies);
  const systemMessage = buildSystemMessage(filePath, stdioServers, result);

  if (systemMessage) {
    process.stdout.write(JSON.stringify({ systemMessage }));
  }
}

try {
  main();
} catch {
  process.exit(0);
}
