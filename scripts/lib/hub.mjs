import { spawn } from "node:child_process";

export function parseHubPort(hubUrl = "") {
  try {
    const parsed = new URL(hubUrl);
    return parsed.port || "27888";
  } catch {
    return "27888";
  }
}

export async function restartHub({
  hubUrl = process.env.TFX_HUB_URL || "http://127.0.0.1:27888",
  hubServer,
  nodeBin = process.execPath,
  spawnFn = spawn,
  fetchFn = globalThis.fetch,
  sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 8,
} = {}) {
  if (!hubServer) return { ok: false, error: "hub_server_missing" };
  const port = parseHubPort(hubUrl);
  const child = spawnFn(nodeBin, [hubServer], {
    env: { ...process.env, TFX_HUB_PORT: port },
    stdio: "ignore",
    detached: true,
  });
  child.unref?.();

  for (let i = 0; i < attempts; i += 1) {
    await sleepMs(500);
    try {
      const response = await fetchFn(`${hubUrl.replace(/\/$/, "")}/status`);
      if (response?.ok) return { ok: true, pid: child.pid };
    } catch {
      // Keep polling until attempts are exhausted.
    }
  }
  return { ok: false, pid: child.pid };
}

export async function withHubRestart({ action, restart }) {
  const first = await action();
  if (first?.ok) return first;
  const restarted = await restart();
  if (!restarted?.ok) return first;
  return action();
}
