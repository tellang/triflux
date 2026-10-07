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
import { join } from "node:path";
import { describe, it } from "node:test";

import { projectCtoHygiene, runHygiene } from "../../cto/hygiene.mjs";

const baseCurrent = {
  ledger_tail: [],
  sources: {},
};

function event(ts, name, ref = {}, summary = name) {
  return { ts, event: name, source: "test", summary, ref };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "tfx-cto-hygiene-"));
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
    text() {
      return text;
    },
  };
}

describe("projectCtoHygiene", () => {
  it("deterministically projects actionable hygiene counts from CTO events and live overlay", () => {
    const ledger = [
      event("2026-06-17T00:00:00.000Z", "task_claimed", {
        task_id: "task-active",
        actor: { agent_id: "agent-a" },
      }),
      event("2026-06-17T00:01:00.000Z", "task_claimed", {
        task_id: "task-done",
      }),
      event("2026-06-17T00:02:00.000Z", "task_completed", {
        task_id: "task-done",
      }),
      event("2026-06-17T00:03:00.000Z", "session_stale", {
        session_id: "session-old",
        stale_reason: "heartbeat_timeout",
      }),
      event("2026-06-17T00:04:00.000Z", "worktree_created", {
        worktree_path_hash: "wt-hash",
        worktree_label: "worker-a",
        status: "orphaned",
      }),
      event("2026-06-17T00:05:00.000Z", "checkpoint_saved", {
        checkpoint_id: "cp-old",
        session_id: "session-old",
      }),
      event("2026-06-17T00:06:00.000Z", "checkpoint_saved", {
        checkpoint_id: "cp-new",
        session_id: "session-old",
      }),
    ];

    const projection = projectCtoHygiene({
      current: baseCurrent,
      ledger,
      overlay: {
        live_sessions: [{ sessionId: "session-live", phase: "stale" }],
      },
    });

    assert.equal(projection.dry_run, true);
    assert.equal(projection.counts.active_tasks, 1);
    assert.equal(projection.counts.completed_tasks, 1);
    assert.equal(projection.counts.stale_sessions, 2);
    assert.equal(projection.counts.orphan_worktrees, 1);
    assert.equal(projection.counts.superseded_checkpoints, 1);
    assert.equal(projection.counts.unknown_owner, 4);
    assert.deepEqual(
      projection.rows.map((row) => [row.kind, row.id, row.status]),
      [
        ["task", "task-active", "active"],
        ["task", "task-done", "completed"],
        ["session", "session-old", "stale"],
        ["session", "session-live", "stale"],
        ["worktree", "worker-a", "orphaned"],
        ["checkpoint", "cp-old", "superseded"],
      ],
    );
  });

  it("projects the full ledger without moving artifacts or writing lake state", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const ledgerPath = join(lakeRoot, "ledger.jsonl");
    const artifactPath = join(lakeRoot, "session.md");
    try {
      mkdirSync(lakeRoot, { recursive: true });
      writeFileSync(artifactPath, "session artifact\n");
      const ledger = [
        event("2026-06-17T00:00:00.000Z", "session_stale", {
          session_id: "old",
          artifact_path: artifactPath,
        }),
        ...Array.from({ length: 25 }, () =>
          event("2026-06-17T00:01:00.000Z", "collect"),
        ),
      ];
      const before =
        ledger.map((row) => JSON.stringify(row)).join("\n") + "\n{broken\n";
      writeFileSync(ledgerPath, before);
      const stdout = stdoutSink();
      const projection = await runHygiene(["--dry-run", "--json"], {
        rootDir: root,
        lakeRoot,
        stdout,
        overlay: { live_sessions: [] },
      });
      assert.equal(projection.dry_run, true);
      assert.equal(stdout.json().counts.stale_sessions, 1);
      assert.equal(projection.rows[0].artifact_path, artifactPath);
      assert.equal(readFileSync(ledgerPath, "utf8"), before);
      assert.equal(readFileSync(artifactPath, "utf8"), "session artifact\n");
      assert.equal(existsSync(join(lakeRoot, "current.json")), false);
      assert.equal(existsSync(join(lakeRoot, "archive")), false);
      await assert.rejects(
        () => runHygiene(["--apply"], { rootDir: root, lakeRoot, stdout }),
        /supports only --dry-run/,
      );
      assert.equal(readFileSync(ledgerPath, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
