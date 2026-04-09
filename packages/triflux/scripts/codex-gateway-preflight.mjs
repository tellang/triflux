#!/usr/bin/env node
// scripts/codex-gateway-preflight.mjs — Codex MCP 초기화 시 gateway 자동 기동
// Codex config.toml에 MCP 서버로 등록되면, Codex 시작 시 이 스크립트가 먼저 실행되어
// gateway가 alive인지 확인하고 죽었으면 기동한다.
// 실제 MCP 기능은 없음 (no-op). 역할은 gateway 보장뿐.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE_PORT = 8100;
const PROBE_TIMEOUT_MS = 2000;
const STARTUP_WAIT_MS = 6000;
const POLL_MS = 500;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분
const CACHE_FILE = join(tmpdir(), "tfx-gateway-alive.json");

function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (Date.now() - data.ts < CACHE_TTL_MS) return data;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache() {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), alive: true }));
  } catch {
    /* ignore */
  }
}

async function isGatewayAlive() {
  // B) Preflight 캐시: 5분 이내 확인했으면 프로브 스킵
  const cached = readCache();
  if (cached) return true;

  try {
    const res = await fetch(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      writeCache();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function startGateway() {
  const script = join(PLUGIN_ROOT, "scripts", "mcp-gateway-start.mjs");
  if (!existsSync(script)) {
    process.stderr.write(
      "[gateway-preflight] mcp-gateway-start.mjs not found\n",
    );
    return false;
  }

  const { execSync } = await import("node:child_process");
  try {
    execSync(`node "${script}"`, {
      stdio: "ignore",
      timeout: STARTUP_WAIT_MS + 2000,
      cwd: PLUGIN_ROOT,
    });
  } catch {
    // gateway-start는 자체 프로세스로 spawn하므로 parent는 바로 종료 가능
  }

  // 헬스체크 대기
  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isGatewayAlive()) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

// ── MCP stdio 프로토콜 (no-op server) ──

async function main() {
  // 1) gateway 보장
  const alive = await isGatewayAlive();
  if (!alive) {
    process.stderr.write("[gateway-preflight] gateway down, starting...\n");
    const ok = await startGateway();
    process.stderr.write(
      ok
        ? "[gateway-preflight] gateway started\n"
        : "[gateway-preflight] gateway start failed\n",
    );
  }

  // 2) MCP JSON-RPC stdio — initialize 핸드셰이크만 처리하고 idle 유지
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "tfx-gateway-preflight", version: "1.0.0" },
          },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (msg.method === "notifications/initialized") {
        // ack, no response needed
      } else if (msg.method === "tools/list") {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [] },
          }) + "\n",
        );
      } else if (msg.id !== undefined) {
        // unknown method with id — respond empty
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {},
          }) + "\n",
        );
      }
    } catch {
      // ignore parse errors
    }
  });

  rl.on("close", () => process.exit(0));
}

main();
