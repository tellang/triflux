import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ACTIONABLE_COUNT_KEYS = Object.freeze([
  "active_tasks",
  "stale_sessions",
  "orphan_worktrees",
  "superseded_checkpoints",
  "unknown_owner",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function actionableCounts(projection = {}) {
  const counts = projection?.counts || {};
  return Object.fromEntries(
    ACTIONABLE_COUNT_KEYS.map((key) => [key, normalizeCount(counts[key])]),
  );
}

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      kind: String(row?.kind || ""),
      id: String(row?.id || ""),
      status: String(row?.status || ""),
      action: row?.action == null ? "" : String(row.action),
      owner: row?.owner == null ? "" : String(row.owner),
    }))
    .sort((a, b) =>
      [a.kind, a.id, a.status, a.action, a.owner]
        .join("\u0000")
        .localeCompare([b.kind, b.id, b.status, b.action, b.owner].join("\u0000")),
    );
}

export function ctoHygieneStateHash(projection = {}) {
  const canonical = {
    counts: actionableCounts(projection),
    rows: normalizeRows(projection.rows),
  };
  return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function summarizeCounts(counts) {
  const parts = [];
  if (counts.active_tasks)
    parts.push(plural(counts.active_tasks, "active task"));
  if (counts.stale_sessions)
    parts.push(plural(counts.stale_sessions, "stale session"));
  if (counts.orphan_worktrees)
    parts.push(plural(counts.orphan_worktrees, "orphan worktree"));
  if (counts.superseded_checkpoints)
    parts.push(plural(counts.superseded_checkpoints, "superseded checkpoint"));
  if (counts.unknown_owner)
    parts.push(plural(counts.unknown_owner, "unknown owner"));
  return parts;
}

export function buildCtoHygieneNotification(projection = {}, opts = {}) {
  const counts = actionableCounts(projection);
  const actionable = ACTIONABLE_COUNT_KEYS.some((key) => counts[key] > 0);
  const hash = ctoHygieneStateHash(projection);
  if (!actionable) {
    return { actionable, hash, event: null, counts };
  }

  const summary = `CTO hygiene needs action: ${summarizeCounts(counts).join(", ")}`;
  return {
    actionable,
    hash,
    counts,
    event: {
      type: "ctoHygiene",
      sessionId: opts.sessionId || "cto-hygiene",
      summary,
      timestamp:
        typeof opts.now === "function"
          ? opts.now()
          : (opts.timestamp ?? new Date().toISOString()),
    },
  };
}

async function readState(stateFile) {
  if (!stateFile) return null;
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeState(stateFile, state) {
  if (!stateFile) return;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function notifyCtoHygieneOnce(projection = {}, opts = {}) {
  const notification = buildCtoHygieneNotification(projection, opts);
  const previous = await readState(opts.stateFile);
  const unchanged = previous?.hash === notification.hash;
  const checkedAt =
    typeof opts.now === "function" ? opts.now() : new Date().toISOString();

  if (!notification.actionable) {
    await writeState(opts.stateFile, {
      hash: notification.hash,
      actionable: false,
      checkedAt,
    });
    return {
      actionable: false,
      notified: false,
      reason: "not-actionable",
      hash: notification.hash,
    };
  }

  if (unchanged) {
    return {
      actionable: true,
      notified: false,
      reason: "unchanged-state",
      hash: notification.hash,
    };
  }

  const notifierResult = await opts.notifier.notify(notification.event);
  await writeState(opts.stateFile, {
    hash: notification.hash,
    actionable: true,
    notifiedAt: notification.event.timestamp,
  });

  return {
    actionable: true,
    notified: true,
    reason: "changed-actionable-state",
    hash: notification.hash,
    event: notification.event,
    notify: notifierResult,
  };
}
