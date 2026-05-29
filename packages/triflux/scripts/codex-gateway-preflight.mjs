#!/usr/bin/env node
// scripts/codex-gateway-preflight.mjs — Codex MCP 초기화 시 gateway 자동 기동
// Codex config.toml에 MCP 서버로 등록되면, Codex 시작 시 이 스크립트가 먼저 실행되어
// gateway가 alive인지 확인하고 죽었으면 기동한다.
// 실제 MCP 기능은 없음 (no-op). 역할은 gateway 보장뿐.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVERS,
  serversWithSatisfiedEnv,
} from "./lib/mcp-gateway-servers.mjs";
import { readManifest, writeManifest } from "./lib/mcp-manifest.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE_TIMEOUT_MS = 2000;
const STARTUP_WAIT_MS = 6000;
const POLL_MS = 500;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분
const CACHE_FILE = join(tmpdir(), "tfx-gateway-alive.json");

function ensureGatewayManifest() {
  const manifest = readManifest();
  if (manifest) return manifest;

  const envReadyServers = serversWithSatisfiedEnv()
    .filter((server) => server.envVars.length > 0)
    .map((server) => server.name);
  return writeManifest(envReadyServers);
}

function configuredServers(manifest) {
  const enabled = new Set(manifest?.enabled || []);
  return SERVERS.filter((server) => {
    if (!enabled.has(server.name)) return false;
    return server.envVars.every((envName) => Boolean(process.env[envName]));
  });
}

function configuredPorts(servers) {
  return servers.map((server) => server.port).sort((a, b) => a - b);
}

function samePorts(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((port, index) => port === right[index]);
}

function readCache(servers) {
  const ports = configuredPorts(servers);
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (Date.now() - data.ts >= CACHE_TTL_MS) return null;
    return samePorts(data.ports, ports) ? data : null;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache(servers) {
  try {
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({
        ts: Date.now(),
        alive: true,
        ports: configuredPorts(servers),
      }),
    );
  } catch {
    /* ignore */
  }
}

async function isPortHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function gatewayReadiness(servers, { useCache = true } = {}) {
  if (servers.length === 0) return { ready: true, entries: [] };

  // B) Preflight 캐시: 5분 이내 같은 configured port set을 확인했으면 프로브 스킵
  if (useCache && readCache(servers)) return { ready: true, entries: [] };

  const entries = await Promise.all(
    servers.map(async (server) => ({
      name: server.name,
      port: server.port,
      healthy: await isPortHealthy(server.port),
    })),
  );
  const ready = entries.every((entry) => entry.healthy);
  if (ready) writeCache(servers);
  return { ready, entries };
}

async function startGateway(servers) {
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
    if ((await gatewayReadiness(servers, { useCache: false })).ready) {
      return true;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

// ── MCP stdio 프로토콜 (no-op server) ──

async function main() {
  // 1) gateway 보장
  const manifest = ensureGatewayManifest();
  const servers = configuredServers(manifest);
  const readiness = await gatewayReadiness(servers);
  if (!readiness.ready) {
    const downPorts = readiness.entries
      .filter((entry) => !entry.healthy)
      .map((entry) => `${entry.name}:${entry.port}`)
      .join(", ");
    process.stderr.write(
      `[gateway-preflight] gateway down (${downPorts}), starting...\n`,
    );
    const ok = await startGateway(servers);
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
