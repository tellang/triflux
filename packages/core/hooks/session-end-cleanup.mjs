#!/usr/bin/env node

// hooks/session-end-cleanup.mjs — SessionEnd lifecycle state reporter
//
// Report-only by default. Opt-in cleanup only removes the repo-local
// .triflux/subagents/subagents.json file when stale running lifecycle state is
// present. It never kills processes or touches external HOME/MCP configs.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unregisterSynapseSession } from "../hub/team/synapse-http.mjs";

const MARKER = "[session-end-cleanup]";
const STALE_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024;
const DEFAULT_TMUX_PREFIX = "tfx-*";
const MAX_TMUX_REPORT_SESSIONS = 8;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseJson(raw) {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function timestampMs(agent) {
  const value =
    agent?.startedAt ??
    agent?.started_at ??
    agent?.createdAt ??
    agent?.created_at ??
    agent?.timestamp;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isCompleted(agent) {
  return (
    Boolean(
      agent?.stoppedAt ??
        agent?.stopped_at ??
        agent?.completedAt ??
        agent?.completed_at ??
        agent?.endedAt ??
        agent?.ended_at ??
        agent?.durationMs ??
        agent?.duration_ms ??
        agent?.result,
    ) ||
    agent?.status === "completed" ||
    agent?.status === "stopped"
  );
}

function agentEntries(state) {
  const agents = state?.agents;
  if (Array.isArray(agents)) return agents;
  if (agents && typeof agents === "object") return Object.values(agents);
  return [];
}

function compileSimpleGlob(pattern) {
  const source = String(pattern || DEFAULT_TMUX_PREFIX)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${source}$`);
}

function formatAge(ageSec) {
  if (!Number.isFinite(ageSec) || ageSec < 0) return "unknown";
  if (ageSec < 60) return `${Math.floor(ageSec)}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h`;
  return `${Math.floor(ageSec / 86400)}d`;
}

function parseSessionCreated(rawValue) {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseTmuxListSessions(output, nowSec) {
  const sessions = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const [name, attachedText, createdText] = line.split("\t");
    if (!name) continue;
    const attached = Number.parseInt(attachedText || "0", 10);
    const created = parseSessionCreated(createdText);
    sessions.push({
      name,
      attached: Number.isFinite(attached) ? attached : 0,
      ageSec: created == null ? null : Math.max(0, nowSec - created),
    });
  }
  return sessions;
}

function parseFirstPane(output) {
  const first = String(output || "")
    .split(/\r?\n/)
    .find((line) => line.trim());
  if (!first) return { cwd: null, command: null, pid: null };
  const [cwd, command, pidText] = first.split("\t");
  const pid = Number.parseInt(pidText || "", 10);
  return {
    cwd: cwd || null,
    command: command || null,
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
  };
}

function queryMemoryEstimateMb(pid, execFile = execFileSync) {
  if (!pid) return null;
  try {
    const output = execFile("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 400,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const rssKb = Number.parseInt(String(output || "").trim(), 10);
    if (!Number.isFinite(rssKb) || rssKb < 0) return null;
    return Math.round(rssKb / 1024);
  } catch {
    return null;
  }
}

export function inspectDetachedTmuxSessions({
  prefix = DEFAULT_TMUX_PREFIX,
  now = Date.now(),
  execFile = execFileSync,
  limit = MAX_TMUX_REPORT_SESSIONS,
} = {}) {
  const nowSec = Math.floor(now / 1000);
  const matcher = compileSimpleGlob(prefix);
  let output = "";
  try {
    output = execFile(
      "tmux",
      [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_attached}\t#{session_created}",
      ],
      {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
  } catch {
    return { available: false, prefix, sessions: [] };
  }

  const sessions = [];
  for (const session of parseTmuxListSessions(output, nowSec)) {
    if (session.attached !== 0 || !matcher.test(session.name)) continue;
    let pane = { cwd: null, command: null, pid: null };
    try {
      pane = parseFirstPane(
        execFile(
          "tmux",
          [
            "list-panes",
            "-t",
            session.name,
            "-F",
            "#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}",
          ],
          {
            encoding: "utf8",
            timeout: 500,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          },
        ),
      );
    } catch {
      pane = { cwd: null, command: null, pid: null };
    }
    sessions.push({
      name: session.name,
      age: formatAge(session.ageSec),
      cwd: pane.cwd,
      command: pane.command,
      memory_estimate_mb: queryMemoryEstimateMb(pane.pid, execFile),
    });
    if (sessions.length >= limit) break;
  }

  return { available: true, prefix, sessions };
}

export function summarizeLifecycleState(state, now = Date.now()) {
  const completedEntries = Array.isArray(state?.completed)
    ? state.completed
    : [];
  const summary = {
    running: 0,
    completed: completedEntries.length,
    stale: 0,
    total: completedEntries.length,
  };

  for (const agent of agentEntries(state)) {
    if (!agent || typeof agent !== "object") continue;
    summary.total += 1;

    if (isCompleted(agent)) {
      summary.completed += 1;
      continue;
    }

    const started = timestampMs(agent);
    if (started !== null && now - started >= STALE_MS) {
      summary.stale += 1;
    } else {
      summary.running += 1;
    }
  }

  return summary;
}

function pruneStaleRunningAgents(state, now = Date.now()) {
  const agents = state?.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return { nextState: state, removed: 0 };
  }

  let removed = 0;
  const nextAgents = {};
  for (const [key, agent] of Object.entries(agents)) {
    const started = timestampMs(agent);
    const stale =
      !isCompleted(agent) && started !== null && now - started >= STALE_MS;
    if (stale) {
      removed += 1;
    } else {
      nextAgents[key] = agent;
    }
  }

  return {
    nextState: { ...state, agents: nextAgents },
    removed,
  };
}

function buildContext(summary, cleanup, tmuxReport) {
  let context =
    `${MARKER} subagent lifecycle: ` +
    `running=${summary.running} completed=${summary.completed} ` +
    `stale=${summary.stale} total=${summary.total} cleanup=${cleanup}`;

  if (tmuxReport?.sessions?.length > 0) {
    context += ` detached_tmux_sessions=${JSON.stringify(tmuxReport.sessions)}`;
  }
  return context;
}

function buildOutput(summary, cleanup, tmuxReport) {
  const context = buildContext(summary, cleanup, tmuxReport);
  const output = {
    systemMessage: context,
  };

  let json = JSON.stringify(output);
  if (Buffer.byteLength(json, "utf8") >= MAX_OUTPUT_BYTES) {
    const bounded = buildContext(summary, cleanup, {
      sessions: tmuxReport?.sessions?.slice(0, 2) || [],
    });
    json = JSON.stringify({
      systemMessage: bounded,
    });
  }
  return json;
}

export function run(input, env = process.env) {
  if (input?.hook_event_name !== "SessionEnd") return "";

  // Best-effort Synapse unregister (fire-and-forget). Crash-safe: if this hook
  // never fires, the 5-min interactive TTL eventually marks the row stale, so
  // unregister is an optimization, not a correctness dependency. Never throws,
  // never changes the report-only stdout contract below.
  //
  // Bounded timeout (unref AbortController inside synapse-http) so a stalled hub
  // cannot keep this short-lived SessionEnd hook process alive past its budget.
  try {
    const sessionId = String(input?.session_id || "").trim();
    if (sessionId) unregisterSynapseSession(sessionId, { timeoutMs: 1500 });
  } catch {
    /* swallow — report-only charter preserved */
  }

  const root = env.CLAUDE_CWD || process.cwd();
  const statePath = join(root, ".triflux", "subagents", "subagents.json");
  if (!existsSync(statePath)) return "";

  const state = parseJson(readFileSync(statePath, "utf8"));
  if (!state) return "";

  const summary = summarizeLifecycleState(state);
  let cleanup = "report-only";
  const tmuxReport = inspectDetachedTmuxSessions({
    prefix: env.TFX_SESSION_END_TMUX_PREFIX || DEFAULT_TMUX_PREFIX,
  });

  if (env.TFX_SESSION_END_CLEANUP === "1" && summary.stale > 0) {
    try {
      const { nextState, removed } = pruneStaleRunningAgents(state);
      const remainingAgents = Object.keys(nextState?.agents || {}).length;
      const remainingCompleted = Array.isArray(nextState?.completed)
        ? nextState.completed.length
        : 0;
      if (remainingAgents === 0 && remainingCompleted === 0) {
        unlinkSync(statePath);
        cleanup = "removed";
      } else {
        writeFileSync(
          statePath,
          `${JSON.stringify({ ...nextState, updatedAt: new Date().toISOString() }, null, 2)}\n`,
          "utf8",
        );
        cleanup = `pruned-${removed}`;
      }
    } catch {
      cleanup = "failed";
    }
  }

  return buildOutput(summary, cleanup, tmuxReport);
}

function main() {
  const input = parseJson(readStdin());
  if (!input) return;
  const output = run(input);
  if (output) process.stdout.write(output);
}

try {
  main();
} catch {
  process.exit(0);
}
