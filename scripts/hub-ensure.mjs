#!/usr/bin/env node
// SessionStart 훅에서 호출되는 Hub 보장 스크립트.
// - /status 기반 헬스체크
// - 비정상 시 Hub를 detached로 기동

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HUB_PID_FILE = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");

function formatHostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function buildHubBaseUrl(host, port) {
  return `http://${formatHostForUrl(host)}:${port}`;
}

function resolveHubTarget() {
  const envPortRaw = Number(process.env.TFX_HUB_PORT || "");
  const envPort = Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : null;
  const target = {
    host: "127.0.0.1",
    port: envPort || 27888,
  };

  if (existsSync(HUB_PID_FILE)) {
    try {
      const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
      if (!envPort) {
        const pidPort = Number(info?.port);
        if (Number.isFinite(pidPort) && pidPort > 0) target.port = pidPort;
      }
      if (typeof info?.host === "string") {
        const host = info.host.trim();
        if (LOOPBACK_HOSTS.has(host)) target.host = host;
      }
    } catch {
      // ignore parse errors and use env/default
    }
  }

  return target;
}

async function isHubHealthy(host, port) {
  try {
    const res = await fetch(`${buildHubBaseUrl(host, port)}/status`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.hub?.state === "healthy";
  } catch {
    return false;
  }
}

function startHubDetached(port) {
  const serverPath = join(PLUGIN_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) return;

  try {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, TFX_HUB_PORT: String(port) },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best effort
  }
}

const { host, port } = resolveHubTarget();
if (!(await isHubHealthy(host, port))) {
  startHubDetached(port);
}
