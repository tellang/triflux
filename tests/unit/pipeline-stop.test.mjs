import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  ensurePipelineStateDbPath,
  ensurePipelineTable,
  initPipelineState,
  updatePipelineState,
} from "../../hub/pipeline/state.mjs";

const HOOK_PATH = fileURLToPath(
  new URL("../../hooks/pipeline-stop.mjs", import.meta.url),
);

function createValidPluginRoot(baseDir, name = "plugin-root") {
  const root = join(baseDir, name);
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(
    join(root, "hooks", "hook-orchestrator.mjs"),
    "// sentinel\n",
    "utf8",
  );
  return root;
}

function writePipelineState(baseDir, teamName, phase = "exec") {
  const dbPath = ensurePipelineStateDbPath(baseDir);
  const db = new Database(dbPath);
  ensurePipelineTable(db);
  initPipelineState(db, teamName);
  updatePipelineState(db, teamName, { phase });
  db.close();
  return dbPath;
}

function contextPayload(percent, overrides = {}) {
  return {
    hook_event_name: "Stop",
    session_id: "session-test",
    stop_reason: "end_turn",
    context_window: {
      used_percentage: percent,
      context_window_size: 1000,
      current_usage: { input_tokens: percent * 10 },
    },
    ...overrides,
  };
}

function runHook({ cwd, homeDir, pluginRoot, input = null, env = {} }) {
  const {
    CLAUDE_CWD: _claudeCwd,
    TRIFLUX_CONTEXT_GUARD_STATE_DIR: _contextGuardStateDir,
    ...baseEnv
  } = process.env;

  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    input: input ? JSON.stringify(input) : undefined,
    encoding: "utf8",
    env: {
      ...baseEnv,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CWD: cwd,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      ...env,
    },
  });
}

function parseStdout(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr.trim(), "");
  assert.notEqual(result.stdout.trim(), "");
  return JSON.parse(result.stdout);
}

describe("pipeline-stop hook", () => {
  let sandboxDir;
  let homeDir;
  let pluginRoot;
  let projectRoot;
  let guardStateDir;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-pipeline-stop-"));
    homeDir = join(sandboxDir, "home");
    pluginRoot = createValidPluginRoot(sandboxDir);
    projectRoot = join(sandboxDir, "project-root");
    guardStateDir = join(sandboxDir, "context-guard-state");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("현재 프로젝트에 DB가 없으면 플러그인 루트의 stale pipeline을 무시한다", () => {
    writePipelineState(pluginRoot, "plugin-stale-team", "exec");

    const result = runHook({ cwd: projectRoot, homeDir, pluginRoot });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  });

  it("현재 프로젝트의 active pipeline만 보고 stop decision을 반환한다", () => {
    writePipelineState(projectRoot, "project-active-team", "exec");

    const result = runHook({ cwd: projectRoot, homeDir, pluginRoot });

    const output = parseStdout(result);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /project-active-team/);
  });

  it("컨텍스트 사용량이 임계값 미만이면 stop을 조용히 허용한다", () => {
    const result = runHook({
      cwd: projectRoot,
      homeDir,
      pluginRoot,
      input: contextPayload(74, { session_id: "below-threshold" }),
      env: { TRIFLUX_CONTEXT_GUARD_STATE_DIR: guardStateDir },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  });

  it("컨텍스트 사용량이 높으면 최대 2회만 context guard로 block한다", () => {
    const env = { TRIFLUX_CONTEXT_GUARD_STATE_DIR: guardStateDir };
    const input = contextPayload(85, { session_id: "retry-capped-session" });

    const first = parseStdout(
      runHook({ cwd: projectRoot, homeDir, pluginRoot, input, env }),
    );
    const second = parseStdout(
      runHook({ cwd: projectRoot, homeDir, pluginRoot, input, env }),
    );
    const third = runHook({
      cwd: projectRoot,
      homeDir,
      pluginRoot,
      input,
      env,
    });

    assert.equal(first.decision, "block");
    assert.match(first.reason, /context/i);
    assert.match(first.reason, /Block 1\/2/);
    assert.equal(second.decision, "block");
    assert.match(second.reason, /Block 2\/2/);
    assert.equal(third.status, 0);
    assert.equal(third.stdout.trim(), "");
    assert.equal(third.stderr.trim(), "");
  });

  it("context_limit stop reason은 높은 컨텍스트에서도 block하지 않는다", () => {
    const result = runHook({
      cwd: projectRoot,
      homeDir,
      pluginRoot,
      input: contextPayload(88, {
        session_id: "context-limit-pass-through",
        stop_reason: "context_limit",
      }),
      env: { TRIFLUX_CONTEXT_GUARD_STATE_DIR: guardStateDir },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  });

  it("사용자 abort/cancel stop reason은 높은 컨텍스트에서도 block하지 않는다", () => {
    const result = runHook({
      cwd: projectRoot,
      homeDir,
      pluginRoot,
      input: contextPayload(88, {
        session_id: "user-abort-pass-through",
        stop_reason: "user_interrupt",
        user_requested: true,
      }),
      env: { TRIFLUX_CONTEXT_GUARD_STATE_DIR: guardStateDir },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  });

  it("critical context exhaustion에서는 compaction deadlock을 피하려고 fail-open 한다", () => {
    const result = runHook({
      cwd: projectRoot,
      homeDir,
      pluginRoot,
      input: contextPayload(96, { session_id: "critical-pass-through" }),
      env: { TRIFLUX_CONTEXT_GUARD_STATE_DIR: guardStateDir },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  });

  it("context guard state write failure 후에도 active pipeline block 동작은 유지한다", () => {
    writePipelineState(projectRoot, "project-active-team", "exec");
    const guardStateFile = join(sandboxDir, "context-guard-state-file");
    writeFileSync(guardStateFile, "not a directory", "utf8");

    const output = parseStdout(
      runHook({
        cwd: projectRoot,
        homeDir,
        pluginRoot,
        input: contextPayload(85, {
          session_id: "state-write-failure-active-pipeline",
        }),
        env: { TRIFLUX_CONTEXT_GUARD_STATE_DIR: guardStateFile },
      }),
    );

    assert.equal(output.decision, "block");
    assert.match(output.reason, /project-active-team/);
  });

  it("retry cap 이후에도 active pipeline block 동작은 유지한다", () => {
    const env = { TRIFLUX_CONTEXT_GUARD_STATE_DIR: guardStateDir };
    const input = contextPayload(85, { session_id: "retry-cap-then-pipeline" });

    const first = parseStdout(
      runHook({ cwd: projectRoot, homeDir, pluginRoot, input, env }),
    );
    const second = parseStdout(
      runHook({ cwd: projectRoot, homeDir, pluginRoot, input, env }),
    );

    assert.equal(first.decision, "block");
    assert.match(first.reason, /context/i);
    assert.match(first.reason, /Block 1\/2/);
    assert.equal(second.decision, "block");
    assert.match(second.reason, /Block 2\/2/);

    writePipelineState(projectRoot, "project-active-team", "exec");

    const afterCap = parseStdout(
      runHook({ cwd: projectRoot, homeDir, pluginRoot, input, env }),
    );

    assert.equal(afterCap.decision, "block");
    assert.match(afterCap.reason, /project-active-team/);
  });
});
