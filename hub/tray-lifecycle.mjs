// hub/tray-lifecycle.mjs — Hub/Tray bidirectional auto-start helpers

import { spawn } from "node:child_process";
import { resolveHubPortForContext } from "./hub-lifecycle.mjs";

const DEFAULT_HUB_PORT = "27888";
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_READY_TIMEOUT_MS = 3_000;
const DEFAULT_READY_POLL_MS = 200;

function formatHost(host = "127.0.0.1") {
  return String(host).includes(":") ? `[${host}]` : host;
}

function hubHealthUrl({ host = "127.0.0.1", port = DEFAULT_HUB_PORT } = {}) {
  return `http://${formatHost(host)}:${port}/health`;
}

async function isHubHealthy({
  host = "127.0.0.1",
  port = DEFAULT_HUB_PORT,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
} = {}) {
  if (typeof fetchFn !== "function") return false;
  try {
    const response = await fetchFn(hubHealthUrl({ host, port }), {
      signal:
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
    });
    if (!response?.ok) return false;
    const body =
      typeof response.json === "function" ? await response.json() : {};
    return body?.ok !== false;
  } catch {
    return false;
  }
}

async function waitForHubHealth(options = {}) {
  const deadline =
    Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  do {
    if (await isHubHealthy(options)) return true;
    await new Promise((resolve) =>
      setTimeout(resolve, options.readyPollMs ?? DEFAULT_READY_POLL_MS),
    );
  } while (Date.now() < deadline);
  return false;
}

export async function ensureHubForTray({
  host = "127.0.0.1",
  port,
  serverPath,
  nodePath = process.execPath,
  env = process.env,
  cwd = process.cwd(),
  fetchFn = globalThis.fetch,
  spawnFn = spawn,
  waitForHealth = true,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  readyPollMs = DEFAULT_READY_POLL_MS,
} = {}) {
  const targetPort = String(
    resolveHubPortForContext({
      port,
      env,
      cwd,
      defaultPort: Number(DEFAULT_HUB_PORT),
    }),
  );
  if (await isHubHealthy({ host, port: targetPort, fetchFn })) {
    return { status: "running" };
  }
  if (!serverPath) return { status: "missing-server-path" };

  const child = spawnFn(nodePath, [serverPath], {
    env: {
      ...env,
      TFX_HUB_PORT: targetPort,
      // The tray explicitly started this hub, so the hub must not spawn a
      // second tray back at us.
      TFX_HUB_AUTO_TRAY: "0",
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (typeof child?.unref === "function") child.unref();

  if (waitForHealth) {
    const healthy = await waitForHubHealth({
      host,
      port: targetPort,
      fetchFn,
      readyTimeoutMs,
      readyPollMs,
    });
    return {
      status: healthy ? "started" : "starting",
      pid: child?.pid ?? null,
    };
  }

  return { status: "started", pid: child?.pid ?? null };
}

export function spawnTrayForHub({
  platform = process.platform,
  trayPath,
  nodePath = process.execPath,
  env = process.env,
  spawnFn = spawn,
} = {}) {
  if (env?.TFX_HUB_AUTO_TRAY === "0") return { status: "disabled" };
  if (platform !== "darwin") return { status: "unsupported-platform" };
  if (!trayPath) return { status: "missing-tray-path" };

  const child = spawnFn(nodePath, [trayPath], {
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (typeof child?.unref === "function") child.unref();
  return { status: "started", pid: child?.pid ?? null };
}
