#!/usr/bin/env node
// hooks/session-end-cleanup.mjs — SessionEnd lifecycle state reporter
//
// Report-only by default. Opt-in cleanup only removes the repo-local
// .triflux/subagents/subagents.json file when stale running lifecycle state is
// present. It never kills processes or touches external HOME/MCP configs.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "[session-end-cleanup]";
const STALE_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024;

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

function buildOutput(summary, cleanup) {
  const context =
    `${MARKER} subagent lifecycle: ` +
    `running=${summary.running} completed=${summary.completed} ` +
    `stale=${summary.stale} total=${summary.total} cleanup=${cleanup}`;
  const output = {
    systemMessage: context,
    hookSpecificOutput: {
      hookEventName: "SessionEnd",
      additionalContext: context,
    },
  };

  let json = JSON.stringify(output);
  if (Buffer.byteLength(json, "utf8") >= MAX_OUTPUT_BYTES) {
    const bounded = `${MARKER} subagent lifecycle: running=${summary.running} completed=${summary.completed} stale=${summary.stale} cleanup=${cleanup}`;
    json = JSON.stringify({
      systemMessage: bounded,
      hookSpecificOutput: {
        hookEventName: "SessionEnd",
        additionalContext: bounded,
      },
    });
  }
  return json;
}

export function run(input, env = process.env) {
  if (input?.hook_event_name !== "SessionEnd") return "";

  const root = env.CLAUDE_CWD || process.cwd();
  const statePath = join(root, ".triflux", "subagents", "subagents.json");
  if (!existsSync(statePath)) return "";

  const state = parseJson(readFileSync(statePath, "utf8"));
  if (!state) return "";

  const summary = summarizeLifecycleState(state);
  let cleanup = "report-only";

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

  return buildOutput(summary, cleanup);
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
