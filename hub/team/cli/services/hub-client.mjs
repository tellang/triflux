import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { publishLeadControl as publishLeadControlBridge } from "../../lead-control.mjs";
import { getTeamStatus as fetchTeamStatus, subscribeToLeadCommands as pullLeadCommands } from "../../session-sync.mjs";
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

/**
 * Hub가 살아있는지 확인하고, 죽어있으면 재시작을 시도한다.
 * exponential backoff: 1초, 2초, 4초
 * 모든 재시작 실패 시 에러를 throw한다 (silent fail 아님).
 * @param {number} [maxRetries=3]
 * @returns {Promise<object>} Hub 정보
 * @throws {Error} 모든 재시작 시도 실패 시
 */
export async function ensureHubAlive(maxRetries = 3) {
  const hub = await getHubInfo();
  if (hub && !hub.degraded) return hub;

  let lastError = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const restarted = await startHubDaemon();
      if (restarted) {
        // 재시작 후 연결 복구 확인
        const recovered = await getHubInfo();
        if (recovered) return recovered;
      }
    } catch (err) {
      lastError = err;
    }
    // 다음 재시도 전 대기: 1초, 2초, 4초 (마지막 시도 후에는 대기 없음)
    if (i < maxRetries - 1) {
      const backoffMs = 2 ** i * 1000; // i=0: 1초, i=1: 2초, i=2: 4초
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  const error = new Error(`Hub 재시작 ${maxRetries}회 모두 실패${lastError ? `: ${lastError.message}` : ""}`);
  error.code = "HUB_RESTART_FAILED";
  error.cause = lastError;
  throw error;
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
  const targetAgent = typeof targetMember === "string" ? targetMember : targetMember?.agentId;

  const result = await publishLeadControlBridge({
    hubUrl: hubBase,
    fromAgent: leadAgent,
    toAgent: targetAgent,
    command,
    reason,
    payload: {
      issued_by: leadAgent,
      issued_at: Date.now(),
    },
  });

  return !!result?.ok;
}

export async function subscribeToLeadCommands(state, member, options = {}) {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
  const fallbackAgentId = (state?.members || []).find((candidate) => candidate.role === "lead")?.agentId || null;
  const agentId = typeof member === "string"
    ? member
    : member?.agentId || options?.agentId || fallbackAgentId;

  return await pullLeadCommands({
    hubUrl: hubBase,
    agentId,
    ...options,
  });
}

export async function getTeamStatus(state, options = {}) {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
  return await fetchTeamStatus({
    hubUrl: hubBase,
    ...options,
  });
}
