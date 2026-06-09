// hub/tray-runtime.mjs — lightweight local CLI runtime detection for tray CTO fallback

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUNTIME_CLIENTS = Object.freeze([
  { id: "claude", label: "Claude", icon: "C", color: "#d19a66" },
  { id: "codex", label: "Codex", icon: "X", color: "#ffffff" },
  { id: "antigravity", label: "Antigravity", icon: "A", color: "#61afef" },
]);
const AGY_CONVERSATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function basename(token = "") {
  return String(token).split(/[\\/]/).pop() || "";
}

function classifyCommand(command = "") {
  const text = String(command).trim();
  if (!text) return null;
  const executable = basename(text.split(/\s+/)[0]);

  if (executable === "claude") {
    if (/\bdaemon\s+run\b/.test(text)) return null;
    return "claude";
  }

  if (executable === "codex") {
    if (/\bapp-server\b/.test(text)) return null;
    return "codex";
  }

  if (/^antigravity(?:-cli)?$/i.test(executable)) return "antigravity";
  return null;
}

function cwdFromMap(cwdByPid, pid) {
  if (!cwdByPid || !Number.isFinite(pid)) return "";
  if (cwdByPid instanceof Map) return String(cwdByPid.get(pid) || "");
  return String(cwdByPid[pid] || cwdByPid[String(pid)] || "");
}

function isGenericProjectsCwd(cwd = "") {
  return /^\/Users\/[^/]+\/Projects\/?$/u.test(String(cwd || "").trim());
}

export function inferProjectRootFromCommand(command = "") {
  const text = String(command || "");
  const match = text.match(
    /model_instructions_file=(?:"([^"]+)"|'([^']+)'|(\S+))/u,
  );
  const filePath = match?.[1] || match?.[2] || match?.[3] || "";
  if (!filePath) return "";
  const marker = filePath.match(/^(.*?)\/\.(?:omx|omc)\/state\/sessions\//u);
  return marker?.[1] || "";
}

function resolveProjectCwd({ command = "", cwd = "", parentCwd = "" } = {}) {
  const inferred = inferProjectRootFromCommand(command);
  if (inferred) return inferred;
  if (cwd && (!isGenericProjectsCwd(cwd) || !parentCwd)) return cwd;
  if (parentCwd) return parentCwd;
  return cwd || "";
}

export function parseLsofCwdOutput(output = "") {
  const cwdByPid = new Map();
  let currentPid = null;
  for (const line of String(output || "").split(/\r?\n/u)) {
    if (line.startsWith("p")) {
      const pid = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(pid) ? pid : null;
      continue;
    }
    if (line.startsWith("n") && currentPid) {
      cwdByPid.set(currentPid, line.slice(1));
    }
  }
  return cwdByPid;
}

export function collectRuntimeProcesses(psOutput = "", options = {}) {
  const cwdByPid = options?.cwdByPid;
  const seen = new Set();
  const processes = [];
  for (const line of String(psOutput).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pidText, ppidText, elapsed, command] = match;
    const client = classifyCommand(command);
    const pid = Number.parseInt(pidText, 10);
    if (!client || !Number.isFinite(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const ppid = Number.parseInt(ppidText, 10) || null;
    const cwd = resolveProjectCwd({
      command,
      cwd: cwdFromMap(cwdByPid, pid),
      parentCwd: cwdFromMap(cwdByPid, ppid),
    });
    processes.push({
      client,
      pid,
      ppid,
      elapsed,
      command: command.trim(),
      ...(cwd ? { cwd } : {}),
    });
  }
  return processes;
}

export function summarizeRuntimeProcesses(processes = []) {
  const safeProcesses = Array.isArray(processes) ? processes : [];
  return {
    total: safeProcesses.length,
    clients: RUNTIME_CLIENTS.map((client) => {
      const count = safeProcesses.filter(
        (process) => process.client === client.id,
      ).length;
      return { ...client, count, status: count > 0 ? "on" : "off" };
    }),
  };
}

function normalizeProjectRoots(projectRoots = []) {
  return (Array.isArray(projectRoots) ? projectRoots : [projectRoots])
    .map((root) => String(root || "").replace(/\/+$/u, ""))
    .filter(Boolean);
}

function isUnderProjectRoots(cwd = "", roots = []) {
  if (roots.length === 0) return true;
  const path = String(cwd || "").replace(/\/+$/u, "");
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function conversationFile(baseDir, conversationId) {
  for (const ext of [".db", ".db-wal", ".db-shm", ".pb"]) {
    const filePath = join(baseDir, "conversations", `${conversationId}${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return "";
}

export function collectAntigravityConversations(options = {}) {
  const baseDir =
    options.baseDir || join(homedir(), ".gemini", "antigravity-cli");
  const projectRoots = normalizeProjectRoots(options.projectRoots || []);
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Number(options.maxAgeMs)
    : AGY_CONVERSATION_MAX_AGE_MS;
  const now = Number.isFinite(Number(options.now))
    ? Number(options.now)
    : Date.now();
  const limit = Number.isFinite(Number(options.limit))
    ? Number(options.limit)
    : 12;
  const cachePath = join(baseDir, "cache", "last_conversations.json");
  if (!existsSync(cachePath)) return [];

  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const rows = Object.entries(cache || {}).flatMap(([cwd, rawId]) => {
      const conversationId = String(rawId || "").trim();
      if (!conversationId || !isUnderProjectRoots(cwd, projectRoots)) return [];
      const filePath = conversationFile(baseDir, conversationId);
      if (!filePath) return [];
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        return [];
      }
      if (maxAgeMs > 0 && now - mtimeMs > maxAgeMs) return [];
      return [
        {
          client: "antigravity",
          sessionId: `antigravity-${conversationId.slice(0, 8)}`,
          conversationId,
          source: "conversation",
          focusable: false,
          pid: null,
          ppid: null,
          elapsed: "",
          command: "agy conversation",
          cwd: String(cwd),
          taskSummary: "AGY conversation",
          mtimeMs,
          phase: "idle",
        },
      ];
    });
    return rows
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.cwd.localeCompare(b.cwd))
      .slice(0, Math.max(0, limit));
  } catch (_error) {
    return [];
  }
}

export function buildRuntimeStatus(psOutput = "", options = {}) {
  const processes = collectRuntimeProcesses(psOutput);
  const conversations = collectAntigravityConversations(options);
  const allProcesses = [...processes, ...conversations];
  return {
    processes: allProcesses,
    summary: summarizeRuntimeProcesses(allProcesses),
  };
}

export function collectCwdByPid(pids = []) {
  const ids = [
    ...new Set(
      pids
        .map((pid) => Number.parseInt(pid, 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0),
    ),
  ];
  if (ids.length === 0) return new Map();
  try {
    const output = execFileSync(
      "lsof",
      ["-a", "-p", ids.join(","), "-d", "cwd", "-Fn"],
      {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 1024 * 1024,
      },
    );
    return parseLsofCwdOutput(output);
  } catch (_error) {
    return new Map();
  }
}

export function getRuntimeStatus(options = {}) {
  try {
    const output = execFileSync("ps", ["-axo", "pid,ppid,etime,command"], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
    const initialProcesses = collectRuntimeProcesses(output);
    const cwdByPid = collectCwdByPid(
      initialProcesses.flatMap((process) => [process.pid, process.ppid]),
    );
    const processes =
      cwdByPid.size > 0
        ? collectRuntimeProcesses(output, { cwdByPid })
        : initialProcesses;
    const conversations = collectAntigravityConversations(options);
    const allProcesses = [...processes, ...conversations];
    return {
      processes: allProcesses,
      summary: summarizeRuntimeProcesses(allProcesses),
    };
  } catch (error) {
    return {
      processes: [],
      summary: summarizeRuntimeProcesses([]),
      error: error?.message || String(error),
    };
  }
}
