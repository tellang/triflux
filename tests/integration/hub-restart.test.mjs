import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { hubServerTestEnv } from "../fixtures/hub-test-env.mjs";
import { BASH_EXE } from "../helpers/bash-path.mjs";
import { makeIsolatedCodexConfig } from "../helpers/codex-config-fixture.mjs";

it("허브 호출을 재시도하지 않고 team 결과를 로컬에 남긴다", () => {
  const route = resolve("scripts/tfx-route.sh");
  const source = readFileSync(route, "utf8");
  assert.doesNotMatch(
    source,
    /hub-ensure|try_restart_hub|bridge_cli_with_restart|TFX_HUB_OK/,
  );
  assert.doesNotMatch(
    readFileSync(resolve("hub/bridge.mjs"), "utf8"),
    /tryRestartHub|spawn\(/,
  );
  const config = makeIsolatedCodexConfig();
  const dir = mkdtempSync(join(tmpdir(), "tfx-hub-unavailable-"));
  const log = join(dir, "calls.jsonl");
  const ensureMarker = join(dir, "ensure-called");
  const bridge = join(dir, "bridge.mjs");
  const ensure = join(dir, "ensure.mjs");
  writeFileSync(
    bridge,
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.BRIDGE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`,
  );
  writeFileSync(
    ensure,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.ENSURE_MARKER, "called");
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
        env: hubServerTestEnv({
          PATH: `${resolve("tests/fixtures/bin")}:${process.env.PATH || ""}`,
          HOME: config.dir,
          CODEX_HOME: config.dir,
          USERPROFILE: config.dir,
          XDG_CONFIG_HOME: join(config.dir, ".config"),
          TFX_MACHINE_PROFILE_PATH: join(config.dir, "machine-profile.env"),
          TFX_CODEX_CONFIG: config.path,
          TFX_CODEX_TRANSPORT: "exec",
          TFX_CTO_NORTH_STAR: "0",
          TFX_CODEX_OK: "1",
          TFX_ANTIGRAVITY_OK: "0",
          TFX_PREFLIGHT_LOADED: "1",
          TFX_MCP_HEALTH_CHECK: "0",
          FAKE_CODEX_MODE: "exec",
          TFX_BRIDGE_SCRIPT: bridge,
          TFX_HUB_ENSURE_SCRIPT: ensure,
          ENSURE_MARKER: ensureMarker,
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
      ["team-task-update", "team-send-message", "result"],
    );
    const backup = JSON.parse(readFileSync(join(dir, "task-1.json"), "utf8"));
    assert.equal(backup.result, "success");
    assert.match(backup.summary, /^EXEC:unavailable-bridge/);
    assert.throws(() => readFileSync(ensureMarker), { code: "ENOENT" });
  } finally {
    config.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
