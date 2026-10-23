import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { routeTestEnv } from "../fixtures/route-test-env.mjs";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const ROUTE_SCRIPT = toBashPath(
  resolve(PROJECT_ROOT, "scripts", "tfx-route.sh"),
);
const FIXTURE_BIN = toBashPath(
  resolve(PROJECT_ROOT, "tests", "fixtures", "bin"),
);

function createRouteHome() {
  const home = mkdtempSync(join(tmpdir(), "tfx-route-agy-home-"));
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "config.toml"), "", "utf8");
  return home;
}

let home;
before(() => {
  home = createRouteHome();
});
after(() => rmSync(home, { recursive: true, force: true }));

function runBash(command, extraEnv = {}) {
  return spawnSync(BASH_EXE, ["-c", command], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: routeTestEnv({
      PATH: `${FIXTURE_BIN}:${process.env.PATH || ""}`,
      AGY_BIN: "agy",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      TFX_MACHINE_PROFILE_PATH: join(home, "machine-profile.env"),
      TFX_TEAM_NAME: "",
      TFX_TEAM_TASK_ID: "",
      TFX_TEAM_AGENT_NAME: "",
      TFX_TEAM_LEAD_NAME: "",
      TMUX: "",
      TFX_CLI_MODE: "auto",
      TFX_NO_CLAUDE_NATIVE: "0",
      // Route fixtures must not inherit preflight observations from the runner.
      // This file's route assertions all exercise the Antigravity path.
      TFX_PREFLIGHT_LOADED: "1",
      TFX_CODEX_OK: "0",
      TFX_ANTIGRAVITY_OK: "1",
      TFX_DISABLE_CODEX: "0",
      TFX_DISABLE_ANTIGRAVITY: "0",
      TFX_CODEX_TRANSPORT: "exec",
      TFX_MCP_HEALTH_CHECK: "0",
      // 프롬프트 전달 검증에는 heartbeat 대기가 필요 없다.
      TFX_HEARTBEAT: "0",
      ...extraEnv,
    }),
  });
}

function out(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

test("tfx-route.sh routes Antigravity through agy --print stdin", () => {
  const result = runBash(
    `bash "${ROUTE_SCRIPT}" antigravity 'Return exactly: AGY_OK' minimal 120`,
  );

  assert.equal(result.status, 0, out(result));
  assert.match(out(result), /type=antigravity/);
  assert.match(result.stdout, /AGY_OK/);
  assert.doesNotMatch(out(result), /ROUTE_TYPE=claude-native/);
});

test("TFX_CLI_MODE=antigravity remaps codex-routed agents to agy", () => {
  const result = runBash(
    `TFX_CLI_MODE=antigravity bash "${ROUTE_SCRIPT}" executor 'Return exactly: AGY_OK' minimal 120`,
  );

  assert.equal(result.status, 0, out(result));
  assert.match(out(result), /TFX_CLI_MODE=antigravity: executor/);
  assert.match(out(result), /type=antigravity/);
  assert.match(result.stdout, /AGY_OK/);
});
