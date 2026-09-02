import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import {
  buildSpawnSpecForMode,
  MODES,
  resolveCliExecutable,
  resolveStdinPromptMode,
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

test("selectExecutionMode: gemini alias는 Antigravity headless", () => {
  const result = selectExecutionMode({
    cli: "gemini",
    hasHub: true,
    needsInput: true,
    estimatedDuration: 999,
    taskType: "research",
  });
  assert.equal(result.mode, MODES.HEADLESS);
  assert.match(result.reason, /antigravity CLI/u);
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

// buildCommandForMode 관련 4 테스트는 본 함수가 dead code 로 제거되면서 동반
// 삭제됨 (v10.20.x). 회귀 가드: tests/unit/multiplexer-resolution.test.mjs
// 의 `execution-mode.mjs: dead buildCommandForMode 제거` 가 export 부재를
// assert. headless spawn 의 실 동작 검증은 buildSpawnSpecForMode 관련 테스트
// (하단) + tests/unit/codex-adapter.test.mjs:buildExecArgs 가 담당.

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
    result?.toLowerCase().endsWith("codex.js") &&
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

test("buildSpawnSpecForMode: win32 + .cmd uses node + .js (cmd /c bypass, legacy stdinPrompt=false)", () => {
  // 회귀 방지 #128 BUG-A: cmd /c wrap 경로가 prompt truncation 의 원인이었음.
  // stdinPrompt=false 강제 (legacy argv-inline) 회귀 가드.
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "no-op probe.\n\n```bash\necho ok\n```\n",
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\codex.cmd`,
    existsSyncFn: () => true,
    unwrapCmdFn: () =>
      String.raw`C:\npm\node_modules\@openai\codex\bin\codex.js`,
    nodeExecPath: String.raw`C:\nodejs\node.exe`,
    stdinPrompt: false,
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
  assert.notEqual(spec.stdinPrompt, true);
});

test("buildSpawnSpecForMode: win32 + .cmd falls back to cmd /c when unwrap fails (legacy stdinPrompt=false)", () => {
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "test",
    platform: "win32",
    resolveCommand: () => String.raw`C:\npm\codex.cmd`,
    existsSyncFn: () => true,
    unwrapCmdFn: () => null,
    stdinPrompt: false,
  });
  assert.equal(spec.command, "cmd");
  assert.equal(spec.args[0], "/c");
  assert.equal(spec.args[1], String.raw`C:\npm\codex.cmd`);
});

// ── #116-C: stdin transport for codex headless prompt ────────────────────

test("resolveStdinPromptMode: explicit boolean wins", () => {
  assert.equal(resolveStdinPromptMode(true, {}), true);
  assert.equal(resolveStdinPromptMode(false, {}), false);
  assert.equal(
    resolveStdinPromptMode(false, { TFX_CODEX_STDIN_PROMPT: "1" }),
    false,
  );
});

test("resolveStdinPromptMode: default true; env=0|false opts out", () => {
  assert.equal(resolveStdinPromptMode(undefined, {}), true);
  assert.equal(
    resolveStdinPromptMode(undefined, { TFX_CODEX_STDIN_PROMPT: "0" }),
    false,
  );
  assert.equal(
    resolveStdinPromptMode(undefined, { TFX_CODEX_STDIN_PROMPT: "false" }),
    false,
  );
  assert.equal(
    resolveStdinPromptMode(undefined, { TFX_CODEX_STDIN_PROMPT: "1" }),
    true,
  );
});

test("buildSpawnSpecForMode: codex skips MCP servers excluded by preflight and warns", () => {
  const warnings = [];
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "ACK",
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/codex",
    env: {},
    mcpServers: ["context7", "missing-server"],
    excludeMcpServers: ["missing-server"],
    onWarning: (message, details) => warnings.push({ message, details }),
  });

  assert.ok(
    spec.args.includes("mcp_servers.context7.enabled=true"),
    "known MCP server should still be enabled",
  );
  assert.ok(
    !spec.args.includes("mcp_servers.missing-server.enabled=true"),
    "unknown MCP server must be skipped before building codex command",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /missing-server/u);
  assert.equal(warnings[0].details.server, "missing-server");
});

test("buildSpawnSpecForMode: codex headless default uses stdinPrompt (prompt out of args)", () => {
  const prompt = "Please respond ACK.\n\n```bash\necho ok\n```\n";
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt,
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/codex",
    env: {},
  });
  assert.equal(spec.stdinPrompt, true);
  assert.equal(spec.prompt, prompt);
  assert.equal(spec.command, "/usr/local/bin/codex");
  assert.ok(spec.args.includes("exec"), "exec arg must be present");
  for (const a of spec.args) {
    assert.notEqual(
      a,
      prompt,
      "prompt must not appear in args when stdinPrompt=true",
    );
  }
});

test("buildSpawnSpecForMode: nested Codex gets an explicit role profile", () => {
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "ACK",
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/codex",
    env: {},
  });

  assert.ok(spec.args.includes('model_reasoning_effort="high"'));
  assert.ok(!spec.args.includes('model_reasoning_effort="ultra"'));
});

test("buildSpawnSpecForMode: nested Codex downgrades env ultra to max", () => {
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "ACK",
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/codex",
    env: { TFX_CODEX_PROFILE: "ultra" },
  });

  assert.ok(spec.args.includes('model_reasoning_effort="max"'));
  assert.ok(!spec.args.includes('model_reasoning_effort="ultra"'));
});

test("buildSpawnSpecForMode: empty session env still inherits and guards process ultra", () => {
  const previous = process.env.TFX_CODEX_PROFILE;
  try {
    process.env.TFX_CODEX_PROFILE = "ultra";
    const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
      cli: "codex",
      prompt: "ACK",
      platform: "linux",
      resolveCommand: () => "/usr/local/bin/codex",
      env: {},
    });

    assert.ok(spec.args.includes('model_reasoning_effort="max"'));
    assert.ok(!spec.args.includes('model_reasoning_effort="ultra"'));
  } finally {
    if (previous === undefined) delete process.env.TFX_CODEX_PROFILE;
    else process.env.TFX_CODEX_PROFILE = previous;
  }
});

test("buildSpawnSpecForMode: custom nested profiles cannot hide ultra or inherit globals", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "tfx-nested-profile-"));
  try {
    writeFileSync(
      join(codexHome, "private.config.toml"),
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n',
    );
    writeFileSync(
      join(codexHome, "gpt56_sol_max.config.toml"),
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n',
    );
    const customUltra = buildSpawnSpecForMode(MODES.HEADLESS, {
      cli: "codex",
      prompt: "ACK",
      profile: "private",
      platform: "linux",
      resolveCommand: () => "/usr/local/bin/codex",
      env: { CODEX_HOME: codexHome },
    });
    const missingCustom = buildSpawnSpecForMode(MODES.HEADLESS, {
      cli: "codex",
      prompt: "ACK",
      profile: "missing-private",
      platform: "linux",
      resolveCommand: () => "/usr/local/bin/codex",
      env: { CODEX_HOME: codexHome },
    });

    assert.ok(customUltra.args.includes('model_reasoning_effort="max"'));
    assert.ok(!customUltra.args.includes('model_reasoning_effort="ultra"'));
    assert.ok(missingCustom.args.includes('model_reasoning_effort="high"'));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("buildSpawnSpecForMode: codex headless TFX_CODEX_STDIN_PROMPT=0 falls back to argv-inline", () => {
  const prompt = "argv-inline legacy";
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt,
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/codex",
    env: { TFX_CODEX_STDIN_PROMPT: "0" },
  });
  assert.notEqual(spec.stdinPrompt, true);
  assert.equal(spec.args[spec.args.length - 1], prompt);
});

test("buildSpawnSpecForMode: codex headless empty prompt falls back to argv-inline (avoid empty stdin EOF)", () => {
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "codex",
    prompt: "",
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/codex",
    env: {},
  });
  assert.notEqual(spec.stdinPrompt, true);
  assert.equal(spec.args[spec.args.length - 1], "");
});

test("buildSpawnSpecForMode: gemini alias uses agy stdin print mode", () => {
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "gemini",
    prompt: "ACK",
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/agy",
    env: {},
  });
  assert.equal(spec.command, "/usr/local/bin/agy");
  assert.equal(spec.stdinPrompt, true);
  assert.deepEqual(spec.args, ["--print", "--dangerously-skip-permissions"]);
  assert.equal(spec.prompt, "ACK");
});

test("buildSpawnSpecForMode: claude headless ignores stdinPrompt (keeps -p flag)", () => {
  const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
    cli: "claude",
    prompt: "ACK",
    platform: "linux",
    resolveCommand: () => "/usr/local/bin/claude",
    env: {},
  });
  assert.notEqual(spec.stdinPrompt, true);
  assert.ok(spec.args.includes("-p"));
  assert.equal(spec.args[spec.args.indexOf("-p") + 1], "ACK");
});

// ── TFX_DISABLE_* spawn 게이트 ──────────────────────────────────────────────
// 정책 판독을 policyEnv 로 밀폐한다. env 에 키가 있으면 리더가 machine profile
// 파일을 읽지 않으므로 이 머신의 실제 프로파일과 무관하게 결정된다.
describe("buildSpawnSpecForMode: TFX_DISABLE_* 게이트", () => {
  const ENABLED = { TFX_DISABLE_CODEX: "0", TFX_DISABLE_ANTIGRAVITY: "0" };

  it("codex disabled 면 spec 대신 명시 오류를 던진다", () => {
    let thrown = null;
    try {
      buildSpawnSpecForMode(MODES.HEADLESS, {
        cli: "codex",
        prompt: "ACK",
        platform: "linux",
        resolveCommand: () => "/usr/local/bin/codex",
        env: {},
        policyEnv: { TFX_DISABLE_CODEX: "1", TFX_DISABLE_ANTIGRAVITY: "0" },
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "차단된 codex 요청은 반드시 던져야 한다");
    assert.equal(thrown.code, "TFX_CLI_DISABLED");
    assert.equal(thrown.cli, "codex");
    assert.match(thrown.message, /TFX_DISABLE_CODEX=1/u);
    assert.match(thrown.message, /TFX_DISABLE_CODEX=0/u);
  });

  it("antigravity disabled 면 antigravity 와 agy 둘 다 던진다", () => {
    const policyEnv = { TFX_DISABLE_CODEX: "0", TFX_DISABLE_ANTIGRAVITY: "1" };
    for (const cli of ["antigravity", "agy"]) {
      let thrown = null;
      try {
        buildSpawnSpecForMode(MODES.HEADLESS, {
          cli,
          prompt: "ACK",
          platform: "linux",
          resolveCommand: () => "/usr/local/bin/agy",
          env: {},
          policyEnv,
        });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, `${cli} 요청은 반드시 던져야 한다`);
      assert.equal(thrown.code, "TFX_CLI_DISABLED");
      assert.equal(thrown.cli, "antigravity");
      assert.match(thrown.message, /TFX_DISABLE_ANTIGRAVITY=1/u);
    }
  });

  it("codex disabled 여도 claude 는 게이트 대상이 아니다", () => {
    const spec = buildSpawnSpecForMode(MODES.HEADLESS, {
      cli: "claude",
      prompt: "ACK",
      platform: "linux",
      resolveCommand: () => "/usr/local/bin/claude",
      env: {},
      policyEnv: { TFX_DISABLE_CODEX: "1", TFX_DISABLE_ANTIGRAVITY: "1" },
    });
    assert.equal(spec.command, "/usr/local/bin/claude");
    assert.ok(spec.args.includes("-p"));
  });

  it("둘 다 허용이면 기존 spec 과 동일하다", () => {
    const base = {
      cli: "gemini",
      prompt: "ACK",
      platform: "linux",
      resolveCommand: () => "/usr/local/bin/agy",
      env: {},
    };
    const gated = buildSpawnSpecForMode(MODES.HEADLESS, {
      ...base,
      policyEnv: ENABLED,
    });
    const ungated = buildSpawnSpecForMode(MODES.HEADLESS, {
      ...base,
      cliPolicy: {
        codexDisabled: false,
        antigravityDisabled: false,
        source: { codex: "default", antigravity: "default" },
        profilePath: null,
        warnings: [],
      },
    });
    assert.deepEqual(gated, ungated);
    assert.equal(gated.command, "/usr/local/bin/agy");
    assert.deepEqual(gated.args, ["--print", "--dangerously-skip-permissions"]);
    assert.equal(gated.stdinPrompt, true);
    assert.equal(gated.prompt, "ACK");
  });

  it("계산된 cliPolicy 주입이 policyEnv 보다 우선한다", () => {
    assert.throws(
      () =>
        buildSpawnSpecForMode(MODES.HEADLESS, {
          cli: "codex",
          prompt: "ACK",
          platform: "linux",
          resolveCommand: () => "/usr/local/bin/codex",
          env: {},
          policyEnv: ENABLED,
          cliPolicy: {
            codexDisabled: true,
            antigravityDisabled: false,
            source: { codex: "profile", antigravity: "default" },
            profilePath: "/tmp/machine-profile.env",
            warnings: [],
          },
        }),
      /TFX_DISABLE_CODEX=1/u,
    );
  });
});
