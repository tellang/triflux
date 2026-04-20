import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommandForMode,
  buildSpawnSpecForMode,
  MODES,
  resolveCliExecutable,
  selectExecutionMode,
  unwrapCmdToJsScript,
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

// ── resolveCliExecutable: Windows .cmd/.exe fallback (#108 follow-up) ──
// String.raw: biome auto-fix 가 "redundant escape" 로 판단해 \\n / \\c 를 파괴하는 것을 방지.

test("resolveCliExecutable: win32 appends .cmd when resolved path has no extension", () => {
  const result = resolveCliExecutable("codex", {
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\codex`,
    existsSyncFn: (p) => p === String.raw`C:\npm\codex.cmd`,
  });
  assert.equal(result, String.raw`C:\npm\codex.cmd`);
});

test("resolveCliExecutable: win32 prefers .cmd over .exe", () => {
  const result = resolveCliExecutable("codex", {
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\codex`,
    existsSyncFn: (p) =>
      p === String.raw`C:\npm\codex.cmd` || p === String.raw`C:\npm\codex.exe`,
  });
  assert.equal(result, String.raw`C:\npm\codex.cmd`);
});

test("resolveCliExecutable: win32 falls back to .exe if .cmd missing", () => {
  const result = resolveCliExecutable("codex", {
    platform: "win32",
    resolveCommand: () => String.raw`C:\tools\mytool`,
    existsSyncFn: (p) => p === String.raw`C:\tools\mytool.exe`,
  });
  assert.equal(result, String.raw`C:\tools\mytool.exe`);
});

test("resolveCliExecutable: win32 keeps path if already has extension", () => {
  const result = resolveCliExecutable("codex", {
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\codex.cmd`,
    existsSyncFn: () => true,
  });
  assert.equal(result, String.raw`C:\npm\codex.cmd`);
});

test("resolveCliExecutable: non-win32 platform leaves path as-is", () => {
  const result = resolveCliExecutable("codex", {
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/codex",
    existsSyncFn: () => true,
  });
  assert.equal(result, "/usr/local/bin/codex");
});

test("resolveCliExecutable: win32 returns extensionless if no extension variant exists", () => {
  const result = resolveCliExecutable("weirdtool", {
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\weirdtool`,
    existsSyncFn: () => false,
  });
  assert.equal(result, String.raw`C:\npm\weirdtool`);
});

// #128 BUG-A: cmd /c wrapper mangles multi-line/fenced prompts.
// Bypass cmd by unwrapping .cmd to its underlying .js and spawning node directly.
test("unwrapCmdToJsScript: extracts .js path from npm-cmd-shim", () => {
  const fakeCmdContent = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;
  const result = unwrapCmdToJsScript(String.raw`C:\npm\codex.cmd`, {
    readFile: () => fakeCmdContent,
    existsSyncFn: () => true,
  });
  assert.ok(
    result &&
      result.toLowerCase().endsWith("codex.js") &&
      result.toLowerCase().includes("@openai"),
    `expected codex.js path, got: ${result}`,
  );
});

test("unwrapCmdToJsScript: returns null when .cmd has no parsable .js", () => {
  const result = unwrapCmdToJsScript(String.raw`C:\npm\foo.cmd`, {
    readFile: () => "@echo unrelated content\n",
    existsSyncFn: () => true,
  });
  assert.equal(result, null);
});

test("unwrapCmdToJsScript: returns null when .js does not exist on disk", () => {
  const fakeCmdContent = `endLocal & ... "%dp0%\\node_modules\\foo\\bar.js" %*\n`;
  const result = unwrapCmdToJsScript(String.raw`C:\npm\foo.cmd`, {
    readFile: () => fakeCmdContent,
    existsSyncFn: () => false,
  });
  assert.equal(result, null);
});

test("buildSpawnSpecForMode: win32 + .cmd uses node + .js (cmd /c bypass)", () => {
  // 회귀 방지 #128 BUG-A: cmd /c wrap 경로가 prompt truncation 의 원인이었음
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "no-op probe.\n\n```bash\necho ok\n```\n",
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\codex.cmd`,
    existsSyncFn: () => true,
    unwrapCmdFn: () =>
      String.raw`C:\npm\node_modules\@openai\codex\bin\codex.js`,
    nodeExecPath: String.raw`C:\nodejs\node.exe`,
  });
  assert.equal(spec.command, String.raw`C:\nodejs\node.exe`);
  assert.equal(
    spec.args[0],
    String.raw`C:\npm\node_modules\@openai\codex\bin\codex.js`,
  );
  assert.ok(spec.args.includes("exec"), "exec arg must be present");
  const lastArg = spec.args[spec.args.length - 1];
  assert.ok(lastArg.includes("```bash"), "fenced bash block must survive");
  assert.ok(lastArg.includes("\n"), "newline must survive in args");
});

test("buildSpawnSpecForMode: win32 + .cmd falls back to cmd /c when unwrap fails", () => {
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "test",
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\codex.cmd`,
    existsSyncFn: () => true,
    unwrapCmdFn: () => null,
  });
  assert.equal(spec.command, "cmd");
  assert.equal(spec.args[0], "/c");
  assert.equal(spec.args[1], String.raw`C:\npm\codex.cmd`);
});
