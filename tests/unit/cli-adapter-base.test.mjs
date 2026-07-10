import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "triflux-cli-adapter-base-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { root, home, bin };
}

function installFakeCodex(binDir) {
  const jsPath = join(binDir, "codex.js");
  const shPath = join(binDir, "codex");
  const cmdPath = join(binDir, "codex.cmd");

  writeFileSync(
    jsPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { process.stdout.write('codex 0.119.0\\n'); process.exit(0); }",
      "process.exit(0);",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    shPath,
    `#!/bin/sh\nnode "${jsPath.replace(/\\/g, "/")}" "$@"\n`,
    "utf8",
  );
  writeFileSync(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`, "utf8");
  chmodSync(jsPath, 0o755);
  chmodSync(shPath, 0o755);
}

async function withSandbox(fn) {
  const sandbox = makeSandbox();
  installFakeCodex(sandbox.bin);
  const previous = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };

  process.env.PATH = `${sandbox.bin}${delimiter}${process.env.PATH || ""}`;
  process.env.HOME = sandbox.home;
  process.env.USERPROFILE = sandbox.home;

  try {
    await fn(sandbox);
  } finally {
    process.env.PATH = previous.PATH;
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function importFresh(relativePath) {
  return import(`${relativePath}?t=${Date.now()}-${Math.random()}`);
}

function createRunProcessHarness() {
  const child = new EventEmitter();
  child.pid = 42_424;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  let now = 0;
  let stallTick = null;
  let timeoutSchedules = 0;
  let terminations = 0;
  const timerHandle = () => ({ unref() {} });

  return {
    child,
    deps: {
      now: () => now,
      spawn: () => child,
      setTimeout: () => {
        timeoutSchedules += 1;
        return timerHandle();
      },
      clearTimeout: () => {},
      setInterval: (callback) => {
        stallTick = callback;
        return timerHandle();
      },
      clearInterval: () => {},
      terminateChild: async () => {
        terminations += 1;
        child.emit("close", null);
      },
    },
    advanceTo(value) {
      now = value;
    },
    checkStall() {
      assert.ok(stallTick, "runProcess must schedule its stall check");
      stallTick();
    },
    get timeoutSchedules() {
      return timeoutSchedules;
    },
    get terminations() {
      return terminations;
    },
  };
}

async function withActivityLifecycle(fn) {
  const previous = process.env.TFX_ACTIVITY_LIFECYCLE;
  process.env.TFX_ACTIVITY_LIFECYCLE = "1";
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.TFX_ACTIVITY_LIFECYCLE;
    else process.env.TFX_ACTIVITY_LIFECYCLE = previous;
  }
}

test("buildExecCommand: stdin-prompt mode (macOS hook regression fix) keeps argv short", async () => {
  await withSandbox(async () => {
    const base = await importFresh("../../hub/cli-adapter-base.mjs");
    const longPrompt = "x".repeat(4000) + " — long prompt simulation";
    const command = base.buildExecCommand(longPrompt, "/tmp/result.txt", {
      stdinPrompt: true,
    });
    // stdin redirect: command 끝이 `< "/path/to/prompt-*.txt"` 패턴이고
    // 전체 길이가 입력 prompt 길이와 무관하게 짧다.
    assert.ok(
      command.length < 500,
      `stdin-mode command must stay short regardless of prompt size, got ${command.length}`,
    );
    assert.match(
      command,
      /< "[^"]+\/triflux-codex-prompt\/prompt-\d+-\d+-\d+\.txt"$/u,
    );
    assert.ok(!command.includes("xxxxxxxx"), "prompt must NOT be argv-inlined");
  });
});

test("buildExecCommand: empty prompt falls back to argv even in stdin mode", async () => {
  await withSandbox(async () => {
    const base = await importFresh("../../hub/cli-adapter-base.mjs");
    const command = base.buildExecCommand("", "/tmp/result.txt", {
      stdinPrompt: true,
    });
    // 빈 prompt 는 stdin redirect 안 함 (그대로 argv "" 로 inline).
    assert.ok(
      !command.includes("< "),
      `empty prompt should not trigger stdin redirect: ${command}`,
    );
    assert.ok(command.endsWith('""'));
  });
});

test("buildExecCommand: TFX_CODEX_STDIN_PROMPT=0 env opts out of stdin mode", async () => {
  await withSandbox(async () => {
    const prev = process.env.TFX_CODEX_STDIN_PROMPT;
    process.env.TFX_CODEX_STDIN_PROMPT = "0";
    try {
      const base = await importFresh("../../hub/cli-adapter-base.mjs");
      const command = base.buildExecCommand("hello", "/tmp/result.txt", {});
      assert.ok(command.endsWith('"hello"'));
      assert.ok(!command.includes("< "));
    } finally {
      if (prev === undefined) delete process.env.TFX_CODEX_STDIN_PROMPT;
      else process.env.TFX_CODEX_STDIN_PROMPT = prev;
    }
  });
});

test("cli-adapter-base exports the shared codex exec builder and codex-compat re-exports it (legacy argv-inline mode)", async () => {
  await withSandbox(async () => {
    const base = await importFresh("../../hub/cli-adapter-base.mjs");
    const compat = await importFresh("../../hub/codex-compat.mjs");

    // explicit opt-out of the stdin-prompt fix to verify legacy argv-inline
    // shape (matches codex < v0.130 + non-macOS environments).
    const command = base.buildExecCommand("hello", "/tmp/result.txt", {
      profile: "codex53_high",
      cwd: "C:/work/it's-me",
      stdinPrompt: false,
    });

    assert.equal(
      compat.buildExecCommand("hello", "/tmp/result.txt", {
        profile: "codex53_high",
        cwd: "C:/work/it's-me",
        stdinPrompt: false,
      }),
      command,
    );
    // Profile is now selected via `-c` config overrides, not `--profile`
    // (codex 0.134+ rejects --profile X against an inline [profiles.X]).
    assert.doesNotMatch(command, /--profile/);
    assert.match(command, /^codex exec /);
    assert.ok(
      command.includes('-c "model_reasoning_effort=\\"high\\""'),
      `expected -c effort override, got: ${command}`,
    );
    assert.match(command, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(command, /--skip-git-repo-check/);
    assert.match(command, /--output-last-message \/tmp\/result\.txt/);
    assert.match(command, /--color never/);
    assert.ok(
      !command.includes("--cwd"),
      `codex exec should not receive --cwd directly: ${command}`,
    );
    assert.ok(command.endsWith('"hello"'));

    assert.equal(base.escapePwshSingleQuoted("it's"), "it''s");
    assert.equal(compat.escapePwshSingleQuoted("it's"), "it''s");
    assert.equal(base.CODEX_MCP_TRANSPORT_EXIT_CODE, 70);
    assert.equal(base.CODEX_MCP_EXECUTION_EXIT_CODE, 1);
    assert.equal(compat.CODEX_MCP_TRANSPORT_EXIT_CODE, 70);
    assert.equal(compat.CODEX_MCP_EXECUTION_EXIT_CODE, 1);
  });
});

test("runProcess treats resultFile updates as progress during quiet CLI execution", async () => {
  await withActivityLifecycle(() =>
    withSandbox(async ({ root }) => {
      const { runProcess } = await importFresh(
        "../../hub/cli-adapter-base.mjs",
      );
      const resultFile = join(root, "result.txt");
      const harness = createRunProcessHarness();
      const resultPromise = runProcess("ignored", root, 10, {
        resultFile,
        stallCheckIntervalMs: 1,
        stallThresholdMs: 10,
        hardCeilingMs: 100,
        inferStallMode: () => "stall",
        onStallIntervene: () => false,
        deps: harness.deps,
      });

      for (let tick = 1; tick <= 6; tick += 1) {
        harness.advanceTo(tick * 9);
        writeFileSync(resultFile, "x".repeat(tick), "utf8");
        harness.checkStall();
      }
      harness.child.emit("close", 0);
      const result = await resultPromise;

      assert.equal(existsSync(resultFile), true);
      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.failureMode, null);
      assert.equal(result.output, "xxxxxx");
      assert.equal(result.duration, 54);
      assert.equal(harness.timeoutSchedules, 0);
      assert.equal(harness.terminations, 0);
    }),
  );
});

test("runProcess lets active stdout outlive its advisory timeout", async () => {
  await withActivityLifecycle(() =>
    withSandbox(async ({ root }) => {
      const { runProcess } = await importFresh(
        "../../hub/cli-adapter-base.mjs",
      );
      const harness = createRunProcessHarness();
      const resultPromise = runProcess("ignored", root, 10, {
        stallCheckIntervalMs: 1,
        stallThresholdMs: 10,
        hardCeilingMs: 100,
        onStallIntervene: () => false,
        deps: harness.deps,
      });

      for (let tick = 1; tick <= 5; tick += 1) {
        harness.advanceTo(tick * 9);
        harness.child.stdout.emit("data", "tick\n");
        harness.checkStall();
      }
      harness.child.emit("close", 0);
      const result = await resultPromise;

      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.failureMode, null);
      assert.equal(result.output, "tick\n".repeat(5));
      assert.equal(result.duration, 45);
      assert.equal(harness.timeoutSchedules, 0);
      assert.equal(harness.terminations, 0);
    }),
  );
});

test("runProcess terminates only after stdout becomes inactive", async () => {
  await withActivityLifecycle(() =>
    withSandbox(async ({ root }) => {
      const { runProcess } = await importFresh(
        "../../hub/cli-adapter-base.mjs",
      );
      const harness = createRunProcessHarness();
      const resultPromise = runProcess("ignored", root, 10, {
        stallCheckIntervalMs: 1,
        stallThresholdMs: 10,
        hardCeilingMs: 100,
        inferStallMode: () => "stall",
        onStallIntervene: () => false,
        deps: harness.deps,
      });

      harness.advanceTo(9);
      harness.child.stdout.emit("data", "tick\n");
      harness.checkStall();
      assert.equal(harness.terminations, 0);

      harness.advanceTo(19);
      harness.checkStall();
      const result = await resultPromise;

      assert.equal(result.ok, false);
      assert.equal(result.failureMode, "stall");
      assert.equal(result.output, "tick\n");
      assert.equal(result.duration, 19);
      assert.equal(harness.timeoutSchedules, 0);
      assert.equal(harness.terminations, 1);
    }),
  );
});
