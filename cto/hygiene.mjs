import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveLakeRootDir } from "./lake-root.mjs";

const COUNT_KEYS = [
  "active_tasks",
  "completed_tasks",
  "stale_sessions",
  "orphan_worktrees",
  "superseded_checkpoints",
  "unknown_owner",
];

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function firstExisting(paths) {
  return paths.filter(Boolean).find((path) => existsSync(path)) || null;
}

function toIsoTime(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function normalizeLiveSession(session) {
  return {
    sessionId: String(session?.sessionId || session?.session_id || ""),
    phase:
      typeof session?.phase === "string"
        ? session.phase
        : typeof session?.status === "string"
          ? session.status
          : "active",
    agent_id:
      typeof session?.agent_id === "string"
        ? session.agent_id
        : typeof session?.agentId === "string"
          ? session.agentId
          : null,
    started_at: toIsoTime(
      session?.started_at ?? session?.startedAt ?? session?.lastHeartbeat,
    ),
  };
}

function normalizeOverlay(value) {
  const sessions = Array.isArray(value)
    ? value
    : Array.isArray(value?.sessions)
      ? value.sessions
      : Array.isArray(value?.live_sessions)
        ? value.live_sessions
        : [];
  return {
    live_sessions: sessions
      .map(normalizeLiveSession)
      .filter((session) => session.sessionId),
  };
}

async function readSynapseWithRegistry(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const persistPath = firstExisting([
    opts.synapsePersistPath,
    join(rootDir, ".triflux", "synapse-registry.json"),
    join(rootDir, ".triflux", "synapse", "registry.json"),
    join(homedir(), ".claude", "cache", "tfx-hub", "synapse-sessions.json"),
    join(homedir(), ".claude", "cache", "tfx-hub", "synapse-registry.json"),
  ]);
  if (!persistPath) return { live_sessions: [] };

  const { createSynapseRegistry } = await import(
    "../hub/team/synapse-registry.mjs"
  );
  const registry = createSynapseRegistry({ persistPath });
  return normalizeOverlay(registry.getActive());
}

async function readLiveOverlay(opts = {}) {
  if (opts.overlay) return normalizeOverlay(opts.overlay);
  try {
    const reader = opts.synapseReader || readSynapseWithRegistry;
    return normalizeOverlay(
      await reader({
        rootDir: opts.rootDir,
        lakeRoot: opts.lakeRoot,
        synapsePersistPath: opts.synapsePersistPath,
      }),
    );
  } catch {
    return { live_sessions: [] };
  }
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function eventTime(entry) {
  return typeof entry?.ts === "string" ? entry.ts : "";
}

function eventRef(entry) {
  return entry?.ref &&
    typeof entry.ref === "object" &&
    !Array.isArray(entry.ref)
    ? entry.ref
    : {};
}

function hasKnownOwner(ref) {
  const actor = ref?.actor;
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    for (const key of ["cli", "session_id", "agent_id", "host"]) {
      if (typeof actor[key] === "string" && actor[key].trim()) return true;
    }
  }
  for (const key of ["owner", "owner_id", "agent_id"]) {
    if (typeof ref?.[key] === "string" && ref[key].trim()) return true;
  }
  return false;
}

function statusOf(ref, fallback) {
  return typeof ref?.status === "string" && ref.status.trim()
    ? ref.status.trim()
    : fallback;
}

function rowFrom(kind, id, status, entry, ref, action) {
  const row = {
    kind,
    id,
    status,
    last_event_at: eventTime(entry) || null,
  };
  if (entry?.summary) row.summary = String(entry.summary);
  if (action) row.action = action;
  if (action && !hasKnownOwner(ref)) row.owner = "unknown";
  return row;
}

function upsertLatest(map, key, value) {
  const existing = map.get(key);
  if (!existing || eventTime(value.entry) >= eventTime(existing.entry)) {
    map.set(key, value);
  }
}

function emptyCounts() {
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
}

export function compactHygieneCounts(projection) {
  const counts = projection?.counts || {};
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, counts[key] || 0]));
}

export function projectCtoHygiene({
  current = {},
  ledger = null,
  overlay = {},
} = {}) {
  const events = Array.isArray(ledger)
    ? ledger
    : Array.isArray(current?.ledger_tail)
      ? current.ledger_tail
      : [];
  const tasks = new Map();
  const staleSessions = new Map();
  const worktrees = new Map();
  const checkpointsBySession = new Map();
  const explicitSupersededCheckpoints = new Map();

  for (const entry of events) {
    const ref = eventRef(entry);
    switch (entry?.event) {
      case "task_claimed":
      case "task_completed": {
        const taskId = typeof ref.task_id === "string" ? ref.task_id : null;
        if (!taskId) break;
        upsertLatest(tasks, taskId, { entry, ref });
        break;
      }
      case "session_stale": {
        const sessionId =
          typeof ref.session_id === "string" ? ref.session_id : null;
        if (!sessionId) break;
        upsertLatest(staleSessions, sessionId, { entry, ref });
        break;
      }
      case "worktree_created":
      case "worktree_removed": {
        const key =
          (typeof ref.worktree_path_hash === "string" &&
            ref.worktree_path_hash) ||
          (typeof ref.worktree_label === "string" && ref.worktree_label) ||
          null;
        if (!key) break;
        upsertLatest(worktrees, key, { entry, ref });
        break;
      }
      case "checkpoint_saved":
      case "checkpoint_restored": {
        const checkpointId =
          typeof ref.checkpoint_id === "string" ? ref.checkpoint_id : null;
        if (!checkpointId) break;
        if (ref.status === "superseded") {
          upsertLatest(explicitSupersededCheckpoints, checkpointId, {
            entry,
            ref,
          });
        }
        const sessionId =
          (typeof ref.session_id === "string" && ref.session_id) ||
          (typeof ref.restored_from_session_id === "string" &&
            ref.restored_from_session_id) ||
          null;
        if (!sessionId) break;
        if (!checkpointsBySession.has(sessionId))
          checkpointsBySession.set(sessionId, []);
        checkpointsBySession.get(sessionId).push({ entry, ref, checkpointId });
        break;
      }
      default:
        break;
    }
  }

  const rows = [];
  const counts = emptyCounts();

  for (const [taskId, item] of tasks) {
    const completed = item.entry?.event === "task_completed";
    const status = statusOf(item.ref, completed ? "completed" : "active");
    counts[
      completed || status === "completed" ? "completed_tasks" : "active_tasks"
    ] += 1;
    rows.push(
      rowFrom(
        "task",
        taskId,
        completed || status === "completed" ? "completed" : status,
        item.entry,
        item.ref,
        completed || status === "completed"
          ? null
          : "complete_or_reassign_task",
      ),
    );
  }

  for (const [sessionId, item] of staleSessions) {
    counts.stale_sessions += 1;
    rows.push(
      rowFrom(
        "session",
        sessionId,
        "stale",
        item.entry,
        item.ref,
        "archive_or_resume_session",
      ),
    );
  }

  for (const session of overlay?.live_sessions || []) {
    const phase = String(session?.phase || session?.status || "").toLowerCase();
    if (phase !== "stale") continue;
    const sessionId = String(
      session?.sessionId || session?.session_id || "",
    ).trim();
    if (!sessionId || staleSessions.has(sessionId)) continue;
    counts.stale_sessions += 1;
    rows.push({
      kind: "session",
      id: sessionId,
      status: "stale",
      last_event_at: session?.started_at || null,
      action: "archive_or_resume_session",
      owner: session?.agent_id ? undefined : "unknown",
    });
  }

  for (const [key, item] of worktrees) {
    if (item.entry?.event === "worktree_removed") continue;
    const status = statusOf(item.ref, "active");
    if (status !== "orphaned") continue;
    counts.orphan_worktrees += 1;
    rows.push(
      rowFrom(
        "worktree",
        item.ref.worktree_label || key,
        "orphaned",
        item.entry,
        item.ref,
        "remove_or_reassign_worktree",
      ),
    );
  }

  const superseded = new Map(explicitSupersededCheckpoints);
  for (const checkpoints of checkpointsBySession.values()) {
    const ordered = [...checkpoints].sort((a, b) =>
      eventTime(a.entry).localeCompare(eventTime(b.entry)),
    );
    for (const item of ordered.slice(0, -1)) {
      if (!superseded.has(item.checkpointId)) {
        superseded.set(item.checkpointId, item);
      }
    }
  }
  for (const [checkpointId, item] of superseded) {
    counts.superseded_checkpoints += 1;
    rows.push(
      rowFrom(
        "checkpoint",
        checkpointId,
        "superseded",
        item.entry,
        item.ref,
        "prune_superseded_checkpoint",
      ),
    );
  }

  const sortedRows = rows.map((row) => {
    if (row.owner === undefined) {
      const { owner: _owner, ...rest } = row;
      return rest;
    }
    return row;
  });
  counts.unknown_owner = sortedRows.filter(
    (row) => row.owner === "unknown",
  ).length;

  return {
    schema_version: "cto-hygiene.v1",
    dry_run: true,
    counts,
    rows: sortedRows,
  };
}

export async function runHygiene(args = [], opts = {}) {
  const rootDir = opts.rootDir || resolveLakeRootDir(process.cwd());
  const lakeRoot = opts.lakeRoot || join(rootDir, ".triflux", "lake");
  const stdout = opts.stdout || process.stdout;
  const jsonOut = opts.json === true || hasFlag(args, "--json");
  const dryRun = opts.dryRun === true || hasFlag(args, "--dry-run");
  if (!dryRun) {
    throw new Error("tfx cto hygiene only supports --dry-run");
  }

  const currentPath = join(lakeRoot, "current.json");
  const current = existsSync(currentPath) ? readJson(currentPath) : {};
  const ledger = readJsonLines(join(lakeRoot, "ledger.jsonl"));
  const overlay = await readLiveOverlay({ ...opts, rootDir, lakeRoot });
  const projection = projectCtoHygiene({
    current,
    ledger: ledger.length > 0 ? ledger : null,
    overlay,
  });

  if (jsonOut) writeJson(stdout, projection);
  else {
    stdout.write(
      `cto hygiene dry-run: ${projection.counts.active_tasks} active tasks, ${projection.counts.stale_sessions} stale sessions, ${projection.counts.orphan_worktrees} orphan worktrees\n`,
    );
  }

  return projection;
}
