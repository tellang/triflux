import assert from "node:assert/strict";
import test from "node:test";

import {
  extractClaudeAgentSessions,
  normalizeClaudeAgentSession,
} from "../../hub/team/claude-agent-session-normalizer.mjs";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

test("normalizes Claude 2.1.169 agent-view rows with state field", () => {
  const normalized = normalizeClaudeAgentSession({
    id: "abcd1234",
    cwd: "/repo",
    kind: "bg",
    startedAt: "2026-06-09T00:00:00.000Z",
    sessionId: SESSION_ID,
    state: "blocked",
    waitingFor: "permission prompt",
  });

  assert.equal(normalized.short, "abcd1234");
  assert.equal(normalized.id, "abcd1234");
  assert.equal(normalized.sessionId, SESSION_ID);
  assert.equal(normalized.session_id, SESSION_ID);
  assert.equal(normalized.state, "blocked");
  assert.equal(normalized.status, "blocked");
  assert.equal(normalized.cwd, "/repo");
  assert.equal(normalized.waitingFor, "permission prompt");
});

test("normalizes older daemon rows with status field", () => {
  const normalized = normalizeClaudeAgentSession({
    short: "facefeed",
    session_id: SESSION_ID,
    status: "running",
    dispatch: { sessionId: "ignored-because-top-level-wins" },
  });

  assert.equal(normalized.short, "facefeed");
  assert.equal(normalized.sessionId, SESSION_ID);
  assert.equal(normalized.session_id, SESSION_ID);
  assert.equal(normalized.state, "running");
  assert.equal(normalized.status, "running");
});

test("extracts sessions from either jobs or sessions lists", () => {
  assert.deepEqual(
    extractClaudeAgentSessions({ jobs: [{ short: "a", sessionId: "s-a" }] }),
    [
      {
        short: "a",
        id: "a",
        sessionId: "s-a",
        session_id: "s-a",
        state: "unknown",
        status: "unknown",
      },
    ],
  );

  assert.deepEqual(
    extractClaudeAgentSessions({ sessions: [{ id: "b", sessionId: "s-b" }] }),
    [
      {
        short: "b",
        id: "b",
        sessionId: "s-b",
        session_id: "s-b",
        state: "unknown",
        status: "unknown",
      },
    ],
  );
});
