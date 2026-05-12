#!/usr/bin/env node
// hooks/subagent-tracker.mjs — SubagentStart/SubagentStop lifecycle tracker
//
// Maintains a small repo-local JSON store of running and recently completed
// subagents so paired lifecycle hooks can add bounded context without blocking.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const STATE_VERSION = 1;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_COMPLETED = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 750;
const LOCK_RETRY_MS = 20;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stateDirFromEnv(env = process.env, cwd = process.cwd()) {
  return (
    env.TRIFLUX_SUBAGENT_STATE_DIR ||
    join(env.CLAUDE_CWD || cwd, ".triflux", "subagents")
  );
}

function emptyState(now = new Date()) {
  return {
    version: STATE_VERSION,
    updatedAt: now.toISOString(),
    agents: {},
    completed: [],
  };
}

function normalizeState(value, now) {
  const state = isObject(value) ? value : {};
  return {
    version: STATE_VERSION,
    updatedAt:
      typeof state.updatedAt === "string" ? state.updatedAt : now.toISOString(),
    agents: isObject(state.agents) ? state.agents : {},
    completed: Array.isArray(state.completed) ? state.completed : [],
  };
}

function readState(path, now) {
  try {
    return normalizeState(JSON.parse(readFileSync(path, "utf8")), now);
  } catch {
    return emptyState(now);
  }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock(statePath, fn, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const lockDir = `${statePath}.lock`;
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir, { recursive: false });
      try {
        return fn();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) return undefined;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function lifecycleKey(input) {
  if (typeof input.agent_id === "string" && input.agent_id.trim()) {
    return input.agent_id;
  }
  if (typeof input.subagent_id === "string" && input.subagent_id.trim()) {
    return input.subagent_id;
  }
  const sessionId =
    typeof input.session_id === "string" && input.session_id.trim()
      ? input.session_id
      : "unknown";
  const agentType =
    (typeof input.agent_type === "string" && input.agent_type.trim()) ||
    (typeof input.subagent_type === "string" && input.subagent_type.trim()) ||
    "unknown";
  return `${sessionId}:${agentType}`;
}

function agentType(input, existing) {
  return (
    (typeof input.agent_type === "string" && input.agent_type.trim()) ||
    (typeof input.subagent_type === "string" && input.subagent_type.trim()) ||
    existing?.agentType ||
    "unknown"
  );
}

function expectedDeliverables(input) {
  if (input.expectedDeliverables !== undefined)
    return input.expectedDeliverables;
  if (input.expected_deliverables !== undefined)
    return input.expected_deliverables;
  if (input.expected_deliverable !== undefined)
    return input.expected_deliverable;
  return undefined;
}

function cleanupStaleAgents(state, nowMs, ttlMs) {
  for (const [key, agent] of Object.entries(state.agents)) {
    const startedMs = Date.parse(agent?.startedAt || "");
    if (!Number.isFinite(startedMs) || nowMs - startedMs > ttlMs) {
      delete state.agents[key];
    }
  }
}

function boundedCompleted(completed) {
  return completed.slice(-MAX_COMPLETED);
}

function completionSummary({ key, input, running, now, durationMs }) {
  const summary = {
    key,
    stoppedAt: now.toISOString(),
    sessionId:
      (typeof input.session_id === "string" && input.session_id.trim()) ||
      running?.sessionId ||
      undefined,
    agentType: agentType(input, running),
    durationMs,
  };
  if (running?.startedAt) summary.startedAt = running.startedAt;
  if (running?.expectedDeliverables !== undefined) {
    summary.expectedDeliverables = running.expectedDeliverables;
  }
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  );
}

function stopOutput({ summary, runningCount, completedCount }) {
  const message =
    `[subagent-tracker] ${summary.agentType} ` +
    `duration=${summary.durationMs}ms ` +
    `running=${runningCount} completed=${completedCount}`;
  return { systemMessage: message };
}

export function recordLifecycle(input, opts = {}) {
  if (!isObject(input)) return undefined;
  const eventName = input.hook_event_name;
  if (eventName !== "SubagentStart" && eventName !== "SubagentStop") {
    return undefined;
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowMs = now.getTime();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const stateDir = opts.stateDir || stateDirFromEnv(opts.env, opts.cwd);
  const statePath = join(stateDir, "subagents.json");
  mkdirSync(stateDir, { recursive: true });
  return withStateLock(
    statePath,
    () => {
      const state = readState(statePath, now);

      cleanupStaleAgents(state, nowMs, ttlMs);

      const key = lifecycleKey(input);
      let output;

      if (eventName === "SubagentStart") {
        const existing = state.agents[key];
        const deliverables = expectedDeliverables(input);
        state.agents[key] = {
          key,
          startedAt: existing?.startedAt || now.toISOString(),
          sessionId:
            (typeof input.session_id === "string" && input.session_id.trim()) ||
            existing?.sessionId ||
            undefined,
          agentType: agentType(input, existing),
          ...(deliverables !== undefined
            ? { expectedDeliverables: deliverables }
            : existing?.expectedDeliverables !== undefined
              ? { expectedDeliverables: existing.expectedDeliverables }
              : {}),
        };
      } else {
        const running = state.agents[key];
        if (running) delete state.agents[key];
        const startedMs = Date.parse(running?.startedAt || "");
        const durationMs = Number.isFinite(startedMs)
          ? Math.max(0, nowMs - startedMs)
          : 0;
        const summary = completionSummary({
          key,
          input,
          running,
          now,
          durationMs,
        });
        state.completed = boundedCompleted([...state.completed, summary]);
        output = stopOutput({
          summary,
          runningCount: Object.keys(state.agents).length,
          completedCount: state.completed.length,
        });
      }

      state.updatedAt = now.toISOString();
      state.completed = boundedCompleted(state.completed);
      writeState(statePath, state);
      return output;
    },
    opts.lockTimeoutMs,
  );
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const output = recordLifecycle(input);
  if (output) process.stdout.write(JSON.stringify(output));
}

try {
  main();
} catch {
  process.exit(0);
}
