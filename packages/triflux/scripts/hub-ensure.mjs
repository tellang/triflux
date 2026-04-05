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
  if (!existsSync(serverPath)) return false;

  try {
    const env = { ...process.env, TFX_HUB_PORT: String(port) };
    if (process.platform === "win32") {
      // Windows: cmd.exe /c start /b → 완전 독립 프로세스 트리 생성
      // hook timeout 시 프로세스 트리 킬에서 살아남음
      const child = spawn("cmd.exe", ["/c", "start", "/b", "", process.execPath, serverPath], {
        env,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else {
      const child = spawn(process.execPath, [serverPath], {
        env,
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

/** Hub 기동 후 ready 상태까지 대기 (최대 maxWaitMs) */
async function waitForHubReady(host, port, maxWaitMs = 5000) {
  const interval = 250;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isHubHealthy(host, port)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

const { host, port } = resolveHubTarget();
if (!(await isHubHealthy(host, port))) {
  const started = startHubDetached(port);
  if (started) {
    const ready = await waitForHubReady(host, port, 3000);
    if (ready) {
      process.stdout.write("hub: ok");
    } else {
      // fire-and-forget: hub이 아직 기동 중일 수 있음 — 에러가 아닌 경고
      process.stdout.write("hub: starting");
    }
  } else {
    process.stderr.write("[hub-ensure] hub 시작 실패");
  }
} else {
  process.stdout.write("hub: ok");
}
