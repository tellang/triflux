import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { resolveLakeRootDir } from "./lake-root.mjs";

export const CTO_EVENT_SCHEMA_VERSION = "cto-event.v1";
export const DEFAULT_CTO_EVENT_SOURCE = "tfx_cto_event";

export const CTO_EVENT_TYPES = Object.freeze([
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

const EVENT_PRESETS = Object.freeze({
  "context-save": {
    event: "checkpoint_saved",
    source: "gstack_context_save",
    actor: { cli: "gstack context-save" },
    ownerSurface: "gstack context-save -> tfx cto event context-save",
  },
  "checkpoint-saved": {
    event: "checkpoint_saved",
    ownerSurface: "checkpoint wrapper -> tfx cto event checkpoint-saved",
  },
  "context-restore": {
    event: "checkpoint_restored",
    source: "gstack_context_restore",
    actor: { cli: "gstack context-restore" },
    ownerSurface: "gstack context-restore -> tfx cto event context-restore",
  },
  "checkpoint-restored": {
    event: "checkpoint_restored",
    ownerSurface: "checkpoint wrapper -> tfx cto event checkpoint-restored",
  },
  "pr-created": {
    event: "pr_created",
    source: "tfx_pr_lifecycle",
    actor: { cli: "gh pr create" },
    ownerSurface: "gh pr create/merge/close -> tfx cto event pr-created",
  },
  "pr-merged": {
    event: "pr_merged_or_closed",
    source: "tfx_pr_lifecycle",
    status: "completed",
    actor: { cli: "gh pr merge" },
    ownerSurface:
      "gh pr create/merge/close -> tfx cto event pr-merged-or-closed",
  },
  "pr-closed": {
    event: "pr_merged_or_closed",
    source: "tfx_pr_lifecycle",
    status: "completed",
    actor: { cli: "gh pr close" },
    ownerSurface:
      "gh pr create/merge/close -> tfx cto event pr-merged-or-closed",
  },
  "pr-merged-or-closed": {
    event: "pr_merged_or_closed",
    source: "tfx_pr_lifecycle",
    actor: { cli: "gh pr merge/close" },
    ownerSurface:
      "gh pr create/merge/close -> tfx cto event pr-merged-or-closed",
  },
});

const OPTION_KEYS = Object.freeze({
  event: "event",
  "event-type": "event",
  source: "source",
  summary: "summary",
  now: "now",
  ts: "ts",
  status: "status",
  "session-id": "session_id",
  "parent-session-id": "parent_session_id",
  "restored-from-session-id": "restored_from_session_id",
  "checkpoint-id": "checkpoint_id",
  "artifact-path": "artifact_path",
  artifact: "artifact_path",
  "task-id": "task_id",
  branch: "branch",
  "last-seen-at": "last_seen_at",
  "stale-reason": "stale_reason",
  "hygiene-key": "hygiene_key",
  "hygiene-kind": "hygiene_kind",
  "hygiene-id": "hygiene_id",
  "hygiene-action": "hygiene_action",
  "project-root": "project_root",
  "worktree-path": "worktree_path",
  worktree: "worktree_path",
  issue: "issue_refs",
  "issue-ref": "issue_refs",
  "issue-refs": "issue_refs",
  pr: "pr_refs",
  "pr-ref": "pr_refs",
  "pr-refs": "pr_refs",
  "actor-cli": "actor.cli",
  "actor-session-id": "actor.session_id",
  "actor-agent-id": "actor.agent_id",
  "actor-host": "actor.host",
  "owner-surface": "owner_surface",
});

const COLLECTION_KEYS = new Set(["issue_refs", "pr_refs"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toIsoTime(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function shortHash(value) {
  const str = String(value ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function pathLabel(value) {
  const str = String(value ?? "").replace(/[/\\]+$/u, "");
  if (!str) return null;
  const segments = str.split(/[/\\]+/u);
  return segments[segments.length - 1] || null;
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

function optionName(raw) {
  return String(raw || "")
    .replace(/^--?/u, "")
    .trim();
}

function appendCollection(target, key, value) {
  const values = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) return;
  if (!Array.isArray(target[key])) target[key] = [];
  target[key].push(...values);
}

function putPathValue(target, keyPath, value) {
  if (keyPath.startsWith("actor.")) {
    const key = keyPath.slice("actor.".length);
    target.actor ||= {};
    target.actor[key] = value;
    return;
  }
  if (COLLECTION_KEYS.has(keyPath)) {
    appendCollection(target, keyPath, value);
    return;
  }
  target[keyPath] = value;
}

function parseEventArgs(args = []) {
  const fields = {};
  const positional = [];
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg?.startsWith?.("--")) {
      positional.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const rawName = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
    const name = optionName(rawName);
    const mapped = OPTION_KEYS[name];
    if (!mapped) {
      throw new Error(`unknown tfx cto event option: --${name}`);
    }

    let value = eqIndex >= 0 ? arg.slice(eqIndex + 1) : null;
    if (value === null) {
      const next = args[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = "true";
      }
    }
    putPathValue(fields, mapped, value);
  }

  return {
    presetName: positional[0] || null,
    extraPositionals: positional.slice(1),
    fields,
    json,
  };
}

function mergeActor(defaultActor, overrideActor) {
  const actor = { ...(defaultActor || {}), ...(overrideActor || {}) };
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function defaultEventSummary(input) {
  if (input.event === "checkpoint_saved") {
    return `context-save checkpoint ${input.checkpoint_id}`;
  }
  if (input.event === "checkpoint_restored") {
    return `context-restore checkpoint ${input.checkpoint_id}`;
  }
  if (input.event === "pr_created") {
    const [pr] = normalizeNumericRefs(input.pr_refs);
    return pr ? `PR #${pr} created` : "PR created";
  }
  if (input.event === "pr_merged_or_closed") {
    const [pr] = normalizeNumericRefs(input.pr_refs);
    return pr ? `PR #${pr} merged or closed` : "PR merged or closed";
  }
  return undefined;
}

function validateRunEventInput(input) {
  if (!input.event) {
    throw new Error("tfx cto event requires a preset or --event <event_type>");
  }

  if (
    ["checkpoint_saved", "checkpoint_restored"].includes(input.event) &&
    !maybeString(input.checkpoint_id)
  ) {
    throw new Error(`tfx cto event ${input.event} requires --checkpoint-id`);
  }

  if (
    ["pr_created", "pr_merged_or_closed"].includes(input.event) &&
    normalizeNumericRefs(input.pr_refs).length === 0
  ) {
    throw new Error(`tfx cto event ${input.event} requires --pr`);
  }
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

  const ts = toIsoTime(input.now ?? input.ts);
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
      "[tfx cto event] warning: ledger lock timeout; skipped ledger append\n",
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

export async function runEvent(args = [], opts = {}) {
  const parsed = parseEventArgs(args);
  if (parsed.extraPositionals.length > 0) {
    throw new Error(
      `unexpected tfx cto event argument: ${parsed.extraPositionals[0]}`,
    );
  }
  const preset = parsed.presetName ? EVENT_PRESETS[parsed.presetName] : null;
  if (parsed.presetName && !preset && !parsed.fields.event) {
    throw new Error(`unknown tfx cto event preset: ${parsed.presetName}`);
  }

  const rootDir = opts.rootDir || resolveLakeRootDir(process.cwd());
  const lakeRoot = opts.lakeRoot || join(rootDir, ".triflux", "lake");
  const stdout = opts.stdout || process.stdout;
  const jsonOut = opts.json === true || parsed.json;
  const ownerSurface =
    parsed.fields.owner_surface ||
    preset?.ownerSurface ||
    "external wrapper -> tfx cto event --event";

  const input = {
    ...(preset || {}),
    ...parsed.fields,
    actor: mergeActor(preset?.actor, parsed.fields.actor),
  };
  delete input.ownerSurface;
  delete input.owner_surface;
  if (!input.project_root) input.project_root = rootDir;
  if (!input.summary) input.summary = defaultEventSummary(input);

  validateRunEventInput(input);

  const result = await appendCtoEvent(lakeRoot, input, {
    stderr: opts.stderr,
    lockRetries: opts.ledgerLockRetries,
    lockRetryDelayMs: opts.ledgerLockRetryDelayMs,
  });
  const payload = {
    appended: result.appended,
    owner_surface: ownerSurface,
    event: result.event,
  };

  if (jsonOut) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const status = result.appended ? "appended" : "skipped";
    stdout.write(
      `[tfx cto event] ${status} ${result.event.event} via ${ownerSurface}\n`,
    );
  }

  return payload;
}
