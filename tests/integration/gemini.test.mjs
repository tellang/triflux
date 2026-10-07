// TFX_CLI_MODE=gemini 호환 별칭의 두 실행 경로만 검증한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { hubServerTestEnv } from "../fixtures/hub-test-env.mjs";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ROUTE_SCRIPT = toBashPath(
  resolve(PROJECT_ROOT, "scripts", "tfx-route.sh"),
);
const FIXTURE_BIN = toBashPath(
  resolve(PROJECT_ROOT, "tests", "fixtures", "bin"),
);
const HUB_ENSURE_STUB = resolve(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "no-op-hub-ensure.mjs",
);

function runRoute(agent, extraEnv = {}) {
  const testHome = mkdtempSync(resolve(tmpdir(), "triflux-gemini-alias-"));
  try {
    return spawnSync(BASH_EXE, [ROUTE_SCRIPT, agent, "gemini-alias-test"], {
      cwd: testHome,
      encoding: "utf8",
      timeout: 30_000,
      env: hubServerTestEnv({
        HOME: testHome,
        CODEX_HOME: resolve(testHome, ".codex"),
        TFX_CODEX_HOME: resolve(testHome, ".codex"),
        TFX_CODEX_AUTH_FILE: "",
        TMPDIR: testHome,
        TMP: testHome,
        TEMP: testHome,
        XDG_CONFIG_HOME: resolve(testHome, ".config"),
        TFX_MACHINE_PROFILE_PATH: resolve(
          testHome,
          ".config",
          "triflux",
          "machine-profile.env",
        ),
        PATH: `${FIXTURE_BIN}:${process.env.PATH || ""}`,
        TFX_TEAM_NAME: "",
        TFX_TEAM_TASK_ID: "",
        TFX_TEAM_AGENT_NAME: "",
        TFX_TEAM_LEAD_NAME: "",
        TFX_HUB_URL: "",
        TFX_HUB_ENSURE_SCRIPT: HUB_ENSURE_STUB,
        TMUX: "",
        TFX_CLI_MODE: "gemini",
        TFX_PREFLIGHT_LOADED: "1",
        TFX_MCP_HEALTH_CHECK: "0",
        TFX_NO_CLAUDE_NATIVE: "0",
        TFX_CODEX_TRANSPORT: "exec",
        TFX_CTO_NORTH_STAR: "0",
        TFX_WORKER_INDEX: "",
        TFX_SEARCH_TOOL: "",
        ...extraEnv,
      }),
    });
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

it("gemini 모드의 executor는 agy로 실행된다", () => {
  const result = runRoute("executor", {
    TFX_ANTIGRAVITY_OK: "1",
    AGY_BIN: "agy",
  });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /TFX_CLI_MODE=gemini → antigravity/);
  assert.match(output(result), /type=antigravity/);
  assert.match(output(result), /AGY:gemini-alias-test/);
});

it("gemini 모드의 explore는 claude-native를 유지한다", () => {
  const result = runRoute("explore");
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /ROUTE_TYPE=claude-native/);
});
