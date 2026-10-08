import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderBrief } from "../../cto/brief.mjs";

function makeCurrent(overrides = {}) {
  return {
    schema_version: "cto-lake.v1",
    generated_at: "2026-06-02T00:00:00.000Z",
    repo: {
      root: "/tmp/repo",
      branch: "main",
      head: "abcdef123456",
      dirty: true,
    },
    sources: {},
    summary: {
      repo_state: "main has local changes",
      active_goals: [
        { id: "G1", title: "Goal one", status: "in_progress" },
        { id: "G2", title: "Goal two", status: "pending" },
        { id: "G3", title: "Goal three", status: "pending" },
        { id: "G4", title: "Goal four", status: "pending" },
      ],
    },
    ledger_tail: [
      {
        ts: "2026-06-02T00:00:00.000Z",
        event: "older",
        source: "test",
        summary: "old",
        ref: null,
      },
      {
        ts: "2026-06-02T00:01:00.000Z",
        event: "recent-1",
        source: "test",
        summary: "recent one",
        ref: null,
      },
      {
        ts: "2026-06-02T00:02:00.000Z",
        event: "recent-2",
        source: "test",
        summary: "recent two",
        ref: null,
      },
    ],
    ...overrides,
  };
}

describe("renderBrief", () => {
  it("caps the rendered brief at 2KB", () => {
    const brief = renderBrief(
      makeCurrent({
        summary: {
          repo_state: "x".repeat(10_000),
          active_goals: [
            { id: "G1", title: "x".repeat(10_000), status: "in_progress" },
          ],
        },
      }),
    );

    assert.ok(brief.startsWith("brief_version: cto-lake.v1\n"));
    assert.ok(Buffer.byteLength(brief, "utf8") <= 2048);
    assert.match(brief, /\.\.\. truncated$/u);
  });

  it("limits active goals to 3 and recent events to 2", () => {
    const brief = renderBrief(makeCurrent());

    assert.match(brief, /^active_goals$/mu);
    assert.match(brief, /G1/);
    assert.match(brief, /G2/);
    assert.match(brief, /G3/);
    assert.doesNotMatch(brief, /G4/);

    assert.doesNotMatch(brief, /^swarm_shards$/mu);

    assert.match(brief, /^recent_events$/mu);
    assert.doesNotMatch(brief, /older/);
    assert.match(brief, /recent-1/);
    assert.match(brief, /recent-2/);
  });
});
