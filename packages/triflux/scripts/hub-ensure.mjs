#!/usr/bin/env node

// SessionStart 훅에서 호출되는 Hub 보장 스크립트.
// - /status 기반 헬스체크
// - 비정상 시 Hub를 detached로 기동

import { execFileSync, spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { resolveHubPortForContext } from "../hub/hub-lifecycle.mjs";
import { getVersionHash } from "../hub/state.mjs";

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

function parsePort(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatWarning(message) {
  return `[hub-ensure] ${message}\n`;
}

function readHubPidFile(
  pidFilePath = HUB_PID_FILE,
  { exists = existsSync, readFile = readFileSync } = {},
) {
  if (!exists(pidFilePath)) {
    return { exists: false, info: null, error: null };
  }
  try {
    return {
      exists: true,
      info: JSON.parse(readFile(pidFilePath, "utf8")),
      error: null,
    };
  } catch (error) {
    return { exists: true, info: null, error };
  }
}

function isPidAlive(pid, killFn = process.kill) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return false;
  try {
    killFn(resolvedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function getPidCommand(
  pid,
  { platform = process.platform, execFile = execFileSync } = {},
) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return "";

  try {
    if (platform === "win32") {
      return execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${resolvedPid}" | Select-Object -ExpandProperty CommandLine)`,
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      ).trim();
    }

    return execFile("ps", ["-p", String(resolvedPid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

export function isHubServerCommand(command) {
  return /(^|[\\/,\s])hub[\\/]server\.mjs(?=$|[\s"'`])/i.test(
    String(command || ""),
  );
}

function parsePortFromAddress(address) {
  const match = String(address || "").match(/:(\d+)(?:\s|$)/);
  return parsePort(match?.[1]);
}

function parseLsofListeningPorts(output) {
  const ports = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!/\(LISTEN\)/i.test(line)) continue;
    const match = line.match(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/i);
    const port = parsePort(match?.[1]) ?? parsePortFromAddress(line);
    if (port) ports.add(port);
  }
  return [...ports];
}

function findListeningPortsForPid(
  pid,
  { platform = process.platform, execFile = execFileSync } = {},
) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return [];

  try {
    if (platform === "win32") {
      const output = execFile("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const ports = new Set();
      for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [proto, localAddress, , state, pidText] = parts;
        if (proto?.toUpperCase() !== "TCP") continue;
        if (state?.toUpperCase() !== "LISTENING") continue;
        if (Number(pidText) !== resolvedPid) continue;
        const port = parsePortFromAddress(localAddress);
        if (port) ports.add(port);
      }
      return [...ports];
    }

    const output = execFile(
      "lsof",
      ["-nP", "-Pan", "-p", String(resolvedPid), "-iTCP", "-sTCP:LISTEN"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    return parseLsofListeningPorts(output);
  } catch {
    return [];
  }
}

function findListeningPidByPort(
  port,
  { platform = process.platform, execFile = execFileSync } = {},
) {
  const targetPort = parsePort(port);
  if (!targetPort) return null;

  try {
    if (platform === "win32") {
      const output = execFile("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [proto, localAddress, , state, pidText] = parts;
        if (proto?.toUpperCase() !== "TCP") continue;
        if (state?.toUpperCase() !== "LISTENING") continue;
        if (parsePortFromAddress(localAddress) !== targetPort) continue;
        const pid = Number.parseInt(pidText, 10);
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
      return null;
    }

    const output = execFile(
      "lsof",
      ["-nP", "-iTCP:" + targetPort, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const pid = Number.parseInt(output.trim().split(/\r?\n/)[0] ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function fetchHubHealth(
  host,
  port,
  { fetchImpl = fetch, timeoutMs = 1000 } = {},
) {
  try {
    const res = await fetchImpl(`${buildHubBaseUrl(host, port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, version: null };
    const data = await res.json();
    return {
      ok: data?.ok === true,
      version: typeof data?.version === "string" ? data.version : null,
      raw: data,
    };
  } catch (error) {
    return { ok: false, version: null, error };
  }
}

export async function inspectPidFileHub({
  expectedVersion = getVersionHash(),
  pidFilePath = HUB_PID_FILE,
  host = "127.0.0.1",
  exists = existsSync,
  readFile = readFileSync,
  killFn = process.kill,
  platform = process.platform,
  execFile = execFileSync,
  fetchImpl = fetch,
} = {}) {
  const warnings = [];
  const state = readHubPidFile(pidFilePath, { exists, readFile });
  if (!state.exists) {
    return { exists: false, valid: false, warnings, retirePid: null };
  }
  if (state.error) {
    warnings.push(formatWarning(`invalid hub pid file: ${pidFilePath}`));
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: null,
      reason: "invalid_json",
    };
  }

  const pid = Number(state.info?.pid);
  const port = parsePort(state.info?.port);
  const pidHost =
    typeof state.info?.host === "string" && state.info.host.trim()
      ? state.info.host.trim()
      : host;

  if (!Number.isFinite(pid) || pid <= 0) {
    warnings.push(formatWarning("hub pid file has invalid PID"));
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: null,
      reason: "invalid_pid",
    };
  }

  if (!isPidAlive(pid, killFn)) {
    warnings.push(formatWarning(`stale hub pid file: PID ${pid} is not alive`));
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: null,
      pid,
      port,
      reason: "dead_pid",
    };
  }

  const command = getPidCommand(pid, { platform, execFile });
  if (!isHubServerCommand(command)) {
    warnings.push(
      formatWarning(`hub pid file PID ${pid} is not hub/server.mjs`),
    );
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: null,
      pid,
      port,
      command,
      reason: "not_hub_server",
    };
  }

  if (!port) {
    warnings.push(formatWarning(`hub pid file PID ${pid} has no valid port`));
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: pid,
      pid,
      command,
      reason: "invalid_port",
    };
  }

  const listeningPorts = findListeningPortsForPid(pid, { platform, execFile });
  if (!listeningPorts.includes(port)) {
    warnings.push(
      formatWarning(
        `hub pid file mismatch: PID ${pid} is not listening on port ${port}`,
      ),
    );
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: pid,
      pid,
      port,
      command,
      listeningPorts,
      reason: "port_mismatch",
    };
  }

  const health = await fetchHubHealth(pidHost, port, { fetchImpl });
  if (!health.ok) {
    warnings.push(
      formatWarning(`hub pid file PID ${pid} port ${port} is not healthy`),
    );
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: pid,
      pid,
      port,
      command,
      listeningPorts,
      health,
      reason: "unhealthy",
    };
  }

  if (health.version !== expectedVersion) {
    warnings.push(
      formatWarning(
        `hub pid file version mismatch: expected ${expectedVersion}, got ${
          health.version ?? "unknown"
        }`,
      ),
    );
    return {
      exists: true,
      valid: false,
      warnings,
      retirePid: pid,
      pid,
      port,
      command,
      listeningPorts,
      health,
      reason: "version_mismatch",
    };
  }

  return {
    exists: true,
    valid: true,
    warnings,
    retirePid: null,
    pid,
    port,
    command,
    listeningPorts,
    health,
    reason: "ok",
  };
}

async function waitUntilProcessExits(
  pid,
  { killFn = process.kill, graceMs = 5000, pollMs = 100 } = {},
) {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() <= deadline) {
    if (!isPidAlive(pid, killFn)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !isPidAlive(pid, killFn);
}

export async function retireHubProcess(
  pid,
  { killFn = process.kill, graceMs = 5000, pollMs = 100 } = {},
) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) {
    return { ok: false, pid: resolvedPid, reason: "invalid_pid" };
  }
  if (!isPidAlive(resolvedPid, killFn)) {
    return { ok: true, pid: resolvedPid, reason: "already_dead" };
  }

  try {
    killFn(resolvedPid, "SIGTERM");
  } catch (error) {
    return { ok: false, pid: resolvedPid, reason: "sigterm_failed", error };
  }

  if (await waitUntilProcessExits(resolvedPid, { killFn, graceMs, pollMs })) {
    return { ok: true, pid: resolvedPid, reason: "sigterm" };
  }

  try {
    killFn(resolvedPid, "SIGKILL");
  } catch (error) {
    return { ok: false, pid: resolvedPid, reason: "sigkill_failed", error };
  }

  const exited = await waitUntilProcessExits(resolvedPid, {
    killFn,
    graceMs: 1000,
    pollMs,
  });
  return {
    ok: exited,
    pid: resolvedPid,
    reason: exited ? "sigkill" : "still_alive",
  };
}

export async function inspectListeningHub({
  host,
  port,
  expectedVersion = getVersionHash(),
  platform = process.platform,
  execFile = execFileSync,
  fetchImpl = fetch,
} = {}) {
  const warnings = [];
  const health = await fetchHubHealth(host, port, { fetchImpl });
  if (!health.ok) {
    return {
      listening: false,
      valid: false,
      warnings,
      retirePid: null,
      health,
    };
  }

  const ownerPid = findListeningPidByPort(port, { platform, execFile });
  const command = ownerPid
    ? getPidCommand(ownerPid, { platform, execFile })
    : "";
  const ownerIsHub = ownerPid ? isHubServerCommand(command) : false;
  if (health.version === expectedVersion && ownerIsHub) {
    return {
      listening: true,
      valid: true,
      warnings,
      retirePid: null,
      pid: ownerPid,
      command,
      health,
      reason: "ok",
    };
  }

  if (health.version === expectedVersion) {
    warnings.push(
      formatWarning(
        `hub health on ${host}:${port} is not owned by hub/server.mjs (pid=${
          ownerPid ?? "unknown"
        })`,
      ),
    );
    return {
      listening: true,
      valid: false,
      warnings,
      retirePid: null,
      pid: ownerPid,
      command,
      health,
      reason: "not_hub_server",
    };
  }

  warnings.push(
    formatWarning(
      `hub version mismatch on ${host}:${port}: expected ${expectedVersion}, got ${
        health.version ?? "unknown"
      }`,
    ),
  );
  return {
    listening: true,
    valid: false,
    warnings,
    retirePid: ownerIsHub ? ownerPid : null,
    pid: ownerPid,
    command,
    health,
    reason: "version_mismatch",
  };
}

function cleanupPidFileBestEffort(pidFilePath, unlink = unlinkSync) {
  try {
    unlink(pidFilePath);
  } catch {
    // best-effort cleanup
  }
}

function chooseCascadePort(
  startPort,
  {
    maxAttempts = 200,
    platform = process.platform,
    execFile = execFileSync,
  } = {},
) {
  const base = parsePort(startPort) ?? HUB_DEFAULT_PORT;
  for (let offset = 1; offset <= maxAttempts; offset++) {
    const candidate = base + offset;
    if (!findListeningPidByPort(candidate, { platform, execFile })) {
      return candidate;
    }
  }
  return null;
}

export function resolveHubTarget({
  pidFilePath = HUB_PID_FILE,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const target = {
    host: "127.0.0.1",
    port: resolveHubPortForContext({
      env,
      cwd,
      defaultPort: HUB_DEFAULT_PORT,
    }),
  };

  // PID 파일의 port는 source of truth가 아니다. host 힌트만 재사용한다.
  // 과거에는 `!envPort`일 때 PID file의 port로 target.port를 덮었으나,
  // 이는 이전 세션의 오염된 port(비표준 포트)가 cascade로 영속화되는 버그 원인이었다.
  // 포트는 오직 TFX_HUB_PORT env(없으면 HUB_DEFAULT_PORT=27888)만 source of truth다.
  // client config 는 sync-hub-mcp-settings.mjs가 이 hubUrl로 재동기화한다.
  if (existsSync(pidFilePath)) {
    try {
      const info = JSON.parse(readFileSync(pidFilePath, "utf8"));
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

async function isHubHealthy(host, port, expectedVersion, deps = {}) {
  const health = await fetchHubHealth(host, port, deps);
  if (!health.ok) return false;
  return expectedVersion ? health.version === expectedVersion : true;
}

function startHubDetached(port, { spawnFn = spawn } = {}) {
  const serverPath = join(PLUGIN_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) return false;

  try {
    const env = { ...process.env, TFX_HUB_PORT: String(port) };
    const child = spawnFn(process.execPath, [serverPath], {
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

async function waitForHubReady(host, port, maxWaitMs = 5000, expectedVersion) {
  const interval = 250;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isHubHealthy(host, port, expectedVersion)) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

export async function run(stdinData, deps = {}) {
  void stdinData;

  const pidFilePath = deps.pidFilePath ?? HUB_PID_FILE;
  const expectedVersion = deps.expectedVersion ?? getVersionHash();
  const warnings = [];
  const retiredPids = new Set();

  const { host, port } = resolveHubTarget({ pidFilePath });
  const pidInspection = await inspectPidFileHub({
    expectedVersion,
    pidFilePath,
    host,
    exists: deps.exists ?? existsSync,
    readFile: deps.readFile ?? readFileSync,
    killFn: deps.killFn ?? process.kill,
    platform: deps.platform ?? process.platform,
    execFile: deps.execFile ?? execFileSync,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  warnings.push(...pidInspection.warnings);
  if (pidInspection.retirePid) {
    const retired = await retireHubProcess(pidInspection.retirePid, {
      killFn: deps.killFn ?? process.kill,
      graceMs: deps.retireGraceMs ?? 5000,
      pollMs: deps.retirePollMs ?? 100,
    });
    retiredPids.add(pidInspection.retirePid);
    if (retired.ok) {
      warnings.push(
        formatWarning(
          `retired stale hub PID ${pidInspection.retirePid} (${retired.reason})`,
        ),
      );
      cleanupPidFileBestEffort(pidFilePath, deps.unlink ?? unlinkSync);
    } else {
      warnings.push(
        formatWarning(
          `failed to retire stale hub PID ${pidInspection.retirePid} (${retired.reason})`,
        ),
      );
    }
  } else if (
    pidInspection.exists &&
    !pidInspection.valid &&
    ["dead_pid", "invalid_json", "invalid_pid"].includes(pidInspection.reason)
  ) {
    cleanupPidFileBestEffort(pidFilePath, deps.unlink ?? unlinkSync);
  }

  const targetInspection = await inspectListeningHub({
    host,
    port,
    expectedVersion,
    killFn: deps.killFn ?? process.kill,
    platform: deps.platform ?? process.platform,
    execFile: deps.execFile ?? execFileSync,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  warnings.push(...targetInspection.warnings);
  if (targetInspection.valid) {
    const hubUrl = `${buildHubBaseUrl(host, port)}/mcp`;
    if (typeof deps.syncHubConfigs === "function") {
      await deps.syncHubConfigs({ hubUrl });
    } else {
      await syncHubConfigsIfAvailable({ hubUrl });
    }
    if (typeof deps.snapshotUserState === "function") {
      deps.snapshotUserState();
    } else {
      snapshotUserStateBestEffort();
    }
    return { code: 0, stdout: "hub: ok", stderr: warnings.join("") };
  }

  let startPort = port;
  if (
    targetInspection.retirePid &&
    !retiredPids.has(targetInspection.retirePid)
  ) {
    const retired = await retireHubProcess(targetInspection.retirePid, {
      killFn: deps.killFn ?? process.kill,
      graceMs: deps.retireGraceMs ?? 5000,
      pollMs: deps.retirePollMs ?? 100,
    });
    if (retired.ok) {
      warnings.push(
        formatWarning(
          `retired port ${port} hub PID ${targetInspection.retirePid} (${retired.reason})`,
        ),
      );
      cleanupPidFileBestEffort(pidFilePath, deps.unlink ?? unlinkSync);
    } else {
      warnings.push(
        formatWarning(
          `failed to retire port ${port} hub PID ${targetInspection.retirePid} (${retired.reason})`,
        ),
      );
      const cascadePort = chooseCascadePort(port, {
        platform: deps.platform ?? process.platform,
        execFile: deps.execFile ?? execFileSync,
      });
      if (cascadePort) {
        startPort = cascadePort;
        warnings.push(
          formatWarning(
            `falling back to cascade port ${startPort}; default port ${port} remains occupied`,
          ),
        );
      }
    }
  } else if (
    targetInspection.listening &&
    ["version_mismatch", "not_hub_server"].includes(targetInspection.reason)
  ) {
    const cascadePort = chooseCascadePort(port, {
      platform: deps.platform ?? process.platform,
      execFile: deps.execFile ?? execFileSync,
    });
    if (cascadePort) {
      startPort = cascadePort;
      warnings.push(
        formatWarning(
          `unable to identify a retirable hub on port ${port}; falling back to cascade port ${startPort}`,
        ),
      );
    }
  }

  const started =
    typeof deps.startHubDetached === "function"
      ? deps.startHubDetached(startPort)
      : startHubDetached(startPort, { spawnFn: deps.spawnFn ?? spawn });
  if (!started) {
    return {
      code: 1,
      stdout: "",
      stderr: `${warnings.join("")}[hub-ensure] hub 시작 실패`,
    };
  }

  const ready =
    typeof deps.waitForHubReady === "function"
      ? await deps.waitForHubReady(host, startPort, 5000, expectedVersion)
      : await waitForHubReady(host, startPort, 5000, expectedVersion);
  if (ready) {
    const hubUrl = `${buildHubBaseUrl(host, startPort)}/mcp`;
    if (typeof deps.syncHubConfigs === "function") {
      await deps.syncHubConfigs({ hubUrl });
    } else {
      await syncHubConfigsIfAvailable({ hubUrl });
    }
    if (typeof deps.snapshotUserState === "function") {
      deps.snapshotUserState();
    } else {
      snapshotUserStateBestEffort();
    }
  }
  return {
    code: ready ? 0 : 2,
    stdout: ready ? "hub: ok" : "hub: starting (timeout)",
    stderr: warnings.join(""),
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
