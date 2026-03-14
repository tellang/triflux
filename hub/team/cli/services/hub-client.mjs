import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { HUB_PID_DIR, PKG_ROOT } from "./state-store.mjs";
export { nativeGetStatus } from "./native-control.mjs";

const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function formatHostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

export function buildHubBaseUrl(host, port) {
  return `http://${formatHostForUrl(host)}:${port}`;
}

export function getDefaultHubPort() {
  const envPortRaw = Number(process.env.TFX_HUB_PORT || "27888");
  return Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : 27888;
}

export function getDefaultHubUrl() {
  return `${buildHubBaseUrl("127.0.0.1", getDefaultHubPort())}/mcp`;
}

function normalizeLoopbackHost(host) {
  if (typeof host !== "string") return "127.0.0.1";
  const candidate = host.trim();
  return LOOPBACK_HOSTS.has(candidate) ? candidate : "127.0.0.1";
}

async function probeHubStatus(host, port, timeoutMs = 1500) {
  try {
    const res = await fetch(`${buildHubBaseUrl(host, port)}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.hub ? data : null;
  } catch {
    return null;
  }
}

export async function getHubInfo() {
  const probePort = getDefaultHubPort();

  if (existsSync(HUB_PID_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
      const pid = Number(raw?.pid);
      if (!Number.isFinite(pid) || pid <= 0) throw new Error("invalid pid");
      process.kill(pid, 0);
      const host = normalizeLoopbackHost(raw?.host);
      const port = Number(raw?.port) || 27888;
      const status = await probeHubStatus(host, port, 1200);
      return {
        ...raw,
        pid,
        host,
        port,
        url: `${buildHubBaseUrl(host, port)}/mcp`,
        ...(status ? {} : { degraded: true }),
      };
    } catch {
      try { unlinkSync(HUB_PID_FILE); } catch {}
    }
  }

  for (const portCandidate of Array.from(new Set([probePort, 27888]))) {
    const data = await probeHubStatus("127.0.0.1", portCandidate, 1200);
    if (!data) continue;
    const port = Number(data.port) || portCandidate;
    const pid = Number(data.pid);
    const recovered = {
      pid: Number.isFinite(pid) ? pid : null,
      host: "127.0.0.1",
      port,
      url: `${buildHubBaseUrl("127.0.0.1", port)}/mcp`,
      discovered: true,
    };
    if (Number.isFinite(recovered.pid) && recovered.pid > 0) {
      try {
        mkdirSync(HUB_PID_DIR, { recursive: true });
        writeFileSync(HUB_PID_FILE, JSON.stringify({ ...recovered, started: Date.now() }));
      } catch {}
    }
    return recovered;
  }
  return null;
}

export async function startHubDaemon() {
  const serverPath = join(PKG_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) {
    const error = new Error("hub/server.mjs 없음");
    error.code = "HUB_SERVER_MISSING";
    throw error;
  }

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();

  const expectedPort = getDefaultHubPort();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = await probeHubStatus("127.0.0.1", expectedPort, 500);
    if (status?.hub) {
      return {
        pid: Number(status.pid) || child.pid,
        host: "127.0.0.1",
        port: expectedPort,
        url: `${buildHubBaseUrl("127.0.0.1", expectedPort)}/mcp`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
}

export async function fetchHubTaskList(state) {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
  const teamName = state?.native?.teamName || state?.sessionName || null;
  if (!teamName) return [];

  try {
    const res = await fetch(`${hubBase}/bridge/team/task-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team_name: teamName }),
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    return data?.ok ? (data.data?.tasks || []) : [];
  } catch {
    return [];
  }
}

export async function publishLeadControl(state, targetMember, command, reason = "") {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
  const leadAgent = (state?.members || []).find((member) => member.role === "lead")?.agentId || "lead";

  try {
    const res = await fetch(`${hubBase}/bridge/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: leadAgent,
        to_agent: targetMember.agentId,
        command,
        reason,
        payload: {
          issued_by: leadAgent,
          issued_at: Date.now(),
        },
      }),
    });
    return !!res.ok;
  } catch {
    return false;
  }
}
