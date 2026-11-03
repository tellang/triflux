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
import { after, before, beforeEach, describe, it } from "node:test";
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

function isolatedMachineProfileEnv(home) {
  return {
    XDG_CONFIG_HOME: join(home, ".config"),
    TFX_MACHINE_PROFILE_PATH: join(home, "machine-profile.env"),
  };
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

function runCodexHeadless(fixture, overrides = {}, buildOptions = {}) {
  const resultFile = join(fixture.root, "result.txt");
  const command = buildHeadlessCommand("codex", "gate test", resultFile, {
    handoff: false,
    mcp: "minimal",
    role: "executor",
    routeScript: ROUTE_SCRIPT,
    ...buildOptions,
  });
  const result = spawnSync(BASH_EXE, ["-lc", command], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...baseTestEnv(),
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      ...isolatedMachineProfileEnv(fixture.home),
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
      // CLI 차단 검증에는 heartbeat가 필요 없다.
      TFX_HEARTBEAT: "0",
      TFX_MCP_HEALTH_CHECK: "0",
      TFX_ALLOW_SMALL_CODEX_CONFIG: "1",
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
        ...isolatedMachineProfileEnv(fixture.home),
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
        // CLI 차단 검증에는 heartbeat가 필요 없다.
        TFX_HEARTBEAT: "0",
        TFX_MCP_HEALTH_CHECK: "0",
        TFX_ALLOW_SMALL_CODEX_CONFIG: "1",
        TFX_TEAM_NAME: "",
      },
    },
  );
}

describe("headless Codex disable gate", { timeout: 90_000 }, () => {
  let fixture;
  let config;
  before(() => {
    fixture = createHeadlessFixture();
    config = readFileSync(join(fixture.home, ".codex/config.toml"), "utf8");
  });
  beforeEach(() => {
    for (const file of [
      fixture.codexLog,
      fixture.agyLog,
      join(fixture.root, "result.txt"),
      join(fixture.root, "result.txt.err"),
    ]) {
      rmSync(file, { force: true });
    }
    writeFileSync(join(fixture.home, ".codex/config.toml"), config);
  });
  after(() => rmSync(fixture.root, { recursive: true, force: true }));

  it("preflight 완료 표시만 상속한 자식도 plan 없이 route-backed Codex를 실행한다", () => {
    const result = runRouteWithPreflightLoaded(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /unbound variable|바인딩 해제한 변수/);
    assert.match(readIfPresent(fixture.codexLog), /^exec\b/m);
    assert.match(result.stdout, /CODEX_EXEC/);
  });

  it("TFX_DISABLE_CODEX=1이면 Codex worker는 실행하지 않고 허용된 Antigravity로만 전환한다", () => {
    const outcome = runCodexHeadless(fixture, { TFX_DISABLE_CODEX: "1" });

    assert.equal(outcome.result.status, 0, outcome.stderr);
    assert.match(outcome.stderr, /TFX_DISABLE_CODEX=1: codex 선택 차단/);
    assert.equal(readIfPresent(fixture.codexLog), "");
    assert.match(readIfPresent(fixture.agyLog), /--print/);
    assert.match(outcome.stdout, /AGY_EXEC/);
    assert.doesNotMatch(outcome.command, /codex exec/);
  });

  it("미차단 Codex worker는 route-backed 경로에서 정상 실행한다", () => {
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
  });

  it("부모 XDG_CONFIG_HOME의 차단 프로파일을 상속하지 않는다", () => {
    const parentConfigHome = mkdtempSync(
      join(tmpdir(), "tfx-headless-parent-profile-"),
    );
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    mkdirSync(join(parentConfigHome, "triflux"), { recursive: true });
    writeFileSync(
      join(parentConfigHome, "triflux", "machine-profile.env"),
      "TFX_DISABLE_CODEX=1\nTFX_DISABLE_ANTIGRAVITY=1\n",
      "utf8",
    );

    try {
      process.env.XDG_CONFIG_HOME = parentConfigHome;
      const outcome = runCodexHeadless(fixture);

      assert.equal(outcome.result.status, 0, outcome.stderr);
      assert.match(readIfPresent(fixture.codexLog), /^exec\b/m);
      assert.equal(readIfPresent(fixture.agyLog), "");
      assert.match(outcome.stdout, /CODEX_EXEC/);
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      rmSync(parentConfigHome, { recursive: true, force: true });
    }
  });

  it("양쪽 CLI가 차단되면 Claude native로 강등하지 않고 fail-loud 한다", () => {
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
  });

  function jevEnv() {
    const jev = join(fixture.root, "jev");
    writeFileSync(
      jev,
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.TFX_TEST_JEV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const query = process.argv[3];
const choice = query.includes('complexity') ? 'trivial' : query.includes('permission') ? 'workspace_auto' : query.includes('profile') ? 'none' : 'keep';
console.log(JSON.stringify({ choice, value: false, confidence: 0.95 }));
`,
    );
    chmodSync(jev, 0o755);
    const log = join(fixture.root, "jev.log");
    writeFileSync(log, "");
    return {
      TFX_JEV: "1",
      TFX_JEV_CLI: jev,
      JEV_API_KEY: "",
      TYPESAFE_API_KEY: "",
      TFX_JEV_STATS: "0",
      TFX_TEST_JEV_LOG: log,
    };
  }

  it("Jev 조회와 headless argv가 일치하고 원 task를 한 번만 판정한다", () => {
    const env = jevEnv();
    const contextFile = join(fixture.root, "context.txt");
    writeFileSync(contextFile, "조립 문맥은 모델 판정에 섞이지 않아야 함");
    const outcome = runCodexHeadless(fixture, env, {
      contextFile,
      mcp: "none",
    });
    assert.equal(outcome.result.status, 0, outcome.stderr);
    assert.match(readIfPresent(fixture.codexLog), /--profile luna/);
    assert.match(
      readIfPresent(fixture.codexLog),
      /model_reasoning_effort="low"/,
    );
    const metadata = JSON.parse(
      readIfPresent(join(fixture.root, "result.txt.model.json")),
    );
    assert.equal(metadata.family, "luna");
    assert.equal(metadata.effort, "low");
    assert.equal(metadata.source, "jev");
    assert.equal(metadata.runtimeConfirmed, false);
    const queries = readIfPresent(env.TFX_TEST_JEV_LOG)
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const complexity = queries.filter((args) =>
      args[1].includes("Classify the complexity"),
    );
    assert.equal(complexity.length, 1);
    assert.ok(
      complexity[0].some((arg) =>
        arg.startsWith(
          "agent_role: executor\ncli_type: codex\ntask_prompt:\ngate test",
        ),
      ),
    );
    assert.ok(
      !complexity[0].some(
        (arg) => arg.includes("prior_context") || arg.includes("HANDOFF"),
      ),
    );
    const query = spawnSync(
      process.execPath,
      [
        join(ROOT, "bin/triflux.mjs"),
        "judge",
        "worker-model",
        "--task",
        "gate test",
      ],
      {
        env: {
          ...process.env,
          HOME: fixture.home,
          CODEX_HOME: join(fixture.home, ".codex"),
          ...env,
        },
        encoding: "utf8",
      },
    );
    assert.equal(query.status, 0, query.stderr);
    const selected = JSON.parse(query.stdout);
    assert.equal(selected.model, metadata.model);
    assert.equal(selected.effort, metadata.effort);
  });

  it("명시 model만 전달하면 Jev가 effort를 채우지 않는다", () => {
    const outcome = runCodexHeadless(fixture, jevEnv(), {
      model: "explicit-model",
    });
    assert.equal(outcome.result.status, 0, outcome.stderr);
    assert.match(readIfPresent(fixture.codexLog), /--model explicit-model/);
    assert.doesNotMatch(
      readIfPresent(fixture.codexLog),
      /model_reasoning_effort="low"/,
    );
    const metadata = JSON.parse(
      readIfPresent(join(fixture.root, "result.txt.model.json")),
    );
    assert.equal(metadata.source, "explicit");
    assert.equal(metadata.effort, null);
    assert.equal(metadata.launch.model, "explicit-model");
  });

  it("Codex 차단 뒤에는 최종 agy provider의 모델과 effort를 전달한다", () => {
    const outcome = runCodexHeadless(fixture, {
      ...jevEnv(),
      TFX_DISABLE_CODEX: "1",
    });
    assert.equal(outcome.result.status, 0, outcome.stderr);
    assert.equal(readIfPresent(fixture.codexLog), "");
    assert.match(
      readIfPresent(fixture.agyLog),
      /--model gemini-4-argon --effort low/,
    );
    const metadata = JSON.parse(
      readIfPresent(join(fixture.root, "result.txt.model.json")),
    );
    assert.equal(metadata.cli, "agy");
    assert.equal(metadata.family, "argon");
    assert.equal(metadata.effort, "low");
  });

  it("Jev를 끄면 규칙 폴백 출처와 실제 실행 인자를 기록한다", () => {
    const outcome = runCodexHeadless(fixture, { TFX_JEV: "0" });
    assert.equal(outcome.result.status, 0, outcome.stderr);
    const metadata = JSON.parse(
      readIfPresent(join(fixture.root, "result.txt.model.json")),
    );
    assert.equal(metadata.source, "rule");
    assert.equal(metadata.fallbackReason, "jev_disabled");
    assert.equal(metadata.launch.profile, "sol");
    assert.equal(metadata.launch.effort, "high");
  });
});
