import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathLabel, shortHash, toIsoTime } from "./lake-root.mjs";

export const CTO_EVENT_SCHEMA_VERSION = "cto-event.v1";
export const DEFAULT_CTO_EVENT_SOURCE = "tfx_cto_event";

export const CTO_EVENT_TYPES = Object.freeze([
  "collect",
  "session_started",
  "session_heartbeat",
  "session_stale",
  "checkpoint_saved",
  "checkpoint_restored",
  "task_claimed",
  "task_completed",
  "pr_created",
  "pr_merged_or_closed",
  "worktree_created",
  "worktree_removed",
  "hygiene_applied",
]);

export const CTO_HYGIENE_STATUSES = Object.freeze([
  "active",
  "idle",
  "stale",
  "superseded",
  "orphaned",
  "completed",
  "blocked",
  "unknown_owner",
  "hidden",
  "needs_attention",
]);

const EVENT_TYPE_SET = new Set(CTO_EVENT_TYPES);
const STATUS_SET = new Set(CTO_HYGIENE_STATUSES);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeNumericRefs(values) {
  const rawValues = Array.isArray(values)
    ? values
    : values == null
      ? []
      : [values];
  const refs = [];
  for (const value of rawValues) {
    const parsed =
      typeof value === "number" && Number.isInteger(value)
        ? value
        : typeof value === "string"
          ? Number(value.trim().replace(/^#/u, ""))
          : NaN;
    if (Number.isInteger(parsed) && parsed > 0 && !refs.includes(parsed)) {
      refs.push(parsed);
    }
  }
  return refs;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return null;
  const normalized = {};
  for (const key of ["cli", "session_id", "agent_id", "host"]) {
    const value = maybeString(actor[key]);
    if (value) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function putString(target, key, value) {
  const normalized = maybeString(value);
  if (normalized) target[key] = normalized;
}

function defaultSummary(eventType, ref) {
  if (ref.task_id) return `${eventType} ${ref.task_id}`;
  if (ref.checkpoint_id) return `${eventType} ${ref.checkpoint_id}`;
  if (ref.session_id) return `${eventType} ${ref.session_id}`;
  return eventType;
}

export function normalizeCtoEvent(input = {}) {
  const eventType = maybeString(input.event ?? input.event_type);
  if (!eventType || !EVENT_TYPE_SET.has(eventType)) {
    throw new Error(`unknown CTO event: ${eventType || "<empty>"}`);
  }

  const status = maybeString(input.status);
  if (status && !STATUS_SET.has(status)) {
    throw new Error(`invalid CTO status: ${status}`);
  }

  const ts = toIsoTime(input.now ?? input.ts) || new Date().toISOString();
  if (eventType === "collect") {
    return {
      ts,
      event: eventType,
      source: maybeString(input.source) || "tfx_cto_collect",
      summary: maybeString(input.summary) || eventType,
      ref: input.ref ?? null,
    };
  }
  const ref = {
    schema_version: CTO_EVENT_SCHEMA_VERSION,
    event_type: eventType,
  };

  putString(ref, "session_id", input.session_id);
  putString(ref, "parent_session_id", input.parent_session_id);
  putString(ref, "restored_from_session_id", input.restored_from_session_id);
  putString(ref, "checkpoint_id", input.checkpoint_id);
  putString(ref, "artifact_path", input.artifact_path);
  putString(ref, "task_id", input.task_id);
  putString(ref, "branch", input.branch);
  putString(ref, "last_seen_at", input.last_seen_at);
  putString(ref, "stale_reason", input.stale_reason);
  putString(ref, "hygiene_key", input.hygiene_key);
  putString(ref, "hygiene_kind", input.hygiene_kind);
  putString(ref, "hygiene_id", input.hygiene_id);
  putString(ref, "hygiene_action", input.hygiene_action);
  if (status) ref.status = status;

  const projectRoot = maybeString(input.project_root);
  if (projectRoot) {
    ref.project_root_hash = shortHash(projectRoot);
    ref.project_root_label = pathLabel(projectRoot) || basename(projectRoot);
  }

  const worktreePath = maybeString(input.worktree_path ?? input.worktreePath);
  if (worktreePath) {
    ref.worktree_path_hash = shortHash(worktreePath);
    ref.worktree_label = pathLabel(worktreePath) || basename(worktreePath);
  }

  const issueRefs = normalizeNumericRefs(input.issue_refs ?? input.issueRefs);
  if (issueRefs.length > 0) ref.issue_refs = issueRefs;
  const prRefs = normalizeNumericRefs(input.pr_refs ?? input.prRefs);
  if (prRefs.length > 0) ref.pr_refs = prRefs;

  const actor = normalizeActor(input.actor);
  if (actor) ref.actor = actor;

  return {
    ts,
    event: eventType,
    source: maybeString(input.source) || DEFAULT_CTO_EVENT_SOURCE,
    summary: maybeString(input.summary) || defaultSummary(eventType, ref),
    ref,
  };
}

export async function appendCtoEvent(lakeRoot, input, opts = {}) {
  const event = normalizeCtoEvent(input);
  const stderr = opts.stderr || process.stderr;
  const lockRetries = Number.isInteger(opts.lockRetries) ? opts.lockRetries : 3;
  const lockRetryDelayMs = Number.isFinite(opts.lockRetryDelayMs)
    ? opts.lockRetryDelayMs
    : 100;

  mkdirSync(lakeRoot, { recursive: true });
  const ledgerPath = join(lakeRoot, "ledger.jsonl");
  const lockPath = join(lakeRoot, "ledger.jsonl.lock");
  let fd = null;

  for (let attempt = 0; attempt < lockRetries; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt < lockRetries - 1) await sleep(lockRetryDelayMs);
    }
  }

  if (fd === null) {
    stderr.write(
      "[tfx cto] warning: ledger lock timeout; skipped ledger append\n",
    );
    return { appended: false, event };
  }

  try {
    appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, "utf8");
    return { appended: true, event };
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}
