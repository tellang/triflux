#!/usr/bin/env node

// mcp-gateway-ensure.mjs — SessionStart 훅에서 supergateway MCP 서비스 보장
// hub-ensure.mjs 패턴을 따름. 가볍게 헬스체크만 수행하고 필요시 기동.

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVERS,
  serversWithSatisfiedEnv,
} from "./lib/mcp-gateway-servers.mjs";
import { readManifest, writeManifest } from "./lib/mcp-manifest.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE_TIMEOUT_MS = 1500;
const STARTUP_WAIT_MS = 4000;
const POLL_INTERVAL_MS = 500;

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

async function gatewayReadiness(servers) {
  const entries = await Promise.all(
    servers.map(async (server) => ({
      name: server.name,
      port: server.port,
      healthy: await isPortHealthy(server.port),
    })),
  );

  return {
    ready: entries.length > 0 && entries.every((entry) => entry.healthy),
    entries,
  };
}

function startGateway() {
  const scriptPath = join(PLUGIN_ROOT, "scripts", "mcp-gateway-start.mjs");
  if (!existsSync(scriptPath)) return false;

  try {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '${scriptPath.replaceAll("'", "''")}'"`,
        { stdio: "ignore", timeout: 10000 },
      );
    } else {
      // POSIX: detached node child + stdio:'ignore' so SessionStart 훅이 block 되지 않음
      const child = spawn(process.execPath, [scriptPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForGatewayReady(servers, maxWaitMs = STARTUP_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if ((await gatewayReadiness(servers)).ready) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

export async function run(stdinData) {
  void stdinData;
  const manifest = ensureGatewayManifest();
  const servers = configuredServers(manifest);

  if (servers.length === 0) {
    return { code: 0, stdout: "gateway: not configured", stderr: "" };
  }

  if ((await gatewayReadiness(servers)).ready) {
    return { code: 0, stdout: "gateway: ok", stderr: "" };
  }

  const started = startGateway();
  if (!started) {
    return { code: 0, stdout: "", stderr: "[gateway-ensure] start failed" };
  }

  const ready = await waitForGatewayReady(servers);
  return {
    code: 0,
    stdout: ready ? "gateway: ok" : "gateway: starting",
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
