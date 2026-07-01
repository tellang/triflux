import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";

import {
  acquireCtoHygieneStewardLock,
  runHygiene,
} from "../../cto/hygiene.mjs";
import { applyHygieneArchiveActions } from "../../cto/hygiene-actions.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "tfx-cto-hygiene-actions-"));
}

function shortHash(value) {
  const str = String(value ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function stdoutSink() {
  let text = "";
  return {
    write(chunk) {
      text += chunk;
    },
    json() {
      return JSON.parse(text);
    },
  };
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeArtifact(lakeRoot, relPath, content = "artifact\n") {
  const filePath = join(lakeRoot, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function projectionWith(row) {
  return {
    schema_version: "cto-hygiene.v1",
    dry_run: true,
    counts: {},
    rows: [row],
  };
}

function archiveRow(root, sourcePath, overrides = {}) {
  return {
    kind: "checkpoint",
    id: "cp-old",
    status: "superseded",
    action: "prune_superseded_checkpoint",
    last_event_at: "2026-07-01T00:00:00.000Z",
    artifact_path: sourcePath,
    project_root_hash: shortHash(root),
    session_id: "session-old",
    ...overrides,
  };
}

describe("cto hygiene archive actions", () => {
  it("plans archive operations in dry-run and moves only when apply mode and approval are present", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const source = writeArtifact(
        lakeRoot,
        "checkpoints/cp-old.json",
        "one\n",
      );
      const projection = projectionWith(archiveRow(root, source));

      const plan = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: true,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        humanAck: true,
        active: { live_sessions: [] },
      });

      assert.equal(plan.dry_run, true);
      assert.equal(plan.planned_count, 1);
      assert.equal(plan.applied_count, 0);
      assert.equal(plan.total_bytes, 4);
      assert.equal(typeof plan.digest, "string");
      assert.equal(existsSync(source), true);
      assert.equal(existsSync(plan.operations[0].target_path), false);

      const applied = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        humanAck: true,
        active: { live_sessions: [] },
      });

      assert.equal(applied.dry_run, false);
      assert.equal(applied.planned_count, 1);
      assert.equal(applied.applied_count, 1);
      assert.equal(existsSync(source), false);
      assert.equal(existsSync(applied.operations[0].target_path), true);
      assert.match(
        relative(lakeRoot, applied.operations[0].target_path),
        /^archive\/20260701\//u,
      );
      assert.equal(
        readFileSync(applied.operations[0].target_path, "utf8"),
        "one\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks archive apply when approval is missing a second actor session", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const source = writeArtifact(lakeRoot, "checkpoints/cp-old.json");
      const projection = projectionWith(archiveRow(root, source));

      const result = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        actorSessionId: "actor-a",
        approvals: [
          {
            event: "hygiene_applied",
            ref: {
              hygiene_key: "checkpoint:cp-old",
              actor: { session_id: "actor-a" },
            },
          },
          {
            event: "hygiene_applied",
            ref: { hygiene_key: "checkpoint:cp-old", actor: {} },
          },
        ],
        active: { live_sessions: [] },
      });

      assert.equal(result.applied_count, 0);
      assert.equal(result.blocked_count, 1);
      assert.equal(result.operations[0].status, "blocked");
      assert.equal(result.operations[0].reason, "second_actor_ack_required");
      assert.equal(existsSync(source), true);

      const missingActor = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        approvals: [
          {
            event: "hygiene_applied",
            ref: {
              hygiene_key: "checkpoint:cp-old",
              actor: { session_id: "actor-b" },
            },
          },
        ],
        active: { live_sessions: [] },
      });

      assert.equal(missingActor.applied_count, 0);
      assert.equal(missingActor.blocked_count, 1);
      assert.equal(
        missingActor.operations[0].reason,
        "second_actor_ack_required",
      );
      assert.equal(existsSync(source), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips archive apply for artifacts owned by live sessions", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const source = writeArtifact(lakeRoot, "sessions/session-old/output.txt");
      const projection = projectionWith(
        archiveRow(root, source, {
          kind: "session",
          id: "session-old",
          status: "stale",
          action: "archive_or_resume_session",
        }),
      );

      const result = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        actorSessionId: "actor-a",
        approvals: [
          {
            event: "hygiene_applied",
            ref: {
              hygiene_key: "session:session-old",
              actor: { session_id: "actor-b" },
            },
          },
        ],
        active: {
          live_sessions: [{ session_id: "session-old", phase: "active" }],
        },
      });

      assert.equal(result.applied_count, 0);
      assert.equal(result.live_safety.skipped_live_count, 1);
      assert.equal(result.operations[0].status, "skipped");
      assert.equal(result.operations[0].reason, "live_session_owned");
      assert.equal(existsSync(source), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks archive apply when apply mode is off", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const source = writeArtifact(lakeRoot, "checkpoints/cp-old.json");
      const projection = projectionWith(archiveRow(root, source));

      const result = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "off",
        actorSessionId: "actor-a",
        approvals: [
          {
            event: "hygiene_applied",
            ref: {
              hygiene_key: "checkpoint:cp-old",
              actor: { session_id: "actor-b" },
            },
          },
        ],
        active: { live_sessions: [] },
      });

      assert.equal(result.applied_count, 0);
      assert.equal(result.blocked_count, 1);
      assert.equal(result.operations[0].status, "blocked");
      assert.equal(result.operations[0].reason, "apply_mode_off");
      assert.equal(existsSync(source), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses apply when project_root_hash mismatches the active project", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const source = writeArtifact(lakeRoot, "checkpoints/cp-old.json");
      const projection = projectionWith(
        archiveRow(root, source, { project_root_hash: "wrong-project" }),
      );

      await assert.rejects(
        () =>
          applyHygieneArchiveActions({
            rootDir: root,
            lakeRoot,
            projection,
            dryRun: false,
            now: "2026-07-01T02:03:04.000Z",
            applyMode: "archive",
            humanAck: true,
            active: { live_sessions: [] },
          }),
        /project_root_hash mismatch/u,
      );
      assert.equal(existsSync(source), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent when the same archive move is applied twice", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const source = writeArtifact(lakeRoot, "sessions/session-old/output.txt");
      const projection = projectionWith(
        archiveRow(root, source, {
          kind: "session",
          id: "session-old",
          status: "stale",
          action: "archive_or_resume_session",
        }),
      );

      const first = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        humanAck: true,
        active: { live_sessions: [] },
      });
      const second = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        humanAck: true,
        active: { live_sessions: [] },
      });

      assert.equal(first.applied_count, 1);
      assert.equal(second.applied_count, 0);
      assert.equal(second.operations[0].status, "already_archived");
      assert.equal(existsSync(first.operations[0].target_path), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks orphan worktree deletion from automatic archive apply", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const projection = projectionWith({
        kind: "worktree",
        id: "worker-a",
        status: "orphaned",
        action: "remove_or_reassign_worktree",
        last_event_at: "2026-07-01T00:00:00.000Z",
        project_root_hash: shortHash(root),
      });

      const result = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        humanAck: true,
        active: { live_sessions: [] },
      });

      assert.equal(result.applied_count, 0);
      assert.equal(result.blocked_count, 1);
      assert.equal(result.operations[0].status, "blocked");
      assert.equal(
        result.operations[0].reason,
        "orphan_worktree_requires_human",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps runHygiene dry-run filesystem-safe while returning planned action metadata", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const ledgerPath = join(lakeRoot, "ledger.jsonl");
    const stdout = stdoutSink();
    try {
      const source = writeArtifact(lakeRoot, "checkpoints/cp-old.json");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          ts: "2026-07-01T00:00:00.000Z",
          event: "checkpoint_saved",
          source: "test",
          summary: "old checkpoint",
          ref: {
            checkpoint_id: "cp-old",
            session_id: "session-old",
            status: "superseded",
            artifact_path: source,
            project_root_hash: shortHash(root),
          },
        })}\n`,
        "utf8",
      );

      const result = await runHygiene(["--dry-run", "--json"], {
        rootDir: root,
        lakeRoot,
        stdout,
        overlay: { live_sessions: [] },
        now: "2026-07-01T02:03:04.000Z",
      });

      assert.equal(result.dry_run, true);
      assert.equal(result.actions.dry_run, true);
      assert.equal(result.actions.planned_count, 1);
      assert.equal(existsSync(source), true);
      assert.equal(stdout.json().actions.planned_count, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ack archive rows when the archive operation is blocked", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const ledgerPath = join(lakeRoot, "ledger.jsonl");
    const stdout = stdoutSink();
    try {
      const source = writeArtifact(lakeRoot, "checkpoints/cp-old.json");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          ts: "2026-07-01T00:00:00.000Z",
          event: "checkpoint_saved",
          source: "test",
          summary: "old checkpoint",
          ref: {
            checkpoint_id: "cp-old",
            session_id: "session-old",
            status: "superseded",
            artifact_path: source,
            project_root_hash: shortHash(root),
          },
        })}\n`,
        "utf8",
      );

      const result = await runHygiene(["--apply", "--json"], {
        rootDir: root,
        lakeRoot,
        stdout,
        overlay: { live_sessions: [] },
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "off",
        actorSessionId: "actor-a",
      });

      assert.equal(result.apply.applied_count, 0);
      assert.equal(result.apply.actions.blocked_count, 1);
      assert.equal(result.apply.actions.operations[0].reason, "apply_mode_off");
      assert.equal(existsSync(source), true);
      assert.equal(readJsonl(ledgerPath).length, 1);
      assert.equal(stdout.json().apply.applied_count, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the existing steward lock for runHygiene apply", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const stdout = stdoutSink();
    try {
      const held = await acquireCtoHygieneStewardLock(root, lakeRoot, {
        timeoutMs: 1,
      });
      try {
        await assert.rejects(
          () =>
            runHygiene(["--apply", "--json"], {
              rootDir: root,
              lakeRoot,
              stdout,
              overlay: { live_sessions: [] },
              stewardLockTimeoutMs: 1,
              stewardLockRetryMs: 1,
              stewardLockStaleMs: 60_000,
            }),
          /steward lock busy/u,
        );
      } finally {
        held.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to copy and unlink when rename crosses filesystems", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      const source = writeArtifact(
        lakeRoot,
        "checkpoints/cp-old.json",
        "exdev\n",
      );
      const projection = projectionWith(archiveRow(root, source));

      const result = await applyHygieneArchiveActions({
        rootDir: root,
        lakeRoot,
        projection,
        dryRun: false,
        now: "2026-07-01T02:03:04.000Z",
        applyMode: "archive",
        humanAck: true,
        active: { live_sessions: [] },
        fsOps: {
          renameSync() {
            const error = new Error("cross-device link not permitted");
            error.code = "EXDEV";
            throw error;
          },
        },
      });

      assert.equal(result.applied_count, 1);
      assert.equal(result.operations[0].move_method, "copy_unlink");
      assert.equal(existsSync(source), false);
      assert.equal(
        readFileSync(result.operations[0].target_path, "utf8"),
        "exdev\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
