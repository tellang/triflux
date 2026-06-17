import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCtoHygieneNotification,
  ctoHygieneStateHash,
  notifyCtoHygieneOnce,
} from "../../cto/hygiene-notify.mjs";

test("CTO hygiene notification helper treats only actionable counts as notify-worthy", () => {
  const quiet = buildCtoHygieneNotification({
    counts: {
      active_tasks: 0,
      stale_sessions: 0,
      orphan_worktrees: 0,
      superseded_checkpoints: 0,
      unknown_owner: 0,
    },
    rows: [],
  });

  assert.equal(quiet.actionable, false);
  assert.equal(quiet.event, null);

  const actionable = buildCtoHygieneNotification({
    counts: {
      active_tasks: 1,
      stale_sessions: 1,
      orphan_worktrees: 0,
      superseded_checkpoints: 0,
      unknown_owner: 1,
    },
    rows: [
      { kind: "task", id: "T1", action: "complete_or_reassign_task" },
      { kind: "session", id: "S1", action: "archive_or_resume_session" },
    ],
  });

  assert.equal(actionable.actionable, true);
  assert.equal(actionable.event.type, "ctoHygiene");
  assert.equal(actionable.event.sessionId, "cto-hygiene");
  assert.match(actionable.event.summary, /1 active task/u);
  assert.match(actionable.event.summary, /1 stale session/u);
  assert.match(actionable.event.summary, /1 unknown owner/u);
});

test("CTO hygiene state hash is stable across row order changes", () => {
  const first = ctoHygieneStateHash({
    counts: { active_tasks: 1 },
    rows: [
      { kind: "session", id: "S1", status: "stale" },
      { kind: "task", id: "T1", status: "active" },
    ],
  });
  const second = ctoHygieneStateHash({
    counts: { active_tasks: 1 },
    rows: [
      { kind: "task", id: "T1", status: "active" },
      { kind: "session", id: "S1", status: "stale" },
    ],
  });

  assert.equal(first, second);
});

test("notifyCtoHygieneOnce sends once for changed actionable state and dedupes repeats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cto-hygiene-notify-"));
  const stateFile = join(dir, "state.json");
  const sent = [];
  const notifier = {
    async notify(event) {
      sent.push(event);
      return { event, results: { bell: { status: "sent" } } };
    },
  };
  const projection = {
    counts: { active_tasks: 1, stale_sessions: 0, orphan_worktrees: 0 },
    rows: [{ kind: "task", id: "T1", status: "active" }],
  };

  try {
    const first = await notifyCtoHygieneOnce(projection, {
      notifier,
      stateFile,
      now: () => "2026-06-17T00:00:00.000Z",
    });
    const second = await notifyCtoHygieneOnce(projection, {
      notifier,
      stateFile,
      now: () => "2026-06-17T00:01:00.000Z",
    });

    assert.equal(first.notified, true);
    assert.equal(first.reason, "changed-actionable-state");
    assert.equal(second.notified, false);
    assert.equal(second.reason, "unchanged-state");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "ctoHygiene");

    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(persisted.hash, first.hash);
    assert.equal(persisted.actionable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
