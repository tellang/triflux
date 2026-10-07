// Regression coverage for retry snapshot profile plumbing in tfx-route.sh.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ROUTE = path.join(REPO_ROOT, "scripts", "tfx-route.sh");
const BRIDGE = path.join(REPO_ROOT, "hub", "bridge.mjs");

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "tfx-route-retry-profile-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function writeExecutable(file, body) {
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
}

function writeRetrySnapshot(file, profile) {
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      current: "EXECUTING",
      iterations: 1,
      maxIterations: 3,
      stuckCounter: 0,
      lastFailureReason: null,
      cliIndex: 0,
      cliChain: [{ cli: "codex", model: "gpt-5.5", profile }],
      mode: "auto-escalate",
      sessionId: null,
      history: [],
    }),
    "utf8",
  );
}

let fixture;
before(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "tfx-route-retry-profile-"));
  const binDir = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const tfxTmp = path.join(dir, "tmp");
  const capture = path.join(dir, "codex-args.json");
  const fakeCodex = path.join(binDir, "codex");
  const fakeHubEnsure = path.join(
    REPO_ROOT,
    "tests/fixtures/no-op-hub-ensure.mjs",
  );

  mkdirSync(binDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  mkdirSync(tfxTmp, { recursive: true });
  writeFileSync(path.join(dir, ".keep"), "");
  writeExecutable(
    fakeCodex,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "codex-cli 0.134.0"
  exit 0
fi
node - "$@" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.env.TFX_CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));
NODE
cat >/dev/null || true
echo "fake codex ok"
`,
  );

  fixture = { dir, binDir, home, tfxTmp, capture, fakeCodex, fakeHubEnsure };
});
after(() => rmSync(fixture.dir, { recursive: true, force: true }));

function runRoute({
  snapshot,
  agent = "executor",
  env: envOverrides = {},
  profileFiles = {},
} = {}) {
  const { binDir, home, tfxTmp, capture, fakeCodex, fakeHubEnsure } = fixture;
  // 공유 준비가 이전 실행의 프로파일과 argv를 남기지 않게 한다.
  rmSync(path.join(home, ".codex"), { recursive: true, force: true });
  mkdirSync(path.join(home, ".codex"));
  rmSync(capture, { force: true });
  for (const [name, content] of Object.entries(profileFiles)) {
    writeFileSync(path.join(home, ".codex", `${name}.config.toml`), content);
  }

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    HOME: home,
    CODEX_BIN: fakeCodex,
    TFX_BRIDGE_SCRIPT: BRIDGE,
    TFX_CAPTURE_ARGS: capture,
    TFX_CODEX_OK: "1",
    TFX_CODEX_PLAN: "pro",
    TFX_CODEX_TRANSPORT: "exec",
    TFX_ANTIGRAVITY_OK: "0",
    TFX_HUB_OK: "1",
    TFX_HUB_ENSURE_SCRIPT: fakeHubEnsure,
    TFX_HEARTBEAT: "0",
    TFX_MCP_HEALTH_CHECK: "0",
    TFX_HARD_CEILING_SEC: "0",
    TFX_TEAM_TASK_ID: "",
    TFX_TEAM_AGENT_NAME: "",
    TFX_TEAM_LEAD_NAME: "",
    TFX_PREFLIGHT_LOADED: "1",
    TFX_TMP: tfxTmp,
    TFX_CODEX_PROFILE: "auto",
    TFX_TEAM_NAME: "",
    TFX_WORKER_INDEX: "",
    TFX_WORKER_SANDBOX_SCOPE: "",
    ...envOverrides,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    TFX_MACHINE_PROFILE_PATH: "",
    TFX_DISABLE_CODEX: "0",
    TFX_DISABLE_ANTIGRAVITY: "0",
  };
  if (snapshot) env.TFX_RETRY_SNAPSHOT = snapshot;

  const result = spawnSync("bash", [ROUTE, agent, "hello"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `route should exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(readFileSync(capture, "utf8"));
}

function profileValues(args) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--profile") values.push(args[i + 1]);
  }
  return values;
}

function configValues(args, key) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-c") continue;
    const value = args[i + 1] || "";
    if (value.startsWith(`${key}=`)) values.push(value.slice(key.length + 1));
  }
  return values;
}

describe("tfx-route retry snapshot profile plumbing", () => {
  it("keeps default argv without a retry snapshot despite ambient disable flags", () => {
    const dir = makeTempDir();
    const configRoot = path.join(dir, "ambient-config");
    const profileDir = path.join(configRoot, "triflux");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      path.join(profileDir, "machine-profile.env"),
      "TFX_DISABLE_CODEX=1\nTFX_DISABLE_ANTIGRAVITY=1\n",
      "utf8",
    );

    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = configRoot;
      const args = runRoute();
      assert.deepEqual(profileValues(args), ["gpt61_sol_high"]);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });

  it("uses bridge cliInvocation.argv from TFX_RETRY_SNAPSHOT as the single codex profile", () => {
    const dir = makeTempDir();
    const snapshot = path.join(dir, "retry-snapshot.json");
    writeRetrySnapshot(snapshot, "gpt6_astra_xhigh");

    const args = runRoute({ snapshot });

    assert.deepEqual(profileValues(args), ["gpt6_astra_xhigh"]);
  });

  it("explicit max overrides a mutated ultra profile in final argv", () => {
    const args = runRoute({
      env: { TFX_CODEX_PROFILE: "max" },
      profileFiles: {
        gpt6_astra_max:
          'model = "gpt-6-astra"\nmodel_reasoning_effort = "ultra"\n',
      },
    });

    assert.deepEqual(profileValues(args), ["gpt6_astra_max"]);
    assert.equal(configValues(args, "model_reasoning_effort").at(-1), '"max"');
    assert.equal(configValues(args, "model").at(-1), '"gpt-6-astra"');
  });

  it("allows ultra only for a top-level deep-executor", () => {
    const args = runRoute({
      agent: "deep-executor",
      env: { TFX_CODEX_PROFILE: "ultra" },
      profileFiles: {
        gpt6_astra_ultra:
          'model = "gpt-6-astra"\nmodel_reasoning_effort = "max"\n',
      },
    });

    assert.deepEqual(profileValues(args), ["gpt6_astra_ultra"]);
    assert.equal(
      configValues(args, "model_reasoning_effort").at(-1),
      '"ultra"',
    );
    assert.equal(configValues(args, "model").at(-1), '"gpt-6-astra"');
  });

  it("downgrades nested ultra to max", () => {
    const args = runRoute({
      agent: "deep-executor",
      env: { TFX_CODEX_PROFILE: "ultra", TFX_TEAM_NAME: "nested-team" },
    });

    assert.deepEqual(profileValues(args), ["gpt6_astra_max"]);
  });

  it("retry snapshot remains authoritative over the explicit profile override", () => {
    const dir = makeTempDir();
    const snapshot = path.join(dir, "retry-snapshot.json");
    writeRetrySnapshot(snapshot, "gpt6_astra_max");

    const args = runRoute({
      snapshot,
      agent: "deep-executor",
      env: { TFX_CODEX_PROFILE: "ultra" },
    });

    assert.deepEqual(profileValues(args), ["gpt6_astra_max"]);
  });

  it("retry snapshot cannot reintroduce ultra inside a nested runtime", () => {
    const dir = makeTempDir();
    const snapshot = path.join(dir, "retry-snapshot.json");
    writeRetrySnapshot(snapshot, "gpt6_astra_ultra");

    const args = runRoute({
      snapshot,
      agent: "deep-executor",
      env: { TFX_TEAM_NAME: "nested-team" },
    });

    assert.deepEqual(profileValues(args), ["gpt6_astra_max"]);
  });

  it("normalizes all old Sol profiles from retry snapshots", () => {
    for (const [legacy, canonical] of [
      ["gpt56_sol_xhigh", "gpt6_astra_xhigh"],
      ["gpt56_sol_max", "gpt6_astra_max"],
      ["gpt56_sol_ultra", "gpt6_astra_max"],
    ]) {
      const dir = makeTempDir();
      const snapshot = path.join(dir, `${legacy}.json`);
      writeRetrySnapshot(snapshot, legacy);
      assert.deepEqual(profileValues(runRoute({ snapshot })), [canonical]);
    }
  });

  it("normalizes old GPT-5.6 and GPT-6 Sol profiles from TFX_CODEX_PROFILE", () => {
    for (const [legacy, canonical] of [
      ["gpt56_sol_xhigh", "gpt6_astra_xhigh"],
      ["gpt56_sol_max", "gpt6_astra_max"],
      ["gpt56_sol_ultra", "gpt6_astra_ultra"],
      ["gpt56_terra_high", "gpt61_sol_high"],
      ["gpt56_terra_med", "gpt61_sol_med"],
      ["gpt56_luna_low", "gpt6_luna_low"],
      ["gpt6_sol_high", "gpt61_sol_high"],
      ["gpt6_sol_med", "gpt61_sol_med"],
    ]) {
      const args = runRoute({
        agent: "deep-executor",
        env: { TFX_CODEX_PROFILE: legacy },
      });
      assert.deepEqual(profileValues(args), [canonical]);
    }
  });

  it("custom retry profiles cannot hide ultra or fall through to global config", () => {
    const dir = makeTempDir();
    const customSnapshot = path.join(dir, "custom-retry-snapshot.json");
    const missingSnapshot = path.join(dir, "missing-retry-snapshot.json");
    writeRetrySnapshot(customSnapshot, "private");
    writeRetrySnapshot(missingSnapshot, "missing-private");

    const customUltra = runRoute({
      snapshot: customSnapshot,
      agent: "deep-executor",
      profileFiles: {
        private: 'model = "gpt-6-astra"\nmodel_reasoning_effort = "ultra"\n',
      },
    });
    const missingCustom = runRoute({
      snapshot: missingSnapshot,
      agent: "deep-executor",
    });

    assert.deepEqual(profileValues(customUltra), ["gpt6_astra_max"]);
    assert.deepEqual(profileValues(missingCustom), ["gpt61_sol_high"]);
  });

  it("nested default overrides a mutated ultra profile in final argv", () => {
    const args = runRoute({
      env: { TFX_TEAM_NAME: "nested-team" },
      profileFiles: {
        gpt61_sol_high:
          'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "ultra"\n',
      },
    });

    assert.equal(configValues(args, "model_reasoning_effort").at(-1), '"max"');
  });
});
