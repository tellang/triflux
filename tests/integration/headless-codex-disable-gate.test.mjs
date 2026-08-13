import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildHeadlessCommand } from "../../hub/team/headless.mjs";
import { BASH_EXE } from "../helpers/bash-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const ROUTE_SCRIPT = resolve(ROOT, "scripts/tfx-route.sh");

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function baseTestEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("TFX_")),
  );
}

function createHeadlessFixture() {
  const root = mkdtempSync(join(tmpdir(), "tfx-headless-disable-gate-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const codexLog = join(root, "codex-exec.log");
  const agyLog = join(root, "agy-exec.log");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      "[mcp_servers.context7]",
      'command = "node"',
      "",
      "[mcp_servers.brave-search]",
      'command = "node"',
      "",
      "[mcp_servers.exa]",
      'command = "node"',
      "",
      "[mcp_servers.tavily]",
      'command = "node"',
      "",
      "[mcp_servers.playwright]",
      'command = "node"',
      "",
    ].join("\n"),
    "utf8",
  );

  const codexBin = join(bin, "codex");
  writeFileSync(
    codexBin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then printf "codex 0.124.0\\n"; exit 0; fi',
      `printf '%s\\n' "$*" >> "$TFX_TEST_CODEX_EXEC_LOG"`,
      "printf 'CODEX_EXEC\\n'",
    ].join("\n"),
    "utf8",
  );
  chmodSync(codexBin, 0o755);

  const agyBin = join(bin, "agy");
  writeFileSync(
    agyBin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" == \"--help\" ]]; then printf '%s\\n' '--print --dangerously-skip-permissions'; exit 0; fi",
      `printf '%s\\n' "$*" >> "$TFX_TEST_AGY_EXEC_LOG"`,
      "cat >/dev/null",
      "printf 'AGY_EXEC\\n'",
    ].join("\n"),
    "utf8",
  );
  chmodSync(agyBin, 0o755);

  return { root, home, codexBin, agyBin, codexLog, agyLog };
}

function runCodexHeadless(fixture, overrides = {}) {
  const resultFile = join(fixture.root, "result.txt");
  const command = buildHeadlessCommand("codex", "gate test", resultFile, {
    handoff: false,
    mcp: "minimal",
    role: "executor",
    routeScript: ROUTE_SCRIPT,
  });
  const result = spawnSync(BASH_EXE, ["-lc", command], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...baseTestEnv(),
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      CODEX_BIN: fixture.codexBin,
      AGY_BIN: fixture.agyBin,
      TFX_TEST_CODEX_EXEC_LOG: fixture.codexLog,
      TFX_TEST_AGY_EXEC_LOG: fixture.agyLog,
      TFX_PREFLIGHT_LOADED: "1",
      TFX_CODEX_OK: "1",
      TFX_ANTIGRAVITY_OK: "1",
      TFX_CLI_MODE: "auto",
      TFX_NO_CLAUDE_NATIVE: "0",
      TFX_CODEX_TRANSPORT: "exec",
      TFX_HARD_CEILING_SEC: "0",
      TFX_MCP_HEALTH_CHECK: "0",
      TFX_ALLOW_SMALL_CODEX_CONFIG: "1",
      TFX_CTO_NORTH_STAR: "0",
      TFX_HUB_URL: "",
      TFX_TEAM_NAME: "",
      ...overrides,
    },
  });
  return {
    result,
    command,
    stdout: readIfPresent(resultFile),
    stderr: readIfPresent(`${resultFile}.err`),
  };
}

function runRouteWithPreflightLoaded(fixture) {
  return spawnSync(
    BASH_EXE,
    [ROUTE_SCRIPT, "executor", "nested preflight plan regression", "auto"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...baseTestEnv(),
        HOME: fixture.home,
        USERPROFILE: fixture.home,
        CODEX_BIN: fixture.codexBin,
        AGY_BIN: fixture.agyBin,
        TFX_TEST_CODEX_EXEC_LOG: fixture.codexLog,
        TFX_TEST_AGY_EXEC_LOG: fixture.agyLog,
        TFX_PREFLIGHT_LOADED: "1",
        TFX_CODEX_OK: "1",
        TFX_ANTIGRAVITY_OK: "0",
        TFX_CLI_MODE: "auto",
        TFX_NO_CLAUDE_NATIVE: "0",
        TFX_CODEX_TRANSPORT: "exec",
        TFX_HARD_CEILING_SEC: "0",
        TFX_MCP_HEALTH_CHECK: "0",
        TFX_ALLOW_SMALL_CODEX_CONFIG: "1",
        TFX_CTO_NORTH_STAR: "0",
        TFX_HUB_URL: "",
        TFX_TEAM_NAME: "",
      },
    },
  );
}

describe("headless Codex disable gate", { timeout: 90_000 }, () => {
  it("preflight 완료 표시만 상속한 자식도 plan 없이 route-backed Codex를 실행한다", () => {
    const fixture = createHeadlessFixture();
    try {
      const result = runRouteWithPreflightLoaded(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /unbound variable|바인딩 해제한 변수/);
      assert.match(readIfPresent(fixture.codexLog), /^exec\b/m);
      assert.match(result.stdout, /CODEX_EXEC/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("TFX_DISABLE_CODEX=1이면 Codex worker는 실행하지 않고 허용된 Antigravity로만 전환한다", () => {
    const fixture = createHeadlessFixture();
    try {
      const outcome = runCodexHeadless(fixture, { TFX_DISABLE_CODEX: "1" });

      assert.equal(outcome.result.status, 0, outcome.stderr);
      assert.match(outcome.stderr, /TFX_DISABLE_CODEX=1: codex 선택 차단/);
      assert.equal(readIfPresent(fixture.codexLog), "");
      assert.match(readIfPresent(fixture.agyLog), /--print/);
      assert.match(outcome.stdout, /AGY_EXEC/);
      assert.doesNotMatch(outcome.command, /codex exec/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("미차단 Codex worker는 route-backed 경로에서 정상 실행한다", () => {
    const fixture = createHeadlessFixture();
    try {
      const outcome = runCodexHeadless(fixture);

      assert.equal(outcome.result.status, 0, outcome.stderr);
      assert.match(
        readIfPresent(fixture.codexLog),
        /^exec\b/m,
        `stdout=${outcome.stdout}\nstderr=${outcome.stderr}`,
      );
      assert.equal(readIfPresent(fixture.agyLog), "");
      assert.match(outcome.stdout, /CODEX_EXEC/);
      assert.match(outcome.command, /tfx-route\.sh/);
      assert.doesNotMatch(outcome.command, /codex exec/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("양쪽 CLI가 차단되면 Claude native로 강등하지 않고 fail-loud 한다", () => {
    const fixture = createHeadlessFixture();
    try {
      const outcome = runCodexHeadless(fixture, {
        TFX_DISABLE_CODEX: "1",
        TFX_DISABLE_ANTIGRAVITY: "1",
      });

      assert.equal(outcome.result.status, 78, outcome.stderr);
      assert.match(outcome.stderr, /TFX_DISABLE_CODEX=1: codex 선택 차단/);
      assert.match(outcome.stderr, /허용되고 사용 가능한 외부 CLI가 없습니다/);
      assert.equal(readIfPresent(fixture.codexLog), "");
      assert.equal(readIfPresent(fixture.agyLog), "");
      assert.doesNotMatch(outcome.stderr, /claude-native/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
