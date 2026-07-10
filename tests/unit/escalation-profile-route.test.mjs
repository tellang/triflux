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
import { afterEach, describe, it } from "node:test";
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

function runRoute({ snapshot } = {}) {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const tfxTmp = path.join(dir, "tmp");
  const capture = path.join(dir, "codex-args.json");
  const fakeCodex = path.join(binDir, "codex");
  const fakeHubEnsure = path.join(dir, "hub-ensure.mjs");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(home, { recursive: true });
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
  writeFileSync(fakeHubEnsure, "process.exit(0);\n", "utf8");

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
    TFX_GEMINI_OK: "0",
    TFX_ANTIGRAVITY_OK: "0",
    TFX_HUB_OK: "1",
    TFX_HUB_ENSURE_SCRIPT: fakeHubEnsure,
    TFX_HEARTBEAT: "0",
    TFX_PREFLIGHT_LOADED: "1",
    TFX_TMP: tfxTmp,
  };
  if (snapshot) env.TFX_RETRY_SNAPSHOT = snapshot;

  const result = spawnSync("bash", [ROUTE, "executor", "hello"], {
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

describe("tfx-route retry snapshot profile plumbing", () => {
  it("does not change codex argv when no retry snapshot is provided", () => {
    const args = runRoute();

    assert.deepEqual(profileValues(args), ["gpt56_terra_high"]);
  });

  it("uses bridge cliInvocation.argv from TFX_RETRY_SNAPSHOT as the single codex profile", () => {
    const dir = makeTempDir();
    const snapshot = path.join(dir, "retry-snapshot.json");
    writeRetrySnapshot(snapshot, "gpt56_sol_xhigh");

    const args = runRoute({ snapshot });

    assert.deepEqual(profileValues(args), ["gpt56_sol_xhigh"]);
  });
});
