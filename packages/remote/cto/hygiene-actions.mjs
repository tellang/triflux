import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const ARCHIVABLE_ACTIONS = new Set([
  "archive_or_resume_session",
  "prune_superseded_checkpoint",
]);

function shortHash(value) {
  const str = String(value ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function stewardRootHash(rootDir) {
  return createHash("sha256")
    .update(String(rootDir || ""))
    .digest("hex")
    .slice(0, 12);
}

function hygieneKeyForRow(row) {
  return `${row.kind}:${row.id}`;
}

function yyyymmdd(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return yyyymmdd(new Date().toISOString());
  return date.toISOString().slice(0, 10).replace(/-/gu, "");
}

function safeLabel(value) {
  return (
    String(value || "item")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "item"
  );
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeActiveSessions(active) {
  const sessions = Array.isArray(active)
    ? active
    : Array.isArray(active?.sessions)
      ? active.sessions
      : Array.isArray(active?.live_sessions)
        ? active.live_sessions
        : [];
  return sessions
    .map((session) => ({
      sessionId: String(session?.sessionId || session?.session_id || "").trim(),
      phase: String(
        session?.phase || session?.status || "active",
      ).toLowerCase(),
    }))
    .filter((session) => session.sessionId);
}

function isLiveOwned(row, activeSessions) {
  const rowSession = String(row?.session_id || row?.id || "").trim();
  if (!rowSession) return false;
  return activeSessions.some(
    (session) => session.sessionId === rowSession && session.phase !== "stale",
  );
}

function assertProjectHash(row, rootDir) {
  if (!row?.project_root_hash) return;
  const allowed = new Set([shortHash(rootDir), stewardRootHash(rootDir)]);
  if (!allowed.has(String(row.project_root_hash))) {
    throw new Error(
      `project_root_hash mismatch for ${hygieneKeyForRow(row)}: ${row.project_root_hash}`,
    );
  }
}

function assertLakePath(lakeRoot, path, label) {
  if (!isInside(lakeRoot, path)) {
    throw new Error(`${label} must be under lakeRoot: ${path}`);
  }
}

function sourceBytes(path) {
  const info = statSync(path);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return info.size || 0;
  return 0;
}

function targetPathFor({ lakeRoot, row, sourcePath, now }) {
  const archiveDir = join(lakeRoot, "archive", yyyymmdd(now));
  const label = safeLabel(hygieneKeyForRow(row));
  return join(archiveDir, `${label}-${basename(sourcePath)}`);
}

function hasSecondActorApproval(opts = {}) {
  if (opts.humanAck === true || opts.humanGate === true) return true;
  const actorSessionId = String(opts.actorSessionId || "").trim();
  if (!actorSessionId) return false;
  const hygieneKey = opts.hygieneKey;
  const approvals = Array.isArray(opts.approvals) ? opts.approvals : [];
  return approvals.some((entry) => {
    const ref = entry?.ref && typeof entry.ref === "object" ? entry.ref : {};
    if (ref.hygiene_key !== hygieneKey) return false;
    const approverSession = String(ref?.actor?.session_id || "").trim();
    return Boolean(approverSession && approverSession !== actorSessionId);
  });
}

function movePath(sourcePath, targetPath, fsOps = {}) {
  const ops = {
    copyFileSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    renameSync,
    rmSync,
    unlinkSync,
    ...fsOps,
  };
  ops.mkdirSync(dirname(targetPath), { recursive: true });
  try {
    ops.renameSync(sourcePath, targetPath);
    return "rename";
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    const info = ops.lstatSync(sourcePath);
    if (info.isDirectory()) {
      ops.cpSync(sourcePath, targetPath, { recursive: true, force: false });
      ops.rmSync(sourcePath, { recursive: true, force: false });
    } else {
      ops.copyFileSync(sourcePath, targetPath);
      ops.unlinkSync(sourcePath);
    }
    return "copy_unlink";
  }
}

function digestOperations(operations) {
  const payload = operations.map((operation) => ({
    hygiene_key: operation.hygiene_key,
    status: operation.status,
    source_path: operation.source_path,
    target_path: operation.target_path,
    bytes: operation.bytes,
    reason: operation.reason,
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function rowsFromProjection(projection) {
  return Array.isArray(projection?.rows) ? projection.rows : [];
}

export async function applyHygieneArchiveActions({
  rootDir,
  lakeRoot,
  projection,
  dryRun = true,
  now = new Date().toISOString(),
  applyMode = "off",
  active = {},
  humanAck = false,
  humanGate = false,
  actorSessionId = null,
  approvals = [],
  fsOps = {},
} = {}) {
  const archiveRoot = join(lakeRoot, "archive", yyyymmdd(now));
  assertLakePath(lakeRoot, archiveRoot, "archive target");

  const activeSessions = normalizeActiveSessions(active);
  const operations = [];

  for (const row of rowsFromProjection(projection)) {
    const hygieneKey = hygieneKeyForRow(row);
    if (row?.kind === "worktree" && row?.status === "orphaned") {
      operations.push({
        hygiene_key: hygieneKey,
        kind: row.kind,
        id: row.id,
        action: row.action,
        status: "blocked",
        reason: "orphan_worktree_requires_human",
        bytes: 0,
      });
      continue;
    }

    if (!ARCHIVABLE_ACTIONS.has(row?.action)) continue;

    assertProjectHash(row, rootDir);

    if (isLiveOwned(row, activeSessions)) {
      operations.push({
        hygiene_key: hygieneKey,
        kind: row.kind,
        id: row.id,
        action: row.action,
        status: "skipped",
        reason: "live_session_owned",
        bytes: 0,
      });
      continue;
    }

    const sourcePath = row.artifact_path ? resolve(row.artifact_path) : null;
    if (!sourcePath) {
      operations.push({
        hygiene_key: hygieneKey,
        kind: row.kind,
        id: row.id,
        action: row.action,
        status: "skipped",
        reason: "missing_artifact_path",
        bytes: 0,
      });
      continue;
    }
    assertLakePath(lakeRoot, sourcePath, "archive source");

    const targetPath = targetPathFor({ lakeRoot, row, sourcePath, now });
    assertLakePath(lakeRoot, targetPath, "archive target");

    if (!existsSync(sourcePath)) {
      operations.push({
        hygiene_key: hygieneKey,
        kind: row.kind,
        id: row.id,
        action: row.action,
        source_path: sourcePath,
        target_path: targetPath,
        status: existsSync(targetPath) ? "already_archived" : "skipped",
        reason: existsSync(targetPath) ? undefined : "source_missing",
        bytes: 0,
      });
      continue;
    }

    operations.push({
      hygiene_key: hygieneKey,
      kind: row.kind,
      id: row.id,
      action: row.action,
      source_path: sourcePath,
      target_path: targetPath,
      status: "planned",
      bytes: sourceBytes(sourcePath),
    });
  }

  if (!dryRun) {
    for (const operation of operations) {
      if (operation.status !== "planned") continue;
      if (applyMode !== "archive") {
        operation.status = "blocked";
        operation.reason = "apply_mode_off";
        continue;
      }
      if (
        !hasSecondActorApproval({
          humanAck,
          humanGate,
          actorSessionId,
          approvals,
          hygieneKey: operation.hygiene_key,
        })
      ) {
        operation.status = "blocked";
        operation.reason = "second_actor_ack_required";
        continue;
      }
      operation.move_method = movePath(
        operation.source_path,
        operation.target_path,
        fsOps,
      );
      operation.status = "archived";
    }
  }

  const plannedCount = operations.filter((operation) =>
    ["planned", "archived", "already_archived"].includes(operation.status),
  ).length;
  const appliedCount = operations.filter(
    (operation) => operation.status === "archived",
  ).length;
  const blockedCount = operations.filter(
    (operation) => operation.status === "blocked",
  ).length;

  return {
    schema_version: "cto-hygiene-actions.v1",
    dry_run: Boolean(dryRun),
    apply_mode: applyMode,
    archive_root: archiveRoot,
    planned_count: plannedCount,
    applied_count: appliedCount,
    blocked_count: blockedCount,
    total_bytes: operations.reduce(
      (sum, operation) => sum + Number(operation.bytes || 0),
      0,
    ),
    digest: digestOperations(operations),
    live_safety: {
      active_session_count: activeSessions.length,
      skipped_live_count: operations.filter(
        (operation) => operation.reason === "live_session_owned",
      ).length,
    },
    operations,
  };
}
