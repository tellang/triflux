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
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  ctoHygieneStewardLockPath,
  projectCtoHygiene,
  runHygiene,
} from "../../cto/hygiene.mjs";

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

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

  it("apply is a locked no-op with evidence when dry-run has no actionable rows", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const stdout = stdoutSink();
    try {
      const result = await runHygiene(["--apply", "--json"], {
        rootDir: root,
        lakeRoot,
        stdout,
        overlay: { live_sessions: [] },
        now: "2026-06-17T01:00:00.000Z",
      });

      assert.equal(result.dry_run, false);
      assert.equal(result.apply.applicable_count, 0);
      assert.equal(result.apply.applied_count, 0);
      assert.deepEqual(result.apply.events, []);
      assert.equal(existsSync(join(lakeRoot, "ledger.jsonl")), false);
      assert.equal(
        existsSync(ctoHygieneStewardLockPath(root, lakeRoot)),
        false,
      );
      assert.equal(stdout.json().apply.applied_count, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("apply appends deterministic hygiene events for actionable sample data", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const ledgerPath = join(lakeRoot, "ledger.jsonl");
    const stdout = stdoutSink();
    try {
      mkdirSync(lakeRoot, { recursive: true });
      writeFileSync(
        ledgerPath,
        `${JSON.stringify(
          event("2026-06-17T00:00:00.000Z", "task_claimed", {
            task_id: "task-active",
            actor: { agent_id: "agent-a" },
          }),
        )}\n`,
        "utf8",
      );

      const result = await runHygiene(["--apply", "--json"], {
        rootDir: root,
        lakeRoot,
        stdout,
        overlay: { live_sessions: [] },
        now: "2026-06-17T01:00:00.000Z",
      });

      assert.equal(result.apply.applicable_count, 1);
      assert.equal(result.apply.applied_count, 1);
      assert.equal(result.apply.events[0].event, "hygiene_applied");
      assert.equal(result.apply.events[0].ts, "2026-06-17T01:00:00.000Z");
      assert.equal(result.apply.events[0].ref.hygiene_key, "task:task-active");
      assert.equal(result.apply.events[0].ref.hygiene_kind, "task");
      assert.equal(result.apply.events[0].ref.hygiene_id, "task-active");
      assert.equal(
        result.apply.events[0].ref.hygiene_action,
        "complete_or_reassign_task",
      );

      const rows = readJsonl(ledgerPath);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].event, "hygiene_applied");

      const after = projectCtoHygiene({
        current: baseCurrent,
        ledger: rows,
        overlay: { live_sessions: [] },
      });
      assert.equal(after.counts.active_tasks, 0);
      assert.deepEqual(after.rows, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("apply refuses to overlap when the project steward lock already exists", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const ledgerPath = join(lakeRoot, "ledger.jsonl");
    const lockPath = ctoHygieneStewardLockPath(root, lakeRoot);
    try {
      mkdirSync(lakeRoot, { recursive: true });
      writeFileSync(
        ledgerPath,
        `${JSON.stringify(
          event("2026-06-17T00:00:00.000Z", "session_stale", {
            session_id: "session-old",
          }),
        )}\n`,
        "utf8",
      );
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, "held\n", "utf8");

      await assert.rejects(
        () =>
          runHygiene(["--apply", "--json"], {
            rootDir: root,
            lakeRoot,
            stdout: stdoutSink(),
            overlay: { live_sessions: [] },
            stewardLockTimeoutMs: 1,
            stewardLockRetryMs: 1,
            stewardLockStaleMs: 60_000,
          }),
        /steward lock busy/i,
      );
      assert.equal(readJsonl(ledgerPath).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
