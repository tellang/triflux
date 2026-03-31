import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_STATUS_URL = "http://127.0.0.1:27888/status";
const _sab = new Int32Array(new SharedArrayBuffer(4));

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_PKG_ROOT = join(dirname(__filename), "..", "..");

function sleepSync(ms) {
  Atomics.wait(_sab, 0, 0, ms);
}

function fetchHubStatus({
  execSyncFn = execSync,
  statusUrl = DEFAULT_STATUS_URL,
  timeout = 3000,
} = {}) {
  const response = execSyncFn(`curl -sf ${statusUrl}`, {
    timeout,
    encoding: "utf8",
    windowsHide: true,
  });
  const data = JSON.parse(response);
  return {
    ok: true,
    state: data?.hub?.state || "unknown",
    pid: data?.pid,
  };
}

export function checkCli(name, { execSyncFn = execSync } = {}) {
  const command = process.platform === "win32"
    ? `where ${name} 2>nul`
    : `which ${name} 2>/dev/null`;
  try {
    const path = execSyncFn(command, {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    }).trim();
    return { ok: !!path, path };
  } catch {
    return { ok: false };
  }
}

export function detectCodexPlan({
  homeDir = homedir(),
  existsSyncFn = existsSync,
  readFileSyncFn = readFileSync,
} = {}) {
  try {
    const authPath = join(homeDir, ".codex", "auth.json");
    if (!existsSyncFn(authPath)) return { plan: "unknown", source: "no_auth" };

    const auth = JSON.parse(readFileSyncFn(authPath, "utf8"));
    if (auth.auth_mode !== "chatgpt") return { plan: "api", source: "api_key" };

    const token = auth.tokens?.id_token || auth.tokens?.access_token;
    if (!token) return { plan: "unknown", source: "no_token" };

    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const plan = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type || "unknown";
    return { plan, source: "jwt" };
  } catch {
    return { plan: "unknown", source: "error" };
  }
}

export function checkHub({
  pkgRoot = DEFAULT_PKG_ROOT,
  statusUrl = DEFAULT_STATUS_URL,
  restart = true,
  requestTimeoutMs = 3000,
  pollAttempts = 8,
  pollIntervalMs = 500,
  execSyncFn = execSync,
  spawnFn = spawn,
  existsSyncFn = existsSync,
  sleepSyncFn = sleepSync,
} = {}) {
  try {
    return fetchHubStatus({
      execSyncFn,
      statusUrl,
      timeout: requestTimeoutMs,
    });
  } catch {}

  if (!restart) return { ok: false, state: "unreachable", restart: "disabled" };

  const serverPath = join(pkgRoot, "hub", "server.mjs");
  if (!existsSyncFn(serverPath)) return { ok: false, state: "unreachable", restart: "no_server" };

  try {
    const child = spawnFn(process.execPath, [serverPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    return { ok: false, state: "unreachable", restart: "spawn_failed" };
  }

  for (let i = 0; i < pollAttempts; i++) {
    sleepSyncFn(pollIntervalMs);
    try {
      const status = fetchHubStatus({
        execSyncFn,
        statusUrl,
        timeout: Math.min(requestTimeoutMs, 1000),
      });
      if (status.state === "healthy") {
        return { ...status, restarted: true };
      }
    } catch {}
  }

  return { ok: false, state: "unreachable", restart: "timeout" };
}

export {
  DEFAULT_PKG_ROOT,
  DEFAULT_STATUS_URL,
};
