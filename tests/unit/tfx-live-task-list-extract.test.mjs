import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADAPTERS,
  extractAssistantResponse,
  extractClaudeCompletedTaskListResponse,
  hasClaudeCompletedTaskListResponse,
} from "../../bin/tfx-live.mjs";

const beforeTaskListCapture = [
  " ▐▛███▜▌   Claude Code v2.1.173",
  "▝▜█████▛▘  Opus 4.8 (1M context) · ~/projects",
  "  ▘▘ ▝▝    0 awaiting input · 0 working · 1 completed",
  "",
  "Completed",
  "✻ stale task                                STALE_OK                         1m",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ describe a task for a new session",
  "────────────────────────────────────────────────────────────────────────────────",
  "  enter to open · space to reply · ctrl+x to delete · ? for shortcuts",
].join("\n");

const afterTaskListCapture = [
  " ▐▛███▜▌   Claude Code v2.1.173",
  "▝▜█████▛▘  Opus 4.8 (1M context) · ~/projects",
  "  ▘▘ ▝▝    0 awaiting input · 1 working · 2 completed",
  "",
  "Working",
  "✻ 지금은?                                   You've hit your weekly limit ·…   1d",
  "Completed",
  "✻ stale task                                STALE_OK                         1m",
  "✻ remote pipe output                        REMOTE_PIPE_OK                   5s",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ describe a task for a new session",
  "────────────────────────────────────────────────────────────────────────────────",
  "  enter to open · space to reply · ctrl+x to delete · ? for shortcuts",
].join("\n");

test("extracts the new matching Claude task-list Completed response", () => {
  assert.equal(
    extractClaudeCompletedTaskListResponse(afterTaskListCapture, {
      beforeText: beforeTaskListCapture,
      prompt: "remote pipe output",
    }),
    "REMOTE_PIPE_OK",
  );
  assert.equal(
    hasClaudeCompletedTaskListResponse(afterTaskListCapture, {
      beforeText: beforeTaskListCapture,
      prompt: "remote pipe output",
    }),
    true,
  );
});

test("real-prompt-no-substring falls back to the single new Completed response", () => {
  assert.equal(
    extractClaudeCompletedTaskListResponse(afterTaskListCapture, {
      beforeText: beforeTaskListCapture,
      prompt: "정확히 'REMOTE_PIPE_OK' 한 단어만 출력해. 다른 말 금지.",
    }),
    "REMOTE_PIPE_OK",
  );
  assert.equal(
    hasClaudeCompletedTaskListResponse(afterTaskListCapture, {
      beforeText: beforeTaskListCapture,
      prompt: "정확히 'REMOTE_PIPE_OK' 한 단어만 출력해. 다른 말 금지.",
    }),
    true,
  );
});

test("multiple-new-no-match-takes-latest", () => {
  const after = [
    "Completed",
    "✻ stale task                                STALE_OK                         1m",
    "✻ first generated summary                   FIRST_OK                         9s",
    "✻ latest generated summary                  LATEST_OK                        2s",
    "────────────────────────────────────────────────────────────────────────────────",
    "❯ describe a task for a new session",
  ].join("\n");

  assert.equal(
    extractClaudeCompletedTaskListResponse(after, {
      beforeText: beforeTaskListCapture,
      prompt: "no summary contains this prompt",
    }),
    "LATEST_OK",
  );
});

test("multiple-new-prompt-disambiguates", () => {
  const after = [
    "Completed",
    "✻ stale task                                STALE_OK                         1m",
    "✻ selected remote pipe output               SELECTED_OK                      9s",
    "✻ latest generated summary                  LATEST_OK                        2s",
    "────────────────────────────────────────────────────────────────────────────────",
    "❯ describe a task for a new session",
  ].join("\n");

  assert.equal(
    extractClaudeCompletedTaskListResponse(after, {
      beforeText: beforeTaskListCapture,
      prompt: "remote pipe output",
    }),
    "SELECTED_OK",
  );
});

test("does not return a stale Completed task from the baseline", () => {
  assert.equal(
    extractClaudeCompletedTaskListResponse(beforeTaskListCapture, {
      beforeText: beforeTaskListCapture,
      prompt: "stale task",
    }),
    "",
  );
  assert.equal(
    hasClaudeCompletedTaskListResponse(beforeTaskListCapture, {
      beforeText: beforeTaskListCapture,
      prompt: "stale task",
    }),
    false,
  );
});

test("keeps the existing inline Claude response extraction path", () => {
  const inlineCapture = [
    "❯ echoed prompt",
    "⏺ first answer",
    "✻ Brewed for 1s",
    "❯ remote pipe output",
    "⏺ inline answer",
    "  continuation",
    "❯ ",
  ].join("\n");

  assert.equal(
    extractAssistantResponse(
      ADAPTERS.claude,
      inlineCapture,
      "remote pipe output",
    ),
    "inline answer\n  continuation",
  );
});

test("preserves the leading response line when a capture exceeds 200 lines", () => {
  const continuation = Array.from(
    { length: 250 },
    (_, index) => `  continuation line ${index + 1}`,
  );
  const capture = [
    "❯ summarize the long result",
    "⏺ response begins before the old 200-line cutoff",
    ...continuation,
    "❯ ",
  ].join("\n");

  const response = extractAssistantResponse(
    ADAPTERS.claude,
    capture,
    "summarize the long result",
  );

  assert.ok(
    response.startsWith("response begins before the old 200-line cutoff"),
  );
  assert.match(response, /continuation line 250$/);
});

test("captures the complete tmux scrollback with the existing output ceiling", async () => {
  const source = await readFile(
    new URL("../../bin/tfx-live.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /const CAPTURE_START = "-";/);
  assert.match(source, /const MAX_BUFFER = 10 \* 1024 \* 1024;/);
});
