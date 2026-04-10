#!/usr/bin/env node

// SessionStart 훅에서 호출되는 Hub 보장 스크립트.
// - /status 기반 헬스체크
// - 비정상 시 Hub를 detached로 기동

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
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
  const envPort =
    Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : null;
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
    const res = await fetch(`${buildHubBaseUrl(host, port)}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

function startHubDetached(port) {
  const serverPath = join(PLUGIN_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) return false;

  try {
    const env = { ...process.env, TFX_HUB_PORT: String(port) };
    const child = spawn(process.execPath, [serverPath], {
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForHubReady(host, port, maxWaitMs = 5000) {
  const interval = 250;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isHubHealthy(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

export async function run(stdinData) {
  void stdinData;

  const { host, port } = resolveHubTarget();
  if (await isHubHealthy(host, port)) {
    return { code: 0, stdout: "hub: ok", stderr: "" };
  }

  const started = startHubDetached(port);
  if (!started) {
    return { code: 1, stdout: "", stderr: "[hub-ensure] hub 시작 실패" };
  }

  const ready = await waitForHubReady(host, port, 5000);
  return {
    code: ready ? 0 : 2,
    stdout: ready ? "hub: ok" : "hub: starting (timeout)",
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
