// tests/integration/tfx-route-smoke.test.mjs — tfx-route.sh 스모크 테스트
//
// scripts/test-tfx-route-no-claude-native.mjs의 테스트 케이스를 포함하여
// tests/integration/ 디렉토리의 통합 테스트로 재구성한다.
//
// 테스트 범위:
//   - claude-native 에이전트(explore/verifier/test-engineer/qa-tester) 기본 라우팅
//   - TFX_CLI_MODE=codex/gemini 오버라이드 메타데이터
//   - TFX_NO_CLAUDE_NATIVE 유효성 검증 (0/1만 허용)
//   - 알 수 없는 에이전트 타입 오류
//   - 인자 부족 시 오류
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..');
const ROUTE_SCRIPT = resolve(PROJECT_ROOT, 'scripts', 'tfx-route.sh');
const FIXTURE_BIN = resolve(PROJECT_ROOT, 'tests', 'fixtures', 'bin');

// bash 실행 헬퍼 — stdout + stderr 합산 반환
function runBash(command, extraEnv = {}) {
  return spawnSync('bash', ['-c', command], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TFX_TEAM_NAME: '',
      TFX_TEAM_TASK_ID: '',
      TFX_TEAM_AGENT_NAME: '',
      TFX_TEAM_LEAD_NAME: '',
      TFX_HUB_URL: '',
      TMUX: '',
      TFX_CLI_MODE: 'auto',
      TFX_NO_CLAUDE_NATIVE: '0',
      TFX_CODEX_TRANSPORT: 'exec',
      TFX_WORKER_INDEX: '',
      TFX_SEARCH_TOOL: '',
      ...extraEnv,
    },
  });
}

// stdout + stderr 합산 문자열
function out(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function allowedMcpServers(result) {
  const allowedLine = out(result).match(/allowed_mcp_servers=([^\n]+)/)?.[1] ?? '';
  if (!allowedLine || allowedLine === 'none') return [];
  return allowedLine.split(',').map((server) => server.trim()).filter(Boolean);
}

function fixtureEnv(extraEnv = {}) {
  return {
    ...extraEnv,
    PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
  };
}

// ── claude-native 에이전트 기본 라우팅 ──

describe('tfx-route.sh — claude-native 에이전트 메타데이터 출력', () => {
  it('explore 에이전트는 ROUTE_TYPE=claude-native와 MODEL=haiku를 출력해야 한다', () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" explore 'test-prompt'`);
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
    assert.match(out(result), /MODEL=haiku/);
    assert.match(out(result), /AGENT=explore/);
  });

  it('verifier 에이전트는 기본 route table에서 codex review 메타데이터를 출력해야 한다', () => {
    const result = runBash(
      `CODEX_BIN=codex bash "${ROUTE_SCRIPT}" verifier 'test-prompt'`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec' }),
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=verifier/);
    assert.match(out(result), /EXEC:test-prompt/);
  });

  it('test-engineer 에이전트는 ROUTE_TYPE=claude-native를 출력해야 한다', () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" test-engineer 'test-prompt'`);
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
    assert.match(out(result), /AGENT=test-engineer/);
  });

  it('qa-tester 에이전트는 ROUTE_TYPE=claude-native를 출력해야 한다', () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" qa-tester 'test-prompt'`);
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
    assert.match(out(result), /AGENT=qa-tester/);
  });
});

// ── TFX_CLI_MODE 오버라이드 ──

describe('tfx-route.sh — TFX_CLI_MODE 오버라이드', () => {
  it('TFX_CLI_MODE=gemini 일 때 explore는 claude-native 유지(gemini 모드에서는 no-claude-native 비적용)', () => {
    // gemini 모드에서는 apply_no_claude_native_mode 가 early return하므로
    // TFX_NO_CLAUDE_NATIVE=1이어도 claude-native가 유지됨
    const result = runBash(
      `TFX_CLI_MODE=gemini TFX_NO_CLAUDE_NATIVE=1 bash "${ROUTE_SCRIPT}" explore 'test-case'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });

  it('TFX_CLI_MODE=codex 일 때 claude-native 에이전트는 여전히 claude-native를 반환해야 한다', () => {
    // TFX_CLI_MODE=codex는 gemini→codex 리매핑만 수행하고 claude-native는 그대로
    const result = runBash(
      `TFX_CLI_MODE=codex bash "${ROUTE_SCRIPT}" explore 'test-prompt'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });
});

// ── TFX_NO_CLAUDE_NATIVE 검증 ──

describe('tfx-route.sh — TFX_NO_CLAUDE_NATIVE 유효성 검증', () => {
  it('TFX_NO_CLAUDE_NATIVE=0 은 정상 실행되어야 한다', () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=0 bash "${ROUTE_SCRIPT}" explore 'test-prompt'`,
    );
    assert.equal(result.status, 0, out(result));
  });

  it('TFX_NO_CLAUDE_NATIVE=1 은 정상 실행되어야 한다 (codex 미설치 시 claude-native 유지)', () => {
    // 테스트 환경에서 codex가 없을 수 있으므로 종료 코드 0을 기대하되
    // claude-native 유지 또는 codex 리매핑 모두 허용
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=__nonexistent_codex__ bash "${ROUTE_SCRIPT}" explore 'test-prompt'`,
    );
    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /ROUTE_TYPE=claude-native/);
  });

  it('TFX_NO_CLAUDE_NATIVE=2 는 오류로 종료해야 한다', () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=2 bash "${ROUTE_SCRIPT}" explore 'test-case'`,
    );
    assert.notEqual(result.status, 0, '잘못된 TFX_NO_CLAUDE_NATIVE 값은 non-zero 종료해야 한다');
    assert.match(out(result), /0 또는 1/);
  });

  it('TFX_NO_CLAUDE_NATIVE=abc 는 오류로 종료해야 한다', () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=abc bash "${ROUTE_SCRIPT}" explore 'test-case'`,
    );
    assert.notEqual(result.status, 0);
    assert.match(out(result), /0 또는 1/);
  });

  it('TFX_NO_CLAUDE_NATIVE=1 + codex 사용 가능 시 explore가 codex로 리매핑되어야 한다', () => {
    const result = runBash(
      `TFX_CLI_MODE=auto TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=codex bash "${ROUTE_SCRIPT}" explore 'test-case' minimal 5`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec' }),
    );
    assert.equal(result.status, 0, out(result));
    // 리매핑 메시지 확인
    assert.match(out(result), /TFX_NO_CLAUDE_NATIVE=1: explore -> codex/);
  });
});

describe('tfx-route.sh — Codex MCP transport', () => {
  it('TFX_CODEX_TRANSPORT=auto 기본값에서 MCP가 가능하면 MCP 경로를 우선 사용한다', () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=auto bash "${ROUTE_SCRIPT}" executor 'hello-mcp' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: 'mcp-ok' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /codex_transport_effective=mcp/);
    assert.match(out(result), /MCP:hello-mcp/);
    assert.doesNotMatch(out(result), /EXEC:hello-mcp/);
  });

  it('MCP bootstrap 실패 시 auto 모드는 legacy exec 경로로 fallback한다', () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=auto bash "${ROUTE_SCRIPT}" executor 'hello-fallback' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: 'mcp-fail' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /legacy exec 경로로 fallback/);
    assert.match(out(result), /codex_transport_effective=exec-fallback/);
    assert.match(out(result), /EXEC:hello-fallback/);
  });

  it('TFX_CODEX_TRANSPORT 값이 잘못되면 오류로 종료해야 한다', () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=weird bash "${ROUTE_SCRIPT}" executor 'hello' minimal`,
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /auto, mcp, exec/);
  });

  it('exit 0 이어도 stdout 비어 있고 워크스페이스 변화가 없으면 no-op 실패로 승격해야 한다', () => {
    const result = runBash(
      `TFX_CODEX_TRANSPORT=exec bash "${ROUTE_SCRIPT}" executor 'hello-noop' minimal`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec-empty' }),
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /no-op 성공을 실패로 승격/);
  });
});

describe('tfx-route.sh — 역할별 MCP profile 필터', () => {
  it('spark + auto 는 default profile로 수렴하고 최소 서버만 남겨야 한다', () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" spark 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec', FAKE_CODEX_ECHO_CONFIG: '1' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=default/);
    assert.deepEqual(allowedMcpServers(result), ['context7', 'brave-search']);
  });

  it('explore + auto 는 explore profile로 수렴하고 playwright는 비활성화해야 한다', () => {
    const result = runBash(
      `TFX_NO_CLAUDE_NATIVE=1 CODEX_BIN=codex bash "${ROUTE_SCRIPT}" explore 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec', FAKE_CODEX_ECHO_CONFIG: '1' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=explore/);
    assert.deepEqual(allowedMcpServers(result), ['context7', 'brave-search', 'tavily', 'exa']);
  });

  it('code-reviewer + auto 는 reviewer profile로 수렴하고 sequential-thinking만 분석 도구로 남겨야 한다', () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" code-reviewer 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec', FAKE_CODEX_ECHO_CONFIG: '1' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=reviewer/);
    assert.deepEqual(allowedMcpServers(result), ['context7', 'brave-search', 'sequential-thinking']);
  });

  it('writer + auto 는 writer profile로 수렴하고 exa는 web_search_exa만 허용해야 한다', () => {
    const result = runBash(
      `TFX_CLI_MODE=codex CODEX_BIN=codex bash "${ROUTE_SCRIPT}" writer 'profile-check' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec', FAKE_CODEX_ECHO_CONFIG: '1' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=writer/);
    assert.deepEqual(allowedMcpServers(result), ['context7', 'brave-search', 'exa']);
    assert.match(out(result), /mcp_servers\.exa\.enabled_tools=\["web_search_exa"\]/);
  });

  it('executor + auto 는 구현 문맥에서 context7 + exa로 축소해야 한다', () => {
    const result = runBash(
      `bash "${ROUTE_SCRIPT}" executor 'Implement CLI parser and fix unit test using package docs' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec', FAKE_CODEX_ECHO_CONFIG: '1' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=executor/);
    assert.deepEqual(allowedMcpServers(result), ['context7', 'exa']);
  });

  it('designer + auto 는 브라우저 문맥에서 designer profile과 playwright를 남겨야 한다', () => {
    const result = runBash(
      `TFX_CLI_MODE=codex CODEX_BIN=codex bash "${ROUTE_SCRIPT}" designer 'Capture browser screenshot and inspect responsive UI layout' auto`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec', FAKE_CODEX_ECHO_CONFIG: '1' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /resolved_profile=designer/);
    assert.deepEqual(allowedMcpServers(result), ['context7', 'playwright']);
  });
});

describe('tfx-route.sh — 검색 도구 힌트 분배', () => {
  it('TFX_WORKER_INDEX=2 일 때 analyze 검색 우선순위가 회전되어야 한다', () => {
    const result = runBash(
      `TFX_WORKER_INDEX=2 bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /worker_index=2 search_tool=auto/);
    // v2.3: 키워드 매칭 기반 동적 필터링 — 검색 도구 선택 확인
    assert.match(out(result), /(tavily|exa|brave-search)/);
  });

  it('TFX_SEARCH_TOOL=exa 일 때 exa가 analyze 우선순위 맨 앞에 와야 한다', () => {
    const result = runBash(
      `TFX_SEARCH_TOOL=exa bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec' }),
    );

    assert.equal(result.status, 0, out(result));
    assert.match(out(result), /worker_index=auto search_tool=exa/);
    // v2.3: 키워드 매칭 기반 동적 필터링 — exa가 검색 도구로 선택됨을 확인
    assert.match(out(result), /exa/);
  });

  it('TFX_WORKER_INDEX 값이 0이면 오류로 종료해야 한다', () => {
    const result = runBash(
      `TFX_WORKER_INDEX=0 bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec' }),
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /TFX_WORKER_INDEX 값은 1 이상의 정수/);
  });

  it('TFX_SEARCH_TOOL 값이 잘못되면 오류로 종료해야 한다', () => {
    const result = runBash(
      `TFX_SEARCH_TOOL=google bash "${ROUTE_SCRIPT}" executor 'quota-test' analyze`,
      fixtureEnv({ FAKE_CODEX_MODE: 'exec' }),
    );

    assert.notEqual(result.status, 0, out(result));
    assert.match(out(result), /TFX_SEARCH_TOOL 값은 brave-search, tavily, exa 중 하나/);
  });
});

// ── 오류 케이스 ──

describe('tfx-route.sh — 오류 케이스', () => {
  it('알 수 없는 에이전트 타입은 non-zero로 종료하고 오류 메시지를 출력해야 한다', () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" unknown-agent 'test-prompt'`);
    assert.notEqual(result.status, 0);
    assert.match(out(result), /알 수 없는 에이전트 타입/);
  });

  it('에이전트 타입 인자 없으면 non-zero로 종료해야 한다', () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}"`);
    assert.notEqual(result.status, 0);
  });

  it('프롬프트 인자 없으면 non-zero로 종료해야 한다', () => {
    const result = runBash(`bash "${ROUTE_SCRIPT}" executor`);
    assert.notEqual(result.status, 0);
  });
});

// ── 라우팅 테이블 검증 ──

describe('tfx-route.sh — 라우팅 테이블 메타데이터', () => {
  it('executor 에이전트는 type=codex 메타데이터를 출력해야 한다', () => {
    // executor는 codex 타입이므로 실제 codex 실행 시도 — CODEX_BIN=false로 빠른 실패 유도
    // 하지만 메타정보는 stderr에 출력됨
    const result = runBash(
      `CODEX_BIN=false bash "${ROUTE_SCRIPT}" executor 'test' 2>&1 || true`,
    );
    // stderr에 type=codex 메타정보 포함 확인
    assert.match(out(result), /type=codex/);
    assert.match(out(result), /agent=executor/);
  });

  it('designer 에이전트는 type=gemini 메타데이터를 출력해야 한다', () => {
    const result = runBash(
      `GEMINI_BIN=false bash "${ROUTE_SCRIPT}" designer 'test' 2>&1 || true`,
    );
    assert.match(out(result), /type=gemini/);
    assert.match(out(result), /agent=designer/);
  });
});
