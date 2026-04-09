#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");

function runBash(command) {
  return spawnSync("bash", ["-lc", command], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      TFX_TEAM_NAME: "",
      TFX_TEAM_TASK_ID: "",
      TFX_TEAM_AGENT_NAME: "",
      TFX_TEAM_LEAD_NAME: "",
      TFX_HUB_URL: "",
      TMUX: "",
    },
  });
}

function out(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

test("gemini 모드에서는 no-claude-native 강제 치환이 적용되지 않는다", () => {
  const result = runBash(
    "TFX_CLI_MODE=gemini TFX_NO_CLAUDE_NATIVE=1 bash scripts/tfx-route.sh explore 'test-case'",
  );

  assert.equal(result.status, 0, out(result));
  assert.match(out(result), /ROUTE_TYPE=claude-native/, out(result));
});

test("auto 모드 + no-claude-native=1이면 explore가 codex로 치환된다", () => {
  const result = runBash(
    "TFX_CLI_MODE=auto TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=true bash scripts/tfx-route.sh explore 'test-case' minimal 5",
  );

  assert.equal(result.status, 0, out(result));
  assert.match(
    out(result),
    /TFX_NO_CLAUDE_NATIVE=1: explore -> codex/,
    out(result),
  );
  assert.match(out(result), /type=codex|cli:\\s*codex/i, out(result));
});

test("TFX_NO_CLAUDE_NATIVE는 0/1 값만 허용한다", () => {
  const result = runBash(
    "TFX_NO_CLAUDE_NATIVE=2 bash scripts/tfx-route.sh explore 'test-case'",
  );

  assert.notEqual(result.status, 0, out(result));
  assert.match(out(result), /0 또는 1/, out(result));
});
