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

import {
  appendCtoEvent,
  CTO_EVENT_SCHEMA_VERSION,
  normalizeCtoEvent,
} from "../../cto/events.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "tfx-cto-events-"));
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("CTO normalized events", () => {
  it("normalizes checkpoint lineage into a compact ledger-compatible event", () => {
    const event = normalizeCtoEvent({
      event: "checkpoint_restored",
      now: "2026-06-17T06:00:00.000Z",
      actor: { cli: "gstack", session_id: "restore-session" },
      checkpoint_id: "checkpoint-123",
      restored_from_session_id: "source-session",
      session_id: "restore-session",
      worktree_path: "/Users/example/project/.worktrees/worker-a",
      branch: "feat/worker-a",
      status: "active",
      issue_refs: [422, "#421", "not-an-issue"],
      pr_refs: [421, "#420", "bad"],
      summary: "restore checkpoint checkpoint-123",
    });

    assert.equal(event.ts, "2026-06-17T06:00:00.000Z");
    assert.equal(event.event, "checkpoint_restored");
    assert.equal(event.source, "tfx_cto_event");
    assert.equal(event.summary, "restore checkpoint checkpoint-123");
    assert.equal(event.ref.schema_version, CTO_EVENT_SCHEMA_VERSION);
    assert.equal(event.ref.event_type, "checkpoint_restored");
    assert.equal(event.ref.session_id, "restore-session");
    assert.equal(event.ref.restored_from_session_id, "source-session");
    assert.equal(event.ref.checkpoint_id, "checkpoint-123");
    assert.equal(event.ref.worktree_label, "worker-a");
    assert.equal(typeof event.ref.worktree_path_hash, "string");
    assert.ok(event.ref.worktree_path_hash.length > 0);
    assert.equal(Object.hasOwn(event.ref, "worktree_path"), false);
    assert.deepEqual(event.ref.issue_refs, [422, 421]);
    assert.deepEqual(event.ref.pr_refs, [421, 420]);
    assert.deepEqual(event.ref.actor, {
      cli: "gstack",
      session_id: "restore-session",
    });
  });

  it("rejects unknown event types and invalid hygiene status", () => {
    assert.throws(
      () => normalizeCtoEvent({ event: "random_event" }),
      /unknown CTO event/i,
    );
    assert.throws(
      () => normalizeCtoEvent({ event: "task_completed", status: "maybe" }),
      /invalid CTO status/i,
    );
  });

  it("appends normalized CTO events to the lake ledger with the existing lock contract", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    const warnings = [];
    try {
      const first = await appendCtoEvent(lakeRoot, {
        event: "task_claimed",
        now: "2026-06-17T06:01:00.000Z",
        session_id: "session-a",
        task_id: "task-a",
        summary: "claim task-a",
      });
      assert.equal(first.appended, true);

      const ledgerPath = join(lakeRoot, "ledger.jsonl");
      const rows = readJsonl(ledgerPath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].event, "task_claimed");
      assert.equal(rows[0].ref.task_id, "task-a");

      writeFileSync(join(lakeRoot, "ledger.jsonl.lock"), "held\n", "utf8");
      const second = await appendCtoEvent(
        lakeRoot,
        { event: "task_completed", task_id: "task-a" },
        {
          stderr: { write: (msg) => warnings.push(msg) },
          lockRetries: 1,
          lockRetryDelayMs: 1,
        },
      );
      assert.equal(second.appended, false);
      assert.equal(readJsonl(ledgerPath).length, 1);
      assert.match(warnings.join(""), /ledger.*lock.*timeout/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates no ledger file when all append attempts are blocked by an existing lock", async () => {
    const root = tempRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    try {
      mkdirSync(lakeRoot, { recursive: true });
      writeFileSync(join(lakeRoot, "ledger.jsonl.lock"), "held\n", "utf8");

      const result = await appendCtoEvent(
        lakeRoot,
        { event: "session_stale", session_id: "session-a" },
        { stderr: { write() {} }, lockRetries: 1, lockRetryDelayMs: 1 },
      );

      assert.equal(result.appended, false);
      assert.equal(existsSync(join(lakeRoot, "ledger.jsonl")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
