// hub/team/cli-team-common.mjs — team CLI 공통 상태/Hub 유틸
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import {
  resolveAttachCommand,
  sessionExists,
  getSessionAttachedCount,
  hasWindowsTerminal,
  hasWindowsTerminalSession,
} from "./session.mjs";
import { AMBER, GREEN, RED, GRAY, DIM, BOLD, RESET, WHITE, YELLOW } from "./shared.mjs";

export { AMBER, GREEN, RED, GRAY, DIM, BOLD, RESET, WHITE, YELLOW };

export const PKG_ROOT = dirname(dirname(dirname(new URL(import.meta.url).pathname))).replace(/^\/([A-Z]:)/, "$1");
export const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
export const TEAM_PROFILE = (() => {
  const raw = String(process.env.TFX_TEAM_PROFILE || "team").trim().toLowerCase();
  return raw === "codex-team" ? "codex-team" : "team";
})();
const TEAM_STATE_FILE = join(
  HUB_PID_DIR,
  TEAM_PROFILE === "codex-team" ? "team-state-codex-team.json" : "team-state.json",
);

export const TEAM_SUBCOMMANDS = new Set([
  "status", "attach", "stop", "kill", "send", "list", "help", "tasks", "task", "focus", "interrupt", "control", "debug",
]);

export function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
export function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
export function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }

export function loadTeamState() {
  try {
    return JSON.parse(readFileSync(TEAM_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveTeamState(state) {
  mkdirSync(HUB_PID_DIR, { recursive: true });
  const nextState = { ...state, profile: TEAM_PROFILE };
  writeFileSync(TEAM_STATE_FILE, JSON.stringify(nextState, null, 2) + "\n");
}

export function clearTeamState() {
  try { unlinkSync(TEAM_STATE_FILE); } catch {}
}

function formatHostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function buildHubBaseUrl(host, port) {
  return `http://${formatHostForUrl(host)}:${port}`;
}

function getDefaultHubPort() {
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
      const port = Number(raw.port) || 27888;
      const status = await probeHubStatus(host, port, 1200);
      if (!status) {
        return {
          ...raw,
          pid,
          host,
          port,
          url: `${buildHubBaseUrl(host, port)}/mcp`,
          degraded: true,
        };
      }
      return {
        ...raw,
        pid,
        host,
        port,
        url: `${buildHubBaseUrl(host, port)}/mcp`,
      };
    } catch {
      try { unlinkSync(HUB_PID_FILE); } catch {}
    }
  }

  const candidates = Array.from(new Set([probePort, 27888]));
  for (const portCandidate of candidates) {
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
        writeFileSync(HUB_PID_FILE, JSON.stringify({
          pid: recovered.pid,
          port: recovered.port,
          host: recovered.host,
          url: recovered.url,
          started: Date.now(),
        }));
      } catch {}
    }
    return recovered;
  }
  return null;
}

export async function startHubDaemon() {
  const serverPath = join(PKG_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) {
    fail("hub/server.mjs 없음 — hub 모듈이 설치되지 않음");
    return null;
  }

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env },
    stdio: "ignore",
    detached: true,
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
    await new Promise((r) => setTimeout(r, 100));
  }

  return null;
}

export function isNativeMode(state) {
  return state?.teammateMode === "in-process" && !!state?.native?.controlUrl;
}

export function isWtMode(state) {
  return state?.teammateMode === "wt";
}

export function isTeamAlive(state) {
  if (!state) return false;
  if (isNativeMode(state)) {
    try {
      process.kill(state.native.supervisorPid, 0);
      return true;
    } catch {
      return false;
    }
  }
  if (isWtMode(state)) {
    if (!hasWindowsTerminal()) return false;
    if (hasWindowsTerminalSession()) return true;
    return Array.isArray(state.members) && state.members.length > 0;
  }
  return sessionExists(state.sessionName);
}

export async function nativeRequest(state, path, body = {}) {
  if (!isNativeMode(state)) return null;
  try {
    const res = await fetch(`${state.native.controlUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return null;
  }
}

export async function nativeGetStatus(state) {
  if (!isNativeMode(state)) return null;
  try {
    const res = await fetch(`${state.native.controlUrl}/status`);
    return await res.json();
  } catch {
    return null;
  }
}

export async function launchAttachInWindowsTerminal(sessionName) {
  if (!hasWindowsTerminal()) return false;

  let attachSpec;
  try {
    attachSpec = resolveAttachCommand(sessionName);
  } catch {
    return false;
  }

  const launch = (args) => {
    const child = spawn("wt", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  };

  const beforeAttached = getSessionAttachedCount(sessionName);

  try {
    launch(["-w", "0", "split-pane", "-V", "-d", PKG_ROOT, attachSpec.command, ...attachSpec.args]);
    if (beforeAttached == null) {
      return true;
    }

    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      const nowAttached = getSessionAttachedCount(sessionName);
      if (typeof nowAttached === "number" && nowAttached > beforeAttached) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function buildManualAttachCommand(sessionName) {
  try {
    const spec = resolveAttachCommand(sessionName);
    const quoted = [spec.command, ...spec.args].map((s) => {
      const v = String(s);
      return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
    });
    return quoted.join(" ");
  } catch {
    return `tmux attach-session -t ${sessionName}`;
  }
}

export function wantsWtAttachFallback() {
  return process.argv.includes("--wt")
    || process.argv.includes("--spawn-wt")
    || process.env.TFX_ATTACH_WT_AUTO === "1";
}

export function resolveMember(state, selector) {
  const members = state?.members || [];
  if (!selector) return null;

  const direct = members.find((m) => m.name === selector || m.role === selector || m.agentId === selector);
  if (direct) return direct;

  const workerAlias = /^worker-(\d+)$/i.exec(selector);
  if (workerAlias) {
    const workerIdx = parseInt(workerAlias[1], 10) - 1;
    const workers = members.filter((m) => m.role === "worker");
    if (workerIdx >= 0 && workerIdx < workers.length) return workers[workerIdx];
  }

  const n = parseInt(selector, 10);
  if (!Number.isNaN(n)) {
    const byPane = members.find((m) => m.pane?.endsWith(`.${n}`) || m.pane?.endsWith(`:${n}`));
    if (byPane) return byPane;
    if (n >= 1 && n <= members.length) return members[n - 1];
  }

  return null;
}

export async function publishLeadControl(state, targetMember, command, reason = "") {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
  const leadAgent = (state?.members || []).find((m) => m.role === "lead")?.agentId || "lead";

  const payload = {
    from_agent: leadAgent,
    to_agent: targetMember.agentId,
    command,
    reason,
    payload: {
      issued_by: leadAgent,
      issued_at: Date.now(),
    },
  };

  try {
    const res = await fetch(`${hubBase}/bridge/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return !!res.ok;
  } catch {
    return false;
  }
}
