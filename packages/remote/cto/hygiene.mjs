import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeLiveSession,
  readJsonLines,
  readSynapseSnapshot,
  resolveLakeRootDir,
} from "./lake-root.mjs";

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

async function readLiveOverlay(opts = {}) {
  if (opts.overlay) return normalizeOverlay(opts.overlay);
  try {
    const reader = opts.synapseReader || readSynapseSnapshot;
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
  if (typeof ref?.artifact_path === "string" && ref.artifact_path.trim()) {
    row.artifact_path = ref.artifact_path.trim();
  }
  if (
    typeof ref?.project_root_hash === "string" &&
    ref.project_root_hash.trim()
  ) {
    row.project_root_hash = ref.project_root_hash.trim();
  }
  if (typeof ref?.session_id === "string" && ref.session_id.trim()) {
    row.session_id = ref.session_id.trim();
  }
  return row;
}

function rowKey(kind, id) {
  return `${kind}:${id}`;
}

function hygieneKeyForRow(row) {
  return rowKey(row.kind, row.id);
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

function countsFromRows(rows) {
  const counts = emptyCounts();
  for (const row of rows) {
    if (row.kind === "task") {
      if (row.status === "completed") counts.completed_tasks += 1;
      else counts.active_tasks += 1;
    } else if (row.kind === "session" && row.status === "stale") {
      counts.stale_sessions += 1;
    } else if (row.kind === "worktree" && row.status === "orphaned") {
      counts.orphan_worktrees += 1;
    } else if (row.kind === "checkpoint" && row.status === "superseded") {
      counts.superseded_checkpoints += 1;
    }
  }
  counts.unknown_owner = rows.filter((row) => row.owner === "unknown").length;
  return counts;
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
  const appliedByKey = new Map();

  for (const entry of events) {
    const ref = eventRef(entry);
    switch (entry?.event) {
      case "hygiene_applied": {
        const key =
          typeof ref.hygiene_key === "string" && ref.hygiene_key.trim()
            ? ref.hygiene_key.trim()
            : null;
        if (!key) break;
        upsertLatest(appliedByKey, key, { entry, ref });
        break;
      }
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

  for (const [taskId, item] of tasks) {
    const completed = item.entry?.event === "task_completed";
    const status = statusOf(item.ref, completed ? "completed" : "active");
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

  const sortedRows = rows
    .filter((row) => {
      const applied = appliedByKey.get(hygieneKeyForRow(row));
      if (!applied) return true;
      return eventTime(applied.entry) < String(row.last_event_at || "");
    })
    .map((row) => {
      if (row.owner === undefined) {
        const { owner: _owner, ...rest } = row;
        return rest;
      }
      return row;
    });
  const counts = countsFromRows(sortedRows);

  return {
    schema_version: "cto-hygiene.v1",
    dry_run: true,
    counts,
    rows: sortedRows,
  };
}

export async function runHygiene(args = [], opts = {}) {
  if (args.some((arg) => !["--dry-run", "--json"].includes(arg))) {
    throw new Error("tfx cto hygiene supports only --dry-run and --json");
  }
  if (opts.dryRun !== true && !hasFlag(args, "--dry-run")) {
    throw new Error("tfx cto hygiene requires --dry-run");
  }
  const rootDir = opts.rootDir || resolveLakeRootDir(process.cwd());
  const lakeRoot = opts.lakeRoot || join(rootDir, ".triflux", "lake");
  const stdout = opts.stdout || process.stdout;
  const currentPath = join(lakeRoot, "current.json");
  const current = existsSync(currentPath) ? readJson(currentPath) : {};
  const ledger = readJsonLines(join(lakeRoot, "ledger.jsonl"));
  const overlay = await readLiveOverlay({ ...opts, rootDir, lakeRoot });
  const projection = projectCtoHygiene({
    current,
    ledger: ledger.length ? ledger : null,
    overlay,
  });
  if (opts.json === true || hasFlag(args, "--json"))
    writeJson(stdout, projection);
  else
    stdout.write(
      `cto hygiene dry-run: ${projection.counts.active_tasks} active tasks, ${projection.counts.stale_sessions} stale sessions, ${projection.counts.orphan_worktrees} orphan worktrees\n`,
    );
  return projection;
}
