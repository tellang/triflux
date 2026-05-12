// hub/team/synapse-cli.mjs — CLI surface for Synapse v1.
// Reads persisted registry state + git log for the "status" and "why" commands.
// Hub integration comes later; for v1 we go straight to the JSON persist files
// so the CLI works even when Hub is offline.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseIntentTrailer } from "./swarm-intent.mjs";

const DEFAULT_REGISTRY_CANDIDATES = [
  ".triflux/synapse-registry.json",
  ".triflux/synapse/registry.json",
  join(homedir(), ".claude", "cache", "tfx-hub", "synapse-registry.json"),
];
const DEFAULT_SWARM_LOGS_DIR = ".triflux/swarm-logs";
const STALE_AFTER_MS = 30 * 60 * 1000;
const STATUS_PRIORITY = {
  active: 3,
  running: 3,
  completed: 2,
  failed: 2,
  stale: 1,
};

function gitExec(args, cwd) {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, timeout: 15_000 },
      (err, stdout) => {
        if (err) rej(err);
        else res(stdout);
      },
    );
  });
}

function locateRegistryPath(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of DEFAULT_REGISTRY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadRegistrySnapshot(path) {
  if (!path) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      // Accept both array-form and object-form persist layouts.
      if (Array.isArray(parsed.sessions)) return parsed.sessions;
      return Object.values(parsed);
    }
    return [];
  } catch {
    return [];
  }
}

function parseJsonLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function normalizeRunId(name) {
  return String(name || "").replace(/^run-/, "");
}

function eventTimeMs(event) {
  const ms = Date.parse(String(event?.ts || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function deriveLogStatus(events, lastHeartbeatMs, nowMs) {
  const stateEvents = events.filter((e) => e.event === "swarm_state");
  const lastState = stateEvents[stateEvents.length - 1]?.to;
  if (lastState === "completed" || lastState === "failed") return lastState;
  if (events.some((e) => e.event === "integration_complete")) {
    const lastIntegration = [...events]
      .reverse()
      .find((e) => e.event === "integration_complete");
    if (
      Array.isArray(lastIntegration?.failed) &&
      lastIntegration.failed.length
    ) {
      return "failed";
    }
    return "completed";
  }
  if (nowMs - lastHeartbeatMs > STALE_AFTER_MS) return "stale";
  return "active";
}

function buildLogSession(runDir, nowMs = Date.now()) {
  const eventPath = join(runDir, "swarm-events.jsonl");
  if (!existsSync(eventPath)) return null;
  const events = parseJsonLines(eventPath);
  if (events.length === 0) return null;

  let statMs = 0;
  try {
    statMs = statSync(eventPath).mtimeMs;
  } catch {}

  const eventMs = events.map(eventTimeMs).filter((ms) => ms > 0);
  const lastEventMs = eventMs.length ? Math.max(...eventMs) : statMs;
  const launched = new Set();
  const completed = new Set();
  const failed = new Set();
  for (const event of events) {
    if (event.event === "shard_launched" && event.shard) {
      launched.add(event.shard);
    } else if (event.event === "shard_completed" && event.shard) {
      completed.add(event.shard);
    } else if (
      (event.event === "shard_failed" ||
        event.event === "shard_launch_failed") &&
      event.shard
    ) {
      failed.add(event.shard);
    }
  }

  const runId = normalizeRunId(runDir.split(/[\\/]/).pop());
  const totalShards = launched.size || completed.size + failed.size;
  const aliveWorkers = [...launched].filter(
    (name) => !completed.has(name) && !failed.has(name),
  ).length;

  return {
    sessionId: runId,
    runId,
    host: "-",
    branch: "-",
    dirtyFiles: [],
    status: deriveLogStatus(events, lastEventMs || nowMs, nowMs),
    taskSummary: "swarm log run",
    source: "logs",
    shards: totalShards ? `${completed.size}/${totalShards}` : "-",
    workers: totalShards ? `${aliveWorkers} alive` : "-",
    lastHeartbeat: lastEventMs || null,
    logDir: runDir,
  };
}

export function loadSwarmLogSessions(logsDir, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const root = logsDir || DEFAULT_SWARM_LOGS_DIR;
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
      .map((entry) => buildLogSession(join(root, entry.name), nowMs))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function statusPriority(status) {
  return STATUS_PRIORITY[status] || 0;
}

function mergeSession(existing, next) {
  const status =
    statusPriority(next.status) > statusPriority(existing.status)
      ? next.status
      : existing.status;
  const source =
    existing.source && next.source && existing.source !== next.source
      ? "synapse + logs"
      : existing.source || next.source || "synapse";
  return {
    ...next,
    ...existing,
    status,
    source,
    shards: next.shards || existing.shards,
    workers: next.workers || existing.workers,
    lastHeartbeat: Math.max(
      Number(existing.lastHeartbeat || 0),
      Number(next.lastHeartbeat || 0),
    ),
    logDir: existing.logDir || next.logDir,
  };
}

export function mergeRegistryAndLogSessions(registrySessions, logSessions) {
  const merged = new Map();
  for (const session of registrySessions) {
    const key = String(session.runId || session.sessionId || "");
    if (!key) continue;
    merged.set(key, {
      ...session,
      source: session.source || "synapse",
      lastHeartbeat: session.lastHeartbeat || null,
    });
  }
  for (const session of logSessions) {
    const key = String(session.runId || session.sessionId || "");
    if (!key) continue;
    const existing = merged.get(key);
    merged.set(key, existing ? mergeSession(existing, session) : session);
  }
  return [...merged.values()].sort((left, right) => {
    const rightTs = Number(right.lastHeartbeat || 0);
    const leftTs = Number(left.lastHeartbeat || 0);
    return rightTs - leftTs;
  });
}

function formatAge(ts, nowMs = Date.now()) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return "-";
  const seconds = Math.max(0, Math.round((nowMs - Number(ts)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function hasSwarmLogFields(sessions) {
  return sessions.some(
    (s) =>
      s.source === "logs" ||
      s.source === "synapse + logs" ||
      s.runId ||
      s.shards ||
      s.workers,
  );
}

function formatSwarmStatus(sessions) {
  const nowMs = Date.now();
  const rows = [];
  rows.push(
    "RUN_ID                 STATUS     SHARDS   WORKERS  LAST_HEARTBEAT  SOURCE",
  );
  rows.push(
    "─────────────────────  ─────────  ───────  ───────  ──────────────  ──────────────",
  );
  for (const s of sessions) {
    const id = String(s.runId || s.sessionId || "?")
      .padEnd(21)
      .slice(0, 21);
    const status = String(s.status || "active")
      .padEnd(9)
      .slice(0, 9);
    const shards = String(s.shards || "-")
      .padEnd(7)
      .slice(0, 7);
    const workers = String(s.workers || "-")
      .padEnd(7)
      .slice(0, 7);
    const heartbeat = formatAge(s.lastHeartbeat, nowMs).padEnd(14).slice(0, 14);
    const source = String(s.source || "synapse").slice(0, 20);
    rows.push(
      `${id}  ${status}  ${shards}  ${workers}  ${heartbeat}  ${source}`,
    );
  }
  return rows.join("\n");
}

function formatStatus(sessions) {
  if (!sessions.length) {
    return "no active sessions (synapse-registry empty)";
  }
  if (hasSwarmLogFields(sessions)) return formatSwarmStatus(sessions);
  const rows = [];
  rows.push("SESSION                HOST    BRANCH    DIRTY   STATE    TASK");
  rows.push(
    "─────────────────────  ──────  ────────  ──────  ───────  ─────────────",
  );
  for (const s of sessions) {
    const id = (s.sessionId || "?").padEnd(21).slice(0, 21);
    const host = (s.host || "?").padEnd(6).slice(0, 6);
    const branch = (s.branch || "?").padEnd(8).slice(0, 8);
    const dirty = String((s.dirtyFiles || []).length)
      .padEnd(6)
      .slice(0, 6);
    const state = (s.status || "active").padEnd(7).slice(0, 7);
    const task = (s.taskSummary || "").slice(0, 40);
    rows.push(`${id}  ${host}  ${branch}  ${dirty}  ${state}  ${task}`);
  }
  return rows.join("\n");
}

/**
 * `tfx synapse status` — list active swarm sessions from persisted registry.
 */
export async function cmdSynapseStatus(args = [], opts = {}) {
  const jsonOut = args.includes("--json") || opts.json;
  const explicit = extractFlag(args, "--registry");
  const explicitLogsDir = extractFlag(args, "--logs-dir");
  const path = locateRegistryPath(explicit);
  const registrySessions = loadRegistrySnapshot(path);
  const logsDir = explicitLogsDir || DEFAULT_SWARM_LOGS_DIR;
  const logSessions = loadSwarmLogSessions(logsDir);
  const sessions = mergeRegistryAndLogSessions(registrySessions, logSessions);

  if (jsonOut) {
    process.stdout.write(
      JSON.stringify(
        {
          registry: path,
          logsDir: existsSync(logsDir) ? logsDir : null,
          count: sessions.length,
          sessions,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (!path && logSessions.length === 0) {
    process.stdout.write(
      "no registry or swarm logs found (looked for .triflux/synapse-registry.json and .triflux/swarm-logs)\n",
    );
    return;
  }
  if (path) process.stdout.write(`registry: ${path}\n`);
  if (logSessions.length > 0) process.stdout.write(`swarm logs: ${logsDir}\n`);
  process.stdout.write(`${formatStatus(sessions)}\n`);
}

function extractFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] || null;
}

async function resolveCommitForPath(path, cwd) {
  try {
    const out = await gitExec(["log", "-1", "--format=%H", "--", path], cwd);
    return out.trim();
  } catch {
    return "";
  }
}

async function readCommitMessage(sha, cwd) {
  try {
    return await gitExec(["log", "-1", "--format=%B", sha], cwd);
  } catch {
    return "";
  }
}

async function readCommitMeta(sha, cwd) {
  try {
    const out = await gitExec(
      ["log", "-1", "--format=%h%x1f%an%x1f%ad%x1f%s", "--date=iso", sha],
      cwd,
    );
    const [short, author, date, subject] = out.trim().split("\x1f");
    return { short, author, date, subject };
  } catch {
    return null;
  }
}

/**
 * `tfx why <path>` — show the X-Intent of the last commit touching <path>.
 */
export async function cmdSynapseWhy(args = [], opts = {}) {
  const jsonOut = args.includes("--json") || opts.json;
  const cwd = process.cwd();
  const positional = args.filter((a) => !a.startsWith("--"));
  const target = positional[0];

  if (!target) {
    const err = { error: "path required", usage: "tfx why <path>" };
    if (jsonOut) process.stdout.write(JSON.stringify(err) + "\n");
    else process.stderr.write("tfx why <path> — path 인자 필요\n");
    process.exitCode = 1;
    return;
  }

  const resolved = resolve(cwd, target);
  if (!existsSync(resolved)) {
    const err = { error: "path not found", path: target };
    if (jsonOut) process.stdout.write(JSON.stringify(err) + "\n");
    else process.stderr.write(`tfx why: 파일 없음: ${target}\n`);
    process.exitCode = 1;
    return;
  }

  const sha = await resolveCommitForPath(target, cwd);
  if (!sha) {
    const result = { path: target, commit: null, intent: null };
    if (jsonOut) process.stdout.write(JSON.stringify(result) + "\n");
    else process.stdout.write(`no commit touches ${target}\n`);
    return;
  }

  const [message, meta] = await Promise.all([
    readCommitMessage(sha, cwd),
    readCommitMeta(sha, cwd),
  ]);
  const intent = parseIntentTrailer(message);

  if (jsonOut) {
    process.stdout.write(
      JSON.stringify(
        { path: target, commit: { sha, ...meta }, intent },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const header = meta
    ? `${meta.short}  ${meta.author}  ${meta.date}  ${meta.subject}`
    : sha;
  process.stdout.write(`${target}\n`);
  process.stdout.write(`  last commit: ${header}\n`);
  if (intent) {
    process.stdout.write(`  intent.scope:      ${intent.scope || "-"}\n`);
    process.stdout.write(`  intent.action:     ${intent.action || "-"}\n`);
    process.stdout.write(`  intent.reason:     ${intent.reason || "-"}\n`);
    if (Array.isArray(intent.touches) && intent.touches.length) {
      process.stdout.write(
        `  intent.touches:    ${intent.touches.join(", ")}\n`,
      );
    }
    if (intent.invariant) {
      process.stdout.write(`  intent.invariant:  ${intent.invariant}\n`);
    }
    if (intent.conflictsWith) {
      process.stdout.write(`  intent.conflicts:  ${intent.conflictsWith}\n`);
    }
  } else {
    process.stdout.write("  intent: (no X-Intent trailer)\n");
  }
}
