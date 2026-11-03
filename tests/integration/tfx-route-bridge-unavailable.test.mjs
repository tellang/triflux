import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { routeTestEnv } from "../fixtures/route-test-env.mjs";
import { BASH_EXE } from "../helpers/bash-path.mjs";
import { makeIsolatedCodexConfig } from "../helpers/codex-config-fixture.mjs";

it("bridge 가 실패해도 team 결과를 로컬에 남긴다", () => {
  const route = resolve("scripts/tfx-route.sh");
  const config = makeIsolatedCodexConfig();
  const dir = mkdtempSync(join(tmpdir(), "tfx-bridge-unavailable-"));
  const log = join(dir, "calls.jsonl");
  const bridge = join(dir, "bridge.mjs");
  writeFileSync(
    bridge,
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.BRIDGE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`,
  );
  try {
    const result = spawnSync(
      BASH_EXE,
      [route, "executor", "unavailable-bridge", "minimal", "5"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30000,
        env: routeTestEnv({
          PATH: `${resolve("tests/fixtures/bin")}:${process.env.PATH || ""}`,
          HOME: config.dir,
          CODEX_HOME: config.dir,
          USERPROFILE: config.dir,
          XDG_CONFIG_HOME: join(config.dir, ".config"),
          TFX_MACHINE_PROFILE_PATH: join(config.dir, "machine-profile.env"),
          TFX_CODEX_CONFIG: config.path,
          TFX_CODEX_TRANSPORT: "exec",
          TFX_CODEX_OK: "1",
          TFX_ANTIGRAVITY_OK: "0",
          TFX_PREFLIGHT_LOADED: "1",
          TFX_MCP_HEALTH_CHECK: "0",
          FAKE_CODEX_MODE: "exec",
          TFX_BRIDGE_SCRIPT: bridge,
          BRIDGE_LOG: log,
          TFX_TEAM_NAME: "unavailable-team",
          TFX_TEAM_TASK_ID: "task-1",
          TFX_TEAM_AGENT_NAME: "executor-worker",
          TFX_RESULT_DIR: dir,
        }),
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["team-task-update", "team-send-message"],
    );
    const backup = JSON.parse(readFileSync(join(dir, "task-1.json"), "utf8"));
    assert.equal(backup.result, "success");
    assert.match(backup.summary, /^EXEC:unavailable-bridge/);
  } finally {
    config.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
