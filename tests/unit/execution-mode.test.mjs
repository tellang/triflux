import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommandForMode,
  MODES,
  selectExecutionMode,
} from "../../hub/team/execution-mode.mjs";

test("MODES exports stable mode names", () => {
  assert.deepEqual(MODES, {
    HEADLESS: "headless",
    INTERACTIVE: "interactive",
    AUTO: "auto",
  });
});

test("selectExecutionMode: hub가 없으면 headless", () => {
  const result = selectExecutionMode({ cli: "codex", hasHub: false });
  assert.equal(result.mode, MODES.HEADLESS);
  assert.match(result.reason, /requires hub/u);
});

test("selectExecutionMode: gemini는 항상 headless", () => {
  const result = selectExecutionMode({
    cli: "gemini",
    hasHub: true,
    needsInput: true,
    estimatedDuration: 999,
    taskType: "research",
  });
  assert.equal(result.mode, MODES.HEADLESS);
  assert.match(result.reason, /gemini CLI/u);
});

test("selectExecutionMode: implement + no input -> headless", () => {
  const result = selectExecutionMode({
    cli: "codex",
    hasHub: true,
    taskType: "implement",
    needsInput: false,
  });
  assert.equal(result.mode, MODES.HEADLESS);
  assert.match(result.reason, /implementation/u);
});

test("selectExecutionMode: review -> headless", () => {
  const result = selectExecutionMode({
    cli: "codex",
    hasHub: true,
    taskType: "review",
    needsInput: false,
  });
  assert.equal(result.mode, MODES.HEADLESS);
  assert.match(result.reason, /review and analyze/u);
});

test("selectExecutionMode: analyze -> headless", () => {
  const result = selectExecutionMode({
    cli: "claude",
    hasHub: true,
    taskType: "analyze",
    needsInput: false,
  });
  assert.equal(result.mode, MODES.HEADLESS);
  assert.match(result.reason, /review and analyze/u);
});

test("selectExecutionMode: needsInput이면 interactive", () => {
  const result = selectExecutionMode({
    cli: "codex",
    hasHub: true,
    taskType: "research",
    needsInput: true,
    estimatedDuration: 120,
  });
  assert.equal(result.mode, MODES.INTERACTIVE);
  assert.match(result.reason, /operator input/u);
});

test("selectExecutionMode: 장시간 작업이면 interactive", () => {
  const result = selectExecutionMode({
    cli: "codex",
    hasHub: true,
    taskType: "test",
    needsInput: false,
    estimatedDuration: 301,
  });
  assert.equal(result.mode, MODES.INTERACTIVE);
  assert.match(result.reason, /long-running/u);
});

test("selectExecutionMode: 기본값은 headless", () => {
  const result = selectExecutionMode({
    cli: "claude",
    hasHub: true,
    taskType: "research",
    needsInput: false,
    estimatedDuration: 300,
  });
  assert.equal(result.mode, MODES.HEADLESS);
  assert.match(result.reason, /defaulting/u);
});

test("selectExecutionMode: review는 needsInput보다 우선해 headless", () => {
  const result = selectExecutionMode({
    cli: "codex",
    hasHub: true,
    taskType: "review",
    needsInput: true,
    estimatedDuration: 999,
  });
  assert.equal(result.mode, MODES.HEADLESS);
});

test("buildCommandForMode: codex headless command", () => {
  const result = buildCommandForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "fix bug",
  });
  assert.equal(result.useExec, true);
  assert.equal(
    result.command,
    'codex exec "fix bug" -s danger-full-access --dangerously-bypass-approvals-and-sandbox',
  );
});

test("buildCommandForMode: interactive codex command", () => {
  const result = buildCommandForMode(MODES.INTERACTIVE, {
    cli: "codex",
    prompt: "ignored",
  });
  assert.deepEqual(result, { command: "codex", useExec: false });
});

test("buildCommandForMode: interactive claude command", () => {
  const result = buildCommandForMode(MODES.INTERACTIVE, {
    cli: "claude",
    prompt: "ignored",
  });
  assert.deepEqual(result, { command: "claude", useExec: false });
});

test("buildCommandForMode: gemini is always prompt headless", () => {
  const result = buildCommandForMode(MODES.INTERACTIVE, {
    cli: "gemini",
    prompt: "summarize logs",
  });
  assert.deepEqual(result, {
    command: 'gemini -p "summarize logs"',
    useExec: true,
  });
});
