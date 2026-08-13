#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCollision,
  classifyTuiPaneState,
  correlateNonce,
  summarizeLatencyMs,
} from "./codex-app-server-dual-client-gating-probe.mjs";

function threadWithTurns(turns) {
  return { thread: { id: "thread-1", turns } };
}

test("correlateNonce maps a user nonce to thread, turn, item, and client id", () => {
  const history = threadWithTurns([
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "item-1",
          clientId: "client-message-1",
          content: [{ type: "text", text: "reply P1-NONCE" }],
        },
      ],
    },
  ]);

  assert.deepEqual(correlateNonce(history, "P1-NONCE"), {
    threadId: "thread-1",
    turnId: "turn-1",
    turnStatus: "completed",
    itemId: "item-1",
    clientUserMessageId: "client-message-1",
    text: "reply P1-NONCE",
  });
});

test("classifyCollision identifies same-turn steering", () => {
  const history = threadWithTurns([
    {
      id: "turn-steer",
      status: "completed",
      items: [
        { type: "userMessage", id: "p", content: [{ type: "text", text: "P-COLLIDE" }] },
        { type: "userMessage", id: "h", content: [{ type: "text", text: "H-COLLIDE" }] },
      ],
    },
  ]);
  assert.equal(classifyCollision(history, "P-COLLIDE", "H-COLLIDE"), "steer");
});

test("classifyCollision distinguishes queue and reject", () => {
  const queued = threadWithTurns([
    { id: "turn-p", items: [{ type: "userMessage", id: "p", content: [{ type: "text", text: "P-QUEUE" }] }] },
    { id: "turn-h", items: [{ type: "userMessage", id: "h", content: [{ type: "text", text: "H-QUEUE" }] }] },
  ]);
  const rejected = threadWithTurns([
    { id: "turn-p", items: [{ type: "userMessage", id: "p", content: [{ type: "text", text: "P-REJECT" }] }] },
  ]);

  assert.equal(classifyCollision(queued, "P-QUEUE", "H-QUEUE"), "queue");
  assert.equal(classifyCollision(rejected, "P-REJECT", "H-REJECT"), "reject");
});

test("classifyTuiPaneState requires an idle composer with no busy affordance", () => {
  const idle = classifyTuiPaneState(`
› Explain this codebase
  gpt-5.6-sol low fast · triflux
`);
  const working = classifyTuiPaneState(`
• Working (36s • esc to interrupt)
› Reply exactly H1_nonce.
  tab to queue message
`);

  assert.deepEqual(idle, {
    busy: false,
    working: false,
    interruptHint: false,
    queueHint: false,
    composerVisible: true,
    notBusy: true,
  });
  assert.deepEqual(working, {
    busy: true,
    working: true,
    interruptHint: true,
    queueHint: true,
    composerVisible: true,
    notBusy: false,
  });
});

test("classifyTuiPaneState ignores stale busy text outside the active pane tail", () => {
  const historicalLines = Array.from(
    { length: 20 },
    (_, index) => `historical output ${index}`,
  ).join("\n");
  const state = classifyTuiPaneState(`
• Working (99s • esc to interrupt)
  tab to queue message
${historicalLines}
› Explain this codebase
  gpt-5.6-sol low fast · triflux
`);

  assert.equal(state.busy, false);
  assert.equal(state.notBusy, true);
});

test("summarizeLatencyMs reports completed median/max and timeout count", () => {
  assert.deepEqual(
    summarizeLatencyMs([
      { latencyMs: 120 },
      { latencyMs: null, timedOut: true },
      { latencyMs: 40 },
      { latencyMs: 80 },
      { latencyMs: 200 },
    ]),
    {
      repetitions: 5,
      completed: 4,
      timedOut: 1,
      medianMs: 100,
      maxMs: 200,
      valuesMs: [40, 80, 120, 200],
    },
  );
});
