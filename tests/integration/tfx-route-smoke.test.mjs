// tests/integration/tfx-route-smoke.test.mjs — tfx-route.sh 스모크 테스트
//
// scripts/test-tfx-route-no-claude-native.mjs의 테스트 케이스를 포함하여
// tests/integration/ 디렉토리의 통합 테스트로 재구성한다.
//
// 테스트 범위:
//   - claude-native 에이전트(explore/verifier/test-engineer/qa-tester) 기본 라우팅
//   - TFX_CLI_MODE=codex/gemini compatibility 오버라이드 메타데이터
//   - TFX_NO_CLAUDE_NATIVE 유효성 검증 (0/1만 허용)
//   - 알 수 없는 에이전트 타입 오류
//   - 인자 부족 시 오류

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const ROUTE_SCRIPT = toBashPath(
  resolve(PROJECT_ROOT, "scripts", "tfx-route.sh"),
);
const FIXTURE_BIN = toBashPath(
  resolve(PROJECT_ROOT, "tests", "fixtures", "bin"),
);
// Stub hub-ensure so full-route invocations never bind/spawn a hub on the
// canonical port (27888) against the live dev hub (v10.33.1 follow-up #1).
const HUB_ENSURE_STUB = resolve(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "no-op-hub-ensure.mjs",
);
const RUN_BASH_TIMEOUT_MS = 60_000;

function createRouteHome() {
  const home = mkdtempSync(join(tmpdir(), "tfx-route-home-"));
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, "config.toml"),
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
  return home;
}

// bash 실행 헬퍼 — stdout + stderr 합산 반환
function runBash(command, extraEnv = {}) {
  const fallbackHome = extraEnv.HOME ? null : createRouteHome();
  const home = extraEnv.HOME ?? fallbackHome;
  const outputDir = mkdtempSync(join(tmpdir(), "tfx-route-output-"));
  const stdoutPath = join(outputDir, "stdout.log");
  const stderrPath = join(outputDir, "stderr.log");
  const stdoutFd = openSync(stdoutPath, "w+");
  const stderrFd = openSync(stderrPath, "w+");
  let closed = false;

  const closeOutput = () => {
    if (closed) return;
    closed = true;
    closeSync(stdoutFd);
    closeSync(stderrFd);
  };

  try {
    const result = spawnSync(BASH_EXE, ["-c", command], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      // Per-call timeout: a slow or hung command must not block the synchronous
      // spawnSync and hang the entire suite (a describe/test-level timeout cannot
      // interrupt a sync call). Codex-transport fixtures take ~10s; 60s headroom.
      timeout: RUN_BASH_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TRIFLUX_TEST_HOME: home,
        TFX_TEAM_NAME: "",
        TFX_TEAM_TASK_ID: "",
        TFX_TEAM_AGENT_NAME: "",
        TFX_TEAM_LEAD_NAME: "",
        TFX_HUB_URL: "",
        TFX_HUB_ENSURE_SCRIPT: HUB_ENSURE_STUB,
        TMUX: "",
        TFX_CLI_MODE: "auto",
        TFX_NO_CLAUDE_NATIVE: "0",
        TFX_CODEX_TRANSPORT: "exec",
        TFX_CTO_NORTH_STAR: "0",
        TFX_WORKER_INDEX: "",
        TFX_SEARCH_TOOL: "",
        // #148: 테스트 환경에서는 실제 MCP probe 가 모두 dead 로 나와 early-fail 발생.
        // 라우팅/트랜스포트 검증이 목적이므로 preflight 자체를 스킵.
        TFX_MCP_HEALTH_CHECK: "0",
        // Fixture config is intentionally tiny but valid. Production keeps the
        // small-config corruption guard unless a caller opts in explicitly.
        TFX_ALLOW_SMALL_CODEX_CONFIG: "1",
        ...extraEnv,
      },
    });
    closeOutput();
    result.stdout = readFileSync(stdoutPath, "utf8");
    result.stderr = readFileSync(stderrPath, "utf8");
    return result;
  } finally {
    closeOutput();
    rmSync(outputDir, { recursive: true, force: true });
    if (fallbackHome) rmSync(fallbackHome, { recursive: true, force: true });
  }
}

// stdout + stderr 합산 문자열
function out(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function allowedMcpServers(result) {
  const allowedLine =
    out(result).match(/allowed_mcp_servers=([^\n]+)/)?.[1] ?? "";
  if (!allowedLine || allowedLine === "none") return [];
  return allowedLine
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
}

function fixtureEnv(extraEnv = {}) {
  const home = createRouteHome();
  return {
    ...extraEnv,
    PATH: `${FIXTURE_BIN}:${process.env.PATH || ""}`,
    HOME: home,
    USERPROFILE: home,
    TRIFLUX_TEST_HOME: home,
  };
}

// ── claude-native 에이전트 기본 라우팅 ──

describe("tfx-route.sh — claude-native 에이전트 메타데이터 출력", {
  timeout: 180000,
}, () => {
  it("explore 에이전트는 ROUTE_TYPE=claude-native와 MODEL=haiku를 출력해야 한다", () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" explore 'test-prompt'`);
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
    assert.match(out(result), /MODEL=haiku/);
    assert.match(out(result), /AGENT=explore/);
  });

  it("verifier 에이전트는 기본 route table에서 codex review 경로를 사용해야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" verifier 'test-prompt'`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=verifier/);
  });

  it("verifier + TFX_VERIFIER_OVERRIDE=claude는 claude-native로 전환해야 한다", () => {
    const result = runBash(
      `TFX_VERIFIER_OVERRIDE=claude bash "${ROUTE_SCRIPT}" verifier 'test-prompt'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
    assert.match(out(result), /AGENT=verifier/);
  });

  it("test-engineer 에이전트는 codex 경로를 사용해야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" test-engineer 'test-prompt'`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=test-engineer/);
  });

  it("qa-tester 에이전트는 codex review 경로를 사용해야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" qa-tester 'test-prompt'`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=qa-tester/);
  });
});

// ── TFX_CLI_MODE 오버라이드 ──

describe("tfx-route.sh — TFX_CLI_MODE 오버라이드", () => {
  it("TFX_CLI_MODE=gemini 일 때 explore는 claude-native 유지(gemini 모드에서는 no-claude-native 비적용)", () => {
    // gemini 모드에서는 apply_no_claude_native_mode 가 early return하므로
    // TFX_NO_CLAUDE_NATIVE=1이어도 claude-native가 유지됨
    const result = runBash(
      `TFX_CLI_MODE=gemini TFX_NO_CLAUDE_NATIVE=1 bash "${ROUTE_SCRIPT}" explore 'test-case'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });

  it("TFX_CLI_MODE=codex 일 때 claude-native 에이전트는 여전히 claude-native를 반환해야 한다", () => {
    // TFX_CLI_MODE=codex는 gemini→codex 리매핑만 수행하고 claude-native는 그대로
    const result = runBash(
      `TFX_CLI_MODE=codex bash "${ROUTE_SCRIPT}" explore 'test-prompt'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });
});

// ── TFX_NO_CLAUDE_NATIVE 검증 ──

describe("tfx-route.sh — TFX_NO_CLAUDE_NATIVE 유효성 검증", () => {
  it("TFX_NO_CLAUDE_NATIVE=0 은 정상 실행되어야 한다", () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=0 bash "${ROUTE_SCRIPT}" explore 'test-prompt'`,
    );
    assert.equal(result.status, 0, out(result));
  });

  it("TFX_NO_CLAUDE_NATIVE=1 은 정상 실행되어야 한다 (codex 미설치 시 claude-native 유지)", () => {
    // 테스트 환경에서 codex가 없을 수 있으므로 종료 코드 0을 기대하되
    // claude-native 유지 또는 codex 리매핑 모두 허용
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=__nonexistent_codex__ bash "${ROUTE_SCRIPT}" explore 'test-prompt'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });

  it("TFX_NO_CLAUDE_NATIVE=2 는 오류로 종료해야 한다", () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=2 bash "${ROUTE_SCRIPT}" explore 'test-case'`,
    );
    assert.notEqual(
      result.status,
      0,
      "잘못된 TFX_NO_CLAUDE_NATIVE 값은 non-zero 종료해야 한다",
    );
    assert.match(out(result), /0 또는 1/);
  });

  it("TFX_NO_CLAUDE_NATIVE=abc 는 오류로 종료해야 한다", () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=abc bash "${ROUTE_SCRIPT}" explore 'test-case'`,
    );
    assert.notEqual(result.status, 0);
    assert.match(out(result), /0 또는 1/);
  });

  it("TFX_NO_CLAUDE_NATIVE=1 + codex 사용 가능 시 explore가 codex로 리매핑되어야 한다", () => {
    const result = runBash(
      `TFX_CLI_MODE=auto TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=codex bash "${ROUTE_SCRIPT}" explore 'test-case' minimal 5`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    // 리매핑 메시지 확인
    assert.match(out(result), /TFX_NO_CLAUDE_NATIVE=1: explore -> codex/);
  });
});

describe("tfx-route.sh — Codex MCP transport", () => {
  it("codex alias + implement(long prompt)에서도 empty phase 때문에 조기 종료되면 안 된다", () => {
    const longPrompt = `echo hi ${"x".repeat(1800)}`;
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" codex '${longPrompt}' implement`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=executor/);
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=codex/);
    assert.match(out(result), /EXEC:echo hi/);
  });

  it("TFX_CODEX_TRANSPORT=auto 기본값에서 MCP가 가능하면 MCP 경로를 우선 사용한다", () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=auto bash "${ROUTE_SCRIPT}" executor 'hello-mcp' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: "mcp-ok" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /codex_transport_effective=mcp/);
    assert.match(out(result), /MCP:hello-mcp/);
    assert.doesNotMatch(out(result), /EXEC:hello-mcp/);
  });

  it("MCP bootstrap 실패 시 auto 모드는 legacy exec 경로로 fallback한다", () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=auto bash "${ROUTE_SCRIPT}" executor 'hello-fallback' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: "mcp-fail" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /legacy exec 경로로 fallback/);
    assert.match(out(result), /codex_transport_effective=exec-fallback/);
    assert.match(out(result), /EXEC:hello-fallback/);
  });

  it("TFX_CODEX_TRANSPORT 값이 잘못되면 오류로 종료해야 한다", () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=weird bash "${ROUTE_SCRIPT}" executor 'hello' minimal`,
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /auto, mcp, exec/);
  });

  it("exit 0 이어도 stdout 비어 있고 워크스페이스 변화가 없으면 no-op 실패로 승격해야 한다", () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=exec bash "${ROUTE_SCRIPT}" executor 'hello-noop' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec-empty" }),
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /exit_code: 68/);
  });

  it("exit 0 이지만 MCP transport 채널이 죽어 stderr 노이즈만 복구된 경우 실패로 승격해야 한다(#result-verification)", () => {
    // 버그 재현: 워커가 빈손으로 죽고 recover_codex_stdout 이 stderr 크래시
    // 노이즈를 stdout 으로 backfill → 옛 가드는 `! -s STDOUT_LOG` 가 깨져 success
    // 로 오보고했다. 이제 복구 플래그 + transport 서명으로 실패(68)로 승격한다.
    const result = runBash(
      `TFX_CODEX_TRANSPORT=exec bash "${ROUTE_SCRIPT}" executor 'hello-mcp-crash' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec-mcp-crash" }),
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /exit_code: 68/);
    assert.doesNotMatch(
      out(result),
      /status: success\b/,
      "복구된 stderr 노이즈를 success 로 오보고하면 안 된다",
    );
  });

  it("진짜 stdout 산출물이 있으면 stderr 에 transport 서명이 있어도 성공을 유지해야 한다(#result-verification P3-2)", () => {
    // false-positive 경계: 진짜 출력 + 채널 teardown 로그 공존 → recover 미진입
    // (flag=0) → no_genuine_output=no → 절대 승격 안 됨. 정상 성공을 지킨다.
    const result = runBash(
      `TFX_CODEX_TRANSPORT=exec bash "${ROUTE_SCRIPT}" executor 'hello-real-output' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec-output-and-crash" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /exit_code: 0/);
    assert.doesNotMatch(
      out(result),
      /exit_code: 68/,
      "진짜 출력이 있으면 transport 서명이 있어도 승격하면 안 된다",
    );
    assert.match(out(result), /EXEC:hello-real-output/);
  });
});

describe("tfx-route.sh — 역할별 MCP profile 필터", () => {
  it("spark + auto 는 default profile로 수렴하고 최소 서버만 남겨야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" spark 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec", FAKE_CODEX_ECHO_CONFIG: "1" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=default/);
    assert.deepEqual(allowedMcpServers(result), ["context7", "brave-search"]);
  });

  it("explore + auto 는 explore profile로 수렴하고 playwright는 비활성화해야 한다", () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=codex bash "${ROUTE_SCRIPT}" explore 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec", FAKE_CODEX_ECHO_CONFIG: "1" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=explore/);
    assert.deepEqual(allowedMcpServers(result), [
      "context7",
      "brave-search",
      "tavily",
      "exa",
    ]);
  });

  it("code-reviewer + auto 는 reviewer profile로 수렴하고 context7+brave-search를 포함해야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" code-reviewer 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec", FAKE_CODEX_ECHO_CONFIG: "1" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=reviewer/);
    const servers = allowedMcpServers(result);
    assert.ok(servers.includes("context7"), `context7 포함: ${servers}`);
    assert.ok(
      servers.includes("brave-search"),
      `brave-search 포함: ${servers}`,
    );
    // sequential-thinking은 서버 설치 여부에 따라 포함/미포함 (환경 의존)
  });

  it("writer + auto 는 writer profile로 수렴하고 exa를 허용해야 한다", () => {
    const result = runBash(
      `TFX_CLI_MODE=codex CODEX_BIN=codex bash "${ROUTE_SCRIPT}" writer 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec", FAKE_CODEX_ECHO_CONFIG: "1" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=writer/);
    assert.deepEqual(allowedMcpServers(result), [
      "context7",
      "brave-search",
      "exa",
    ]);
    // exa enabled_tools 제한은 mcp-filter 내부 정책으로 적용됨 (route stderr에 미출력)
  });

  it("executor + auto 는 구현 문맥에서 context7로 축소해야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" executor 'Implement CLI parser and fix unit test using package docs' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec", FAKE_CODEX_ECHO_CONFIG: "1" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=executor/);
    assert.deepEqual(allowedMcpServers(result), ["context7"]);
  });

  it("designer + auto 는 codex 모드에서 codex용 MCP 정책으로 수렴해야 한다", () => {
    const result = runBash(
      `TFX_CLI_MODE=codex CODEX_BIN=codex bash "${ROUTE_SCRIPT}" designer 'Capture browser screenshot and inspect responsive UI layout' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec", FAKE_CODEX_ECHO_CONFIG: "1" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=designer/);
    const servers = allowedMcpServers(result);
    assert.ok(servers.includes("context7"), "context7 must be included");
    // MCP 서버 목록은 설치 환경에 따라 다를 수 있음 (playwright, tavily, exa 등)
  });
});

describe("tfx-route.sh — 검색 도구 힌트 분배", () => {
  it("TFX_WORKER_INDEX=2 일 때 analyze 검색 우선순위가 회전되어야 한다", () => {
    const result = runBash(
      `TFX_WORKER_INDEX=2 bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /worker_index=2 search_tool=auto/);
    // v2.3: 키워드 매칭 기반 동적 필터링 — 검색 도구 선택 확인
    assert.match(out(result), /(tavily|exa|brave-search)/);
  });

  it("TFX_SEARCH_TOOL=exa 일 때 exa가 analyze 우선순위 맨 앞에 와야 한다", () => {
    const result = runBash(
      `TFX_SEARCH_TOOL=exa bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /worker_index=auto search_tool=exa/);
    // v2.3: 키워드 매칭 기반 동적 필터링 — exa가 검색 도구로 선택됨을 확인
    assert.match(out(result), /exa/);
  });

  it("TFX_WORKER_INDEX 값이 0이면 오류로 종료해야 한다", () => {
    const result = runBash(
      `TFX_WORKER_INDEX=0 bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /TFX_WORKER_INDEX 값은 1 이상의 정수/);
  });

  it("TFX_SEARCH_TOOL 값이 잘못되면 오류로 종료해야 한다", () => {
    const result = runBash(
      `TFX_SEARCH_TOOL=google bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: "exec" }),
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(
      out(result),
      /TFX_SEARCH_TOOL 값은 brave-search, tavily, exa 중 하나/,
    );
  });
});

// ── 오류 케이스 ──

describe("tfx-route.sh — 오류 케이스", () => {
  it("알 수 없는 에이전트 타입은 non-zero로 종료하고 오류 메시지를 출력해야 한다", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" unknown-agent 'test-prompt'`,
    );
    assert.notEqual(result.status, 0);
    assert.match(out(result), /알 수 없는 에이전트 타입/);
  });

  it("에이전트 타입 인자 없으면 non-zero로 종료해야 한다", () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}"`);
    assert.notEqual(result.status, 0);
  });

  it("프롬프트 인자 없으면 non-zero로 종료해야 한다", () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" executor`);
    assert.notEqual(result.status, 0);
  });

  it("CLI 이름(codex)을 역할 자리에 사용하면 alias로 허용된다 (type=codex 메타 출력)", () => {
    const result = runBash(
      `CODEX_BIN=false bash "${ROUTE_SCRIPT}" codex 'test-prompt' 2>&1 || true`,
    );
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=codex/);
  });

  it("CLI 이름(gemini)을 역할 자리에 사용하면 antigravity alias로 허용된다", () => {
    const result = runBash(
      `GEMINI_BIN=false bash "${ROUTE_SCRIPT}" gemini 'test-prompt' 2>&1 || true`,
      fixtureEnv({ TFX_ANTIGRAVITY_OK: "1", AGY_BIN: "agy" }),
    );
    assert.match(out(result), /type=antigravity/);
    assert.match(out(result), /agent=gemini/);
  });

  it("CLI 이름(claude)을 역할 자리에 사용하면 alias로 허용된다 (ROUTE_TYPE=claude-native)", () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" claude 'test-prompt' 2>&1`);
    assert.equal(result.status, 0);
    assert.match(out(result), /ROUTE_TYPE=claude-native|claude-native/);
  });

  it("MCP 프로필 위치에 --flag가 오면 exit 64", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" code-reviewer 'test-prompt' --cli codex`,
    );
    assert.equal(result.status, 64);
    assert.match(out(result), /플래그.*들어왔습니다/);
  });

  it("MCP 프로필 위치에 --verbose가 오면 exit 64", () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" executor 'test-prompt' --verbose`,
    );
    assert.equal(result.status, 64);
    assert.match(out(result), /플래그.*들어왔습니다/);
  });
});

// ── 라우팅 테이블 검증 ──

describe("tfx-route.sh — 라우팅 테이블 메타데이터", () => {
  it("executor 에이전트는 type=codex 메타데이터를 출력해야 한다", () => {
    // executor는 codex 타입이므로 실제 codex 실행 시도 — CODEX_BIN=false로 빠른 실패 유도
    // 하지만 메타정보는 stderr에 출력됨
    const result = runBash(
      `CODEX_BIN=false bash "${ROUTE_SCRIPT}" executor 'test' 2>&1 || true`,
    );
    // stderr에 type=codex 메타정보 포함 확인
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=executor/);
  });

  it("designer 에이전트는 type=antigravity 메타데이터를 출력해야 한다", () => {
    const result = runBash(
      `GEMINI_BIN=false bash "${ROUTE_SCRIPT}" designer 'test' 2>&1 || true`,
      fixtureEnv({ TFX_ANTIGRAVITY_OK: "1", AGY_BIN: "agy" }),
    );
    assert.match(out(result), /type=antigravity/);
    assert.match(out(result), /agent=designer/);
  });
});

// ── executor 라우팅 회귀 방지 (근본 원인: OMC executor agent는 Claude Sonnet, route.sh 경유 안 함) ──

describe("tfx-route.sh — executor 라우팅 회귀 방지", {
  timeout: 180000,
}, () => {
  it("executor + TFX_NO_CLAUDE_NATIVE=1 + fixture codex → type=codex 유지", () => {
    // CODEX_BIN이 가용한 상태에서 executor는 기본적으로 codex로 라우팅된다.
    // TFX_NO_CLAUDE_NATIVE=1은 이 경로에서 no-op (apply_no_claude_native_mode는
    // CLI_TYPE이 이미 claude-native일 때만 동작). executor가 codex로 라우팅됨을 확인.
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" executor 'test-prompt' implement`,
      fixtureEnv({ TFX_NO_CLAUDE_NATIVE: "1", FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=codex/, out(result));
    assert.match(out(result), /agent=executor/, out(result));
  });

  it("executor + TFX_NO_CLAUDE_NATIVE=1 + CODEX_BIN 미설치 + agy 사용 가능 → antigravity fallback", () => {
    // codex가 없어도 agy headless가 사용 가능하면 claude-native가 아니라
    // Antigravity로 폴백해야 한다. 실제 agy 바이너리를 치지 않도록 fixture를 사용한다.
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=__nonexistent_codex__ GEMINI_BIN=__nonexistent_gemini__ bash "${ROUTE_SCRIPT}" executor 'test-prompt' implement`,
      fixtureEnv({ TFX_ANTIGRAVITY_OK: "1", AGY_BIN: "agy" }),
    );
    assert.equal(result.status, 0, out(result));
    const combined = out(result);
    assert.match(combined, /type=antigravity|cli: antigravity/, combined);
    assert.match(combined, /TFX_CLI_MODE=antigravity/, combined);
    assert.doesNotMatch(combined, /gemini-worker|type=gemini/, combined);
  });
});

// ── TFX_FORCE_CODEX_BYPASS escape hatch 회귀 방지 (deep-review L3) ──

describe("tfx-route.sh — TFX_FORCE_CODEX_BYPASS escape hatch", {
  timeout: 180000,
}, () => {
  it("TFX_FORCE_CODEX_BYPASS=1 → 라우팅 정상 동작 + type=codex 유지", () => {
    // escape hatch가 활성이어도 라우팅이 깨지지 않아야 한다.
    // 실제 --dangerously-bypass 플래그 방출은 awk edge case 테스트에서 검증.
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" executor 'test-prompt' implement`,
      fixtureEnv({ TFX_FORCE_CODEX_BYPASS: "1", FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=codex/, out(result));
    assert.match(out(result), /agent=executor/, out(result));
  });

  it("TFX_FORCE_CODEX_BYPASS=0 → 정상 경로로 라우팅, type=codex 유지", () => {
    // escape hatch 비활성 시에도 동일하게 type=codex로 라우팅되어야 한다.
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" executor 'test-prompt' implement`,
      fixtureEnv({ TFX_FORCE_CODEX_BYPASS: "0", FAKE_CODEX_MODE: "exec" }),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=codex/, out(result));
    assert.match(out(result), /agent=executor/, out(result));
  });
});
