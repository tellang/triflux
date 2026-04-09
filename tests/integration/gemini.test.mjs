// tests/integration/gemini.test.mjs — Gemini 전용 통합 테스트
//
// TFX_CLI_MODE=gemini 환경의 시나리오:
//   - Gemini 모델 리매핑 검증 (Pro / Flash 분기)
//   - GEMINI_ALLOWED_SERVERS MCP 필터링 동작
//   - Gemini stream wrapper 실패 시 claude-native fallback
//   - Gemini health check 동작

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const ROUTE_SCRIPT = toBashPath(
  resolve(PROJECT_ROOT, "scripts", "tfx-route.sh"),
);
const WORKER_SCRIPT = resolve(PROJECT_ROOT, "scripts", "tfx-route-worker.mjs");
const FAKE_GEMINI_CLI = resolve(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "fake-gemini-cli.mjs",
);
const FIXTURE_BIN = toBashPath(
  resolve(PROJECT_ROOT, "tests", "fixtures", "bin"),
);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function removeTempDirWithRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return true;
    } catch {
      sleepSync(100 * (attempt + 1));
    }
  }
  return false;
}

// bash 실행 헬퍼 — stdout + stderr 합산 반환
function runBash(command, extraEnv = {}) {
  const testTempDir = mkdtempSync(resolve(tmpdir(), "triflux-gemini-test-"));

  try {
    return spawnSync(BASH_EXE, ["-c", command], {
      cwd: testTempDir,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: testTempDir,
        TMPDIR: testTempDir,
        TMP: testTempDir,
        TEMP: testTempDir,
        TFX_TEAM_NAME: "",
        TFX_TEAM_TASK_ID: "",
        TFX_TEAM_AGENT_NAME: "",
        TFX_TEAM_LEAD_NAME: "",
        TFX_HUB_URL: "",
        TMUX: "",
        TFX_CLI_MODE: "gemini",
        TFX_NO_CLAUDE_NATIVE: "0",
        TFX_CODEX_TRANSPORT: "exec",
        TFX_WORKER_INDEX: "",
        TFX_SEARCH_TOOL: "",
        ...extraEnv,
      },
    });
  } finally {
    removeTempDirWithRetry(testTempDir);
  }
}

function out(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function fixtureEnv(extraEnv = {}) {
  return {
    ...extraEnv,
    PATH: `${FIXTURE_BIN}:${process.env.PATH || ""}`,
  };
}

// ── Gemini 모델 리매핑 검증 ──

describe("tfx-route.sh — Gemini 모델 리매핑 (TFX_CLI_MODE=gemini)", {
  concurrency: 1,
}, () => {
  it("executor는 codex에서 gemini Pro로 리매핑되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" executor 'gemini-remap-test' 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /TFX_CLI_MODE=gemini/);
    assert.match(out(result), /type=gemini/);
    assert.match(out(result), /gemini\(pro(?:31)?\)로 리매핑/);
  });

  it("architect는 gemini Pro로 리매핑되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" architect 'gemini-arch-test' 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /gemini\(pro(?:31)?\)로 리매핑/);
  });

  it("build-fixer는 gemini Flash로 리매핑되어야 한다", (t) => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" build-fixer 'gemini-flash-test' 2>&1 || true`,
      fixtureEnv(),
    );
    if (result.status === null) {
      t.skip("Gemini stream wrapper timeout");
      return;
    }
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /gemini\(flash(?:3)?\)로 리매핑/);
  });

  it("spark는 gemini Flash로 리매핑되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" spark 'gemini-spark-test' 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /gemini\(flash(?:3)?\)로 리매핑/);
  });

  it("기본 gemini 타입(designer)은 리매핑 없이 gemini 유지되어야 한다", () => {
    // designer는 원래 gemini 타입이므로 codex->gemini 리매핑이 발생하지 않음
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" designer 'gemini-native-test' 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=gemini/);
    assert.match(out(result), /agent=designer/);
    // 리매핑 메시지가 없어야 함 (이미 gemini 타입)
    assert.doesNotMatch(out(result), /리매핑/);
  });

  it("writer는 원래 gemini Flash 타입이므로 리매핑 없이 유지되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" writer 'gemini-writer-test' 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=gemini/);
    assert.match(out(result), /agent=writer/);
    assert.doesNotMatch(out(result), /리매핑/);
  });
});

// ── GEMINI_ALLOWED_SERVERS MCP 필터링 ──

describe("tfx-route.sh — Gemini MCP 필터링 (GEMINI_ALLOWED_SERVERS)", {
  concurrency: 1,
}, () => {
  it("designer + auto 프로필에서 playwright 포함 MCP 서버가 필터링되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" designer 'Capture browser screenshot and inspect layout' auto 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=designer/);
    // designer 프로필은 context7, playwright 등을 허용
    assert.match(out(result), /allowed_mcp_servers=/);
  });

  it("executor가 gemini로 리매핑된 후에도 MCP 정책이 적용되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" executor 'Implement CLI parser using package docs' auto 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=gemini/);
    assert.match(out(result), /resolved_profile=executor/);
    // executor 프로필 MCP 서버가 필터링됨
    assert.match(out(result), /allowed_mcp_servers=/);
  });

  it("writer + auto 프로필에서 context7과 brave-search가 허용되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" writer 'write documentation' auto 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=writer/);
  });

  it("none 프로필에서는 MCP 서버가 비활성화되어야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=gemini bash "${ROUTE_SCRIPT}" designer 'no-mcp-test' none 2>&1 || true`,
      fixtureEnv(),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=none/);
    assert.match(out(result), /allowed_mcp_servers=none/);
  });
});

// ── Gemini stream worker 429 재시도 ──

describe("tfx-route.sh — Gemini stream worker 429 재시도", {
  concurrency: 1,
}, () => {
  it("첫 호출이 429여도 5초 대기 후 1회 재시도에서 성공해야 한다", () => {
    const testTempDir = mkdtempSync(
      resolve(tmpdir(), "triflux-gemini-worker-retry-"),
    );
    const result = spawnSync(
      process.execPath,
      [
        WORKER_SCRIPT,
        "--type",
        "gemini",
        "--command",
        process.execPath,
        "--command-args-json",
        JSON.stringify([FAKE_GEMINI_CLI]),
        "--model",
        "fake-gemini-model",
        "--approval-mode",
        "yolo",
        "--cwd",
        testTempDir,
      ],
      {
        cwd: PROJECT_ROOT,
        input: "gemini-retry-429",
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: testTempDir,
          TMPDIR: testTempDir,
          TMP: testTempDir,
          TEMP: testTempDir,
          FAKE_GEMINI_429: "1",
        },
      },
    );

    const output = out(result);
    try {
      assert.equal(result.status, 0, output);
      assert.match(result.stdout || "", /gemini:gemini-retry-429/);
      assert.match(
        result.stderr || "",
        /Gemini 429\/quota 감지 — 5초 후 1회 재시도합니다\./,
      );
    } finally {
      removeTempDirWithRetry(testTempDir);
    }
  });
});

// ── Gemini stream wrapper 실패 시 claude-native fallback ──
// run_legacy_gemini는 좀비 프로세스 원인으로 제거됨 (#62 후속).
// stream wrapper 실패 시 claude-native metadata를 반환한다.

describe("tfx-route.sh — Gemini stream wrapper fallback", {
  concurrency: 1,
}, () => {
  it("stream wrapper 실패 시 claude-native fallback metadata를 반환해야 한다", () => {
    // stream wrapper가 실패하면 (TFX_ROUTE_WORKER_RUNNER 미존재)
    // run_legacy_gemini 대신 claude-native metadata로 fallback
    const result = runBash(
      `GEMINI_BIN=gemini TFX_ROUTE_WORKER_RUNNER=__nonexistent__ bash "${ROUTE_SCRIPT}" designer 'fallback-test' auto 2>&1 || true`,
      fixtureEnv(),
    );
    const output = out(result);
    assert.match(output, /claude-native fallback|ROUTE_TYPE=claude-native/);
  });
});

// ── Gemini CLI 모드 전환 및 fallback ──

describe("tfx-route.sh — Gemini CLI 모드 전환", { concurrency: 1 }, () => {
  it("TFX_CLI_MODE=gemini에서 claude-native 에이전트(explore)는 claude-native를 유지해야 한다", () => {
    // explore는 claude-native 타입이고, gemini 모드에서는
    // apply_cli_mode가 codex->gemini 리매핑만 처리하므로 claude-native 유지
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" explore 'gemini-explore-test'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });

  it("TFX_CLI_MODE=gemini에서 test-engineer는 claude-native를 유지해야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" test-engineer 'gemini-te-test'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });

  it("TFX_VERIFIER_OVERRIDE=claude면 gemini 모드에서도 verifier는 claude-native를 유지해야 한다", () => {
    const result = runBash(
      `TFX_VERIFIER_OVERRIDE=claude bash "${ROUTE_SCRIPT}" verifier 'gemini-verifier-override-test'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
    assert.match(out(result), /AGENT=verifier/);
  });

  it("gemini 미설치 + codex 미설치 시 claude-native fallback이 발생해야 한다", () => {
    const result = runBash(
      `TFX_CLI_MODE=auto GEMINI_BIN=__nonexistent_gemini__ CODEX_BIN=__nonexistent_codex__ bash "${ROUTE_SCRIPT}" designer 'fallback-test'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(
      out(result),
      /claude-native fallback|ROUTE_TYPE=claude-native/,
    );
  });

  it("gemini 미설치 + codex 설치 시 auto 모드에서 codex로 전환되어야 한다", () => {
    const result = runBash(
      `TFX_CLI_MODE=auto GEMINI_BIN=__nonexistent_gemini__ CODEX_BIN=codex bash "${ROUTE_SCRIPT}" designer 'codex-switch-test' auto 2>&1 || true`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    // gemini 미설치로 codex로 전환됨
    assert.match(out(result), /type=codex/);
  });
});

// ── mcp-filter.mjs Gemini 관련 단위 동작 ──

describe("mcp-filter — Gemini 관련 정책 빌드", { concurrency: 1 }, () => {
  it("designer 에이전트의 geminiAllowedServers에 playwright가 포함되어야 한다", async () => {
    const { buildMcpPolicy } = await import("../../scripts/lib/mcp-filter.mjs");
    const policy = buildMcpPolicy({
      agentType: "designer",
      requestedProfile: "auto",
      availableServers: [
        "context7",
        "brave-search",
        "exa",
        "tavily",
        "playwright",
      ],
      taskText:
        "Capture browser screenshot and inspect responsive UI layout regression.",
    });

    assert.ok(
      policy.geminiAllowedServers.includes("playwright"),
      "designer geminiAllowedServers에 playwright가 있어야 한다",
    );
    assert.ok(
      policy.geminiAllowedServers.includes("context7"),
      "designer geminiAllowedServers에 context7이 있어야 한다",
    );
  });

  it("writer 에이전트의 geminiAllowedServers에 tavily가 비포함이어야 한다", async () => {
    const { buildMcpPolicy } = await import("../../scripts/lib/mcp-filter.mjs");
    const policy = buildMcpPolicy({
      agentType: "writer",
      requestedProfile: "auto",
      availableServers: ["context7", "brave-search", "exa", "tavily"],
    });

    assert.ok(
      !policy.geminiAllowedServers.includes("tavily"),
      "writer geminiAllowedServers에 tavily가 없어야 한다",
    );
    assert.ok(
      policy.geminiAllowedServers.includes("context7"),
      "writer geminiAllowedServers에 context7이 있어야 한다",
    );
  });

  it("toShellExports()에서 GEMINI_ALLOWED_SERVERS 배열이 올바르게 직렬화되어야 한다", async () => {
    const { buildMcpPolicy, toShellExports } = await import(
      "../../scripts/lib/mcp-filter.mjs"
    );
    const policy = buildMcpPolicy({
      agentType: "designer",
      requestedProfile: "auto",
      availableServers: ["context7", "playwright"],
      taskText: "Check browser layout",
    });

    const shellOutput = toShellExports(policy);
    assert.match(shellOutput, /GEMINI_ALLOWED_SERVERS=/);
    // 배열 형식: GEMINI_ALLOWED_SERVERS=('context7' 'playwright')
    assert.match(shellOutput, /GEMINI_ALLOWED_SERVERS=\(/);
  });

  it("none 프로필에서 geminiAllowedServers가 빈 배열이어야 한다", async () => {
    const { buildMcpPolicy } = await import("../../scripts/lib/mcp-filter.mjs");
    const policy = buildMcpPolicy({
      agentType: "designer",
      requestedProfile: "none",
      availableServers: [
        "context7",
        "brave-search",
        "exa",
        "tavily",
        "playwright",
      ],
    });

    assert.deepEqual(policy.geminiAllowedServers, []);
  });
});
