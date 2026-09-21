import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { hubServerTestEnv } from "../fixtures/hub-test-env.mjs";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const ROUTE_SCRIPT = toBashPath(resolve(PROJECT_ROOT, "scripts/tfx-route.sh"));
const HUB_ENSURE_STUB = resolve(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "no-op-hub-ensure.mjs",
);
const UNSET = "__TFX_UNSET__";

function writeExecutable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function createStubBin() {
  const root = mkdtempSync(join(tmpdir(), "tfx-route-agy-keychain-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });

  writeExecutable(
    join(bin, "uname"),
    `#!/bin/sh
if [ "$1" = "-s" ]; then
  printf '%s\\n' "\${TFX_TEST_UNAME:-Linux}"
  exit 0
fi
exec /usr/bin/uname "$@"
`,
  );
  writeExecutable(
    join(bin, "security"),
    `#!/bin/sh
if [ "\${TFX_TEST_SECURITY_RESULT:-fail}" = "success" ]; then
  exit 0
fi
exit 1
`,
  );
  writeExecutable(
    join(bin, "agy"),
    `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\\n' '--print --dangerously-skip-permissions'
  exit 0
fi
printf '%s|%s|%s\\n' "\${SSH_CONNECTION:-${UNSET}}" "\${SSH_CLIENT:-${UNSET}}" "\${SSH_TTY:-${UNSET}}"
`,
  );
  return { root, bin };
}

function runRoute(overrides = {}) {
  const { root, bin } = createStubBin();
  const home = join(root, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "", "utf8");

  try {
    return spawnSync(
      BASH_EXE,
      ["-c", `bash "${ROUTE_SCRIPT}" antigravity 'env probe' minimal 10`],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 30_000,
        env: hubServerTestEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          TFX_MACHINE_PROFILE_PATH: join(home, "machine-profile.env"),
          TFX_HUB_ENSURE_SCRIPT: HUB_ENSURE_STUB,
          TFX_HUB_URL: "",
          TFX_TEAM_NAME: "",
          TFX_TEAM_TASK_ID: "",
          TFX_TEAM_AGENT_NAME: "",
          TFX_TEAM_LEAD_NAME: "",
          TFX_PREFLIGHT_LOADED: "1",
          TFX_CODEX_OK: "0",
          TFX_ANTIGRAVITY_OK: "1",
          TFX_DISABLE_CODEX: "0",
          TFX_DISABLE_ANTIGRAVITY: "0",
          TFX_MCP_HEALTH_CHECK: "0",
          TFX_HARD_CEILING_SEC: "0",
          SSH_CONNECTION: "stale-connection",
          SSH_CLIENT: "stale-client",
          SSH_TTY: "stale-tty",
          ...overrides,
        }),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

describe("tfx-route.sh Antigravity Keychain SSH environment", () => {
  it("darwin Keychain token success removes SSH variables from the agy child", () => {
    const result = runRoute({
      TFX_TEST_UNAME: "Darwin",
      TFX_TEST_SECURITY_RESULT: "success",
    });

    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, new RegExp(`${UNSET}\\|${UNSET}\\|${UNSET}`));
    assert.match(result.stderr, /Keychain을 읽도록 SSH 변수를 제거/);
  });

  it("darwin Keychain probe failure preserves SSH variables", () => {
    const result = runRoute({
      TFX_TEST_UNAME: "Darwin",
      TFX_TEST_SECURITY_RESULT: "fail",
    });

    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /stale-connection\|stale-client\|stale-tty/);
  });

  it("TFX_AGY_KEEP_SSH_ENV=1 preserves SSH variables", () => {
    const result = runRoute({
      TFX_TEST_UNAME: "Darwin",
      TFX_TEST_SECURITY_RESULT: "success",
      TFX_AGY_KEEP_SSH_ENV: "1",
    });

    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /stale-connection\|stale-client\|stale-tty/);
  });

  it("non-darwin preserves SSH variables", () => {
    const result = runRoute({
      TFX_TEST_UNAME: "Linux",
      TFX_TEST_SECURITY_RESULT: "success",
    });

    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /stale-connection\|stale-client\|stale-tty/);
  });
});
