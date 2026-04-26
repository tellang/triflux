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
const HUB_DEFAULT_PORT = 27888;

function formatHostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function buildHubBaseUrl(host, port) {
  return `http://${formatHostForUrl(host)}:${port}`;
}

async function syncHubConfigsIfAvailable({ hubUrl }) {
  try {
    const mod = await import(
      new URL("./sync-hub-mcp-settings.mjs", import.meta.url)
    );
    if (typeof mod?.syncHubMcpSettings === "function") {
      await mod.syncHubMcpSettings({ hubUrl });
    }
    if (typeof mod?.syncCodexHubUrl === "function") {
      await mod.syncCodexHubUrl({ hubUrl });
    }
    if (typeof mod?.syncProjectMcpJson === "function") {
      // 사용자 작업 디렉토리의 .mcp.json 을 sync 대상으로 한다.
      // 이전에는 PLUGIN_ROOT(triflux 설치 경로)를 넘겨서 설치 경로의 .mcp.json
      // 만 sync 되고 사용자 실제 프로젝트는 drift 되던 증상이 있었다.
      await mod.syncProjectMcpJson({ hubUrl, projectRoot: process.cwd() });
    }
  } catch {
    // sync는 best-effort이며 hub-ensure 성공/실패를 좌우하지 않는다.
  }
}

function snapshotUserStateBestEffort() {
  for (const scriptName of [
    "snapshot-codex-state.mjs",
    "snapshot-gemini-state.mjs",
  ]) {
    try {
      const child = spawn(
        process.execPath,
        [join(PLUGIN_ROOT, "scripts", scriptName)],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.unref();
    } catch {
      // snapshots are best-effort and must not affect hub startup
    }
  }
}

export function resolveHubTarget() {
  const envPortRaw = Number(process.env.TFX_HUB_PORT || "");
  const envPort =
    Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : null;
  const target = {
    host: "127.0.0.1",
    port: envPort ?? HUB_DEFAULT_PORT,
  };

  // PID 파일의 port는 source of truth가 아니다. host 힌트만 재사용한다.
  // 과거에는 `!envPort`일 때 PID file의 port로 target.port를 덮었으나,
  // 이는 이전 세션의 오염된 port(비표준 포트)가 cascade로 영속화되는 버그 원인이었다.
  // 포트는 오직 TFX_HUB_PORT env(없으면 HUB_DEFAULT_PORT=27888)만 source of truth다.
  // client config 는 sync-hub-mcp-settings.mjs가 이 hubUrl로 재동기화한다.
  if (existsSync(HUB_PID_FILE)) {
    try {
      const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
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
  const hubUrl = `${buildHubBaseUrl(host, port)}/mcp`;
  if (await isHubHealthy(host, port)) {
    await syncHubConfigsIfAvailable({ hubUrl });
    snapshotUserStateBestEffort();
    return { code: 0, stdout: "hub: ok", stderr: "" };
  }

  const started = startHubDetached(port);
  if (!started) {
    return { code: 1, stdout: "", stderr: "[hub-ensure] hub 시작 실패" };
  }

  const ready = await waitForHubReady(host, port, 5000);
  if (ready) {
    await syncHubConfigsIfAvailable({ hubUrl });
    snapshotUserStateBestEffort();
  }
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
