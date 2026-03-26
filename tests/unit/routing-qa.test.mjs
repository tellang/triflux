import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  loadRules,
  compileRules,
  matchRules,
  resolveConflicts,
} from "../../scripts/lib/keyword-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const RULES_PATH = join(ROOT, "hooks/keyword-rules.json");
const ROUTE_SH = join(ROOT, "scripts/tfx-route.sh").replace(/\\/g, "/");

// ── 헬퍼: route_agent 라우팅 테이블을 소스에서 직접 파싱 ──
// bash 실행 대신 소스 파일에서 case 문을 정규식으로 파싱하여 JS 매핑 생성
function parseRouteTable() {
  const src = readFileSync(join(ROOT, "scripts/tfx-route.sh"), "utf8");
  // route_agent 함수 블록 추출
  const funcMatch = src.match(/route_agent\(\)\s*\{([\s\S]*?)^\}/m);
  if (!funcMatch) return {};

  const funcBody = funcMatch[1];
  const table = {};
  // 패턴: agent-name) ... CLI_TYPE="xxx" ... CLI_EFFORT="yyy" ... RUN_MODE="zzz" ... ;;
  const caseRe = /^\s+(\S+(?:\|[^\)]+)?)\)\s*\n([\s\S]*?)\s*;;\s*$/gm;
  let m;
  while ((m = caseRe.exec(funcBody)) !== null) {
    const agents = m[1].split("|").map((a) => a.trim());
    const block = m[2];
    const cliType = block.match(/CLI_TYPE="([^"]+)"/)?.[1] || null;
    const effort = block.match(/CLI_EFFORT="([^"]+)"/)?.[1] || null;
    const runMode = block.match(/RUN_MODE="([^"]+)"/)?.[1] || null;
    for (const agent of agents) {
      table[agent] = { CLI_TYPE: cliType, CLI_EFFORT: effort, RUN_MODE: runMode };
    }
  }
  return table;
}

const ROUTE_TABLE = parseRouteTable();

// ── keyword-rules 로드 ──
const rawRules = loadRules(RULES_PATH);
const compiled = compileRules(rawRules);

// ========================================================================
// 1. keyword-rules: tfx-auto 라우팅
// ========================================================================
describe("keyword-rules: tfx-auto 매칭", () => {
  it("'tfx-auto' 입력 시 tfx-auto 스킬로 라우팅", () => {
    const matches = matchRules(compiled, "tfx-auto 인증 리팩터링");
    const resolved = resolveConflicts(matches);
    const skills = resolved.map((r) => r.skill).filter(Boolean);
    assert.ok(skills.includes("tfx-auto"), `tfx-auto가 포함되어야 함: ${JSON.stringify(skills)}`);
  });

  it("'tfx auto' (공백) 입력도 매칭", () => {
    const matches = matchRules(compiled, "tfx auto 코드 리뷰");
    const resolved = resolveConflicts(matches);
    assert.ok(resolved.some((r) => r.skill === "tfx-auto"));
  });

  it("'tfxauto' (붙여쓰기)도 매칭", () => {
    const matches = matchRules(compiled, "tfxauto 빌드");
    const resolved = resolveConflicts(matches);
    assert.ok(resolved.some((r) => r.skill === "tfx-auto"));
  });

  it("'my tfx-auto' 같은 문맥에서도 매칭됨 (negative lookbehind는 multi 전용)", () => {
    const matches = matchRules(compiled, "run tfx-auto now");
    assert.ok(matches.some((r) => r.skill === "tfx-auto"));
  });
});

// ========================================================================
// 2. keyword-rules: tfx-multi 라우팅
// ========================================================================
describe("keyword-rules: tfx-multi 매칭", () => {
  it("'tfx-multi' 입력 시 tfx-multi 스킬로 라우팅", () => {
    const matches = matchRules(compiled, "tfx-multi 인증+UI+테스트");
    const resolved = resolveConflicts(matches);
    assert.ok(resolved.some((r) => r.skill === "tfx-multi"));
  });

  it("'tfx multi' (공백)도 매칭", () => {
    const matches = matchRules(compiled, "tfx multi --quick 작업");
    const resolved = resolveConflicts(matches);
    assert.ok(resolved.some((r) => r.skill === "tfx-multi"));
  });

  it("tfx-multi는 priority 1 — tfx-auto(priority 2)보다 우선", () => {
    const matches = matchRules(compiled, "tfx-multi와 tfx-auto 같이 쓰기");
    const resolved = resolveConflicts(matches);
    // tfx-multi가 먼저 나와야 함
    assert.equal(resolved[0].skill, "tfx-multi");
  });

  it("'omc tfx-multi' 같은 lookbehind 패턴은 미매칭", () => {
    const matches = matchRules(compiled, "omc tfx-multi test");
    // omc/oh-my-claudecode 접두사 시 미매칭이어야 함
    const multiMatch = matches.filter((r) => r.id === "tfx-multi");
    assert.equal(multiMatch.length, 0, "omc 접두사 시 tfx-multi가 매칭되면 안 됨");
  });
});

// ========================================================================
// 3. keyword-rules: 충돌 해결 (supersedes, exclusive)
// ========================================================================
describe("keyword-rules: 충돌 해결", () => {
  it("tfx-cancel은 exclusive — 다른 모든 스킬 억제", () => {
    const matches = matchRules(compiled, "canceltfx tfx-auto");
    const resolved = resolveConflicts(matches);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].skill, "tfx-cancel");
  });

  it("tfx-auto-codex는 tfx-auto를 supersede", () => {
    const matches = matchRules(compiled, "tfx-auto-codex 리팩터링");
    const resolved = resolveConflicts(matches);
    // tfx-auto-codex가 포함되고 tfx-auto는 suppressed
    const skills = resolved.map((r) => r.skill);
    assert.ok(skills.includes("tfx-auto-codex"));
    assert.ok(!skills.includes("tfx-auto"), "tfx-auto가 superseded되어야 함");
  });

  it("MCP 라우트: notion 키워드 → gemini 라우트", () => {
    const matches = matchRules(compiled, "노션 페이지 조회");
    const resolved = resolveConflicts(matches);
    assert.ok(resolved.some((r) => r.mcp_route === "gemini"));
  });

  it("MCP 라우트: jira 키워드 → codex 라우트", () => {
    const matches = matchRules(compiled, "jira 이슈 생성");
    const resolved = resolveConflicts(matches);
    assert.ok(resolved.some((r) => r.mcp_route === "codex"));
  });
});

// ========================================================================
// 4. route_agent(): 에이전트→CLI 매핑 (소스 파싱)
// ========================================================================
describe("route_agent: 에이전트→CLI 매핑", () => {
  it("라우팅 테이블이 비어있지 않아야 함", () => {
    assert.ok(Object.keys(ROUTE_TABLE).length > 10, `최소 10개 이상 에이전트 정의 필요: ${Object.keys(ROUTE_TABLE).length}`);
  });

  const codexAgents = [
    "executor", "build-fixer", "debugger", "architect",
    "planner", "analyst", "code-reviewer", "scientist",
  ];

  for (const agent of codexAgents) {
    it(`${agent} → codex`, () => {
      const r = ROUTE_TABLE[agent];
      assert.ok(r, `${agent}가 라우팅 테이블에 있어야 함`);
      assert.equal(r.CLI_TYPE, "codex", `${agent}는 codex여야 함 (got: ${r.CLI_TYPE})`);
    });
  }

  it("designer → gemini", () => {
    assert.equal(ROUTE_TABLE["designer"]?.CLI_TYPE, "gemini");
  });

  it("writer → gemini", () => {
    assert.equal(ROUTE_TABLE["writer"]?.CLI_TYPE, "gemini");
  });

  it("explore → claude-native", () => {
    // explore|verifier|test-engineer|qa-tester 는 합성 키
    const key = Object.keys(ROUTE_TABLE).find((k) => k.includes("explore"));
    assert.ok(key, "explore 에이전트가 있어야 함");
    assert.equal(ROUTE_TABLE[key].CLI_TYPE, "claude-native");
  });

  it("알 수 없는 에이전트는 테이블에 없음", () => {
    assert.equal(ROUTE_TABLE["unknown-agent-xyz"], undefined);
  });
});

// ========================================================================
// 5. route_agent(): effort/timeout 매핑
// ========================================================================
describe("route_agent: effort 레벨 검증", () => {
  it("executor → high effort", () => {
    assert.equal(ROUTE_TABLE["executor"]?.CLI_EFFORT, "high");
  });

  it("build-fixer → fast effort", () => {
    assert.equal(ROUTE_TABLE["build-fixer"]?.CLI_EFFORT, "fast");
  });

  it("deep-executor → xhigh effort", () => {
    assert.equal(ROUTE_TABLE["deep-executor"]?.CLI_EFFORT, "xhigh");
  });

  it("spark → spark_fast effort", () => {
    assert.equal(ROUTE_TABLE["spark"]?.CLI_EFFORT, "spark_fast");
  });

  it("code-reviewer → thorough effort", () => {
    assert.equal(ROUTE_TABLE["code-reviewer"]?.CLI_EFFORT, "thorough");
  });

  it("codex alias → high effort (executor와 동일)", () => {
    assert.equal(ROUTE_TABLE["codex"]?.CLI_EFFORT, "high");
  });

  it("gemini alias → pro effort", () => {
    assert.equal(ROUTE_TABLE["gemini"]?.CLI_EFFORT, "pro");
  });
});

// ========================================================================
// 6. headless.mjs: buildHeadlessCommand 검증
// ========================================================================
describe("headless: buildHeadlessCommand", async () => {
  const { buildHeadlessCommand } = await import("../../hub/team/headless.mjs");

  it("codex → codex exec ... --color never", () => {
    const cmd = buildHeadlessCommand("codex", "hello world", "/tmp/result.txt");
    assert.ok(cmd.includes("codex exec"), `codex exec가 포함되어야 함: ${cmd}`);
    assert.ok(cmd.includes("--color never"));
    assert.ok(cmd.includes("/tmp/result.txt"));
  });

  it("gemini → gemini -p ... -o text > result", () => {
    const cmd = buildHeadlessCommand("gemini", "test prompt", "/tmp/result.txt");
    assert.ok(cmd.includes("gemini -p"));
    assert.ok(cmd.includes("-o text"));
    assert.ok(cmd.includes("> '/tmp/result.txt'"));
  });

  it("claude → claude -p ... --output-format text", () => {
    const cmd = buildHeadlessCommand("claude", "test prompt", "/tmp/result.txt");
    assert.ok(cmd.includes("claude -p"));
    assert.ok(cmd.includes("--output-format text"));
  });

  it("프롬프트의 단일인용부호 이스케이프", () => {
    const cmd = buildHeadlessCommand("codex", "it's a test", "/tmp/r.txt");
    assert.ok(cmd.includes("it''s a test"), `단일인용부호가 이스케이프되어야 함: ${cmd}`);
  });

  it("지원하지 않는 CLI → throw", () => {
    assert.throws(() => buildHeadlessCommand("unknown", "prompt", "/tmp/r.txt"), /지원하지 않는/);
  });

  it("에이전트 역할명 → CLI 타입 자동 해석 (resolveCliType)", () => {
    const cmd = buildHeadlessCommand("executor", "fix bug", "/tmp/r.txt");
    assert.ok(cmd.includes("codex exec"), `executor → codex: ${cmd}`);
    const cmd2 = buildHeadlessCommand("designer", "make ui", "/tmp/r.txt");
    assert.ok(cmd2.includes("gemini"), `designer → gemini: ${cmd2}`);
  });

  it("MCP 프로필 힌트 주입 (implement)", () => {
    const cmd = buildHeadlessCommand("codex", "test", "/tmp/r.txt", { handoff: false, mcp: "implement" });
    assert.ok(cmd.includes("[MCP: implement]"), `implement 힌트가 포함되어야 함: ${cmd}`);
  });

  it("MCP 프로필 없으면 힌트 미삽입", () => {
    const cmd = buildHeadlessCommand("codex", "test", "/tmp/r.txt", { handoff: false });
    assert.ok(!cmd.includes("[MCP:"), `MCP 힌트가 없어야 함: ${cmd}`);
  });

  it("알 수 없는 MCP 프로필은 무시", () => {
    const cmd = buildHeadlessCommand("codex", "test", "/tmp/r.txt", { handoff: false, mcp: "bogus" });
    assert.ok(!cmd.includes("[MCP:"), `알 수 없는 MCP 힌트가 없어야 함: ${cmd}`);
  });
});

// ========================================================================
// 7. headless.mjs: WT pane 정리 로직 존재 검증 (코드 구조)
// ========================================================================
describe("headless: WT pane 정리 — 수동 close-pane 제거 (레이스 컨디션 fix)", () => {
  it("close-pane 수동 호출이 없어야 함 (psmux 종료 시 자동 닫힘)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(ROOT, "hub/team/headless.mjs"), "utf8");

    // close-pane 수동 호출이 제거되었는지 확인
    assert.ok(
      !src.includes('wt.exe -w 0 close-pane'),
      "wt.exe close-pane 수동 호출이 없어야 함 (레이스 컨디션)"
    );
  });

  it("killPsmuxSession은 runHeadlessWithCleanup과 handle.kill() 양쪽에 존재", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(ROOT, "hub/team/headless.mjs"), "utf8");

    const killCount = (src.match(/killPsmuxSession/g) || []).length;
    assert.ok(killCount >= 2, `killPsmuxSession이 최소 2곳에 있어야 함 (got: ${killCount})`);
  });
});

// ========================================================================
// 8. 엔드투엔드: tfx-route.sh 기본 실행 검증
// ========================================================================
describe("tfx-route.sh: 기본 검증", () => {
  it("--help 없이 인자 없으면 에러 (에이전트 타입 필수)", () => {
    try {
      execSync(`bash "${ROUTE_SH}" 2>&1`, { encoding: "utf8", timeout: 5000 });
      assert.fail("인자 없이 실행 시 에러가 나야 함");
    } catch (e) {
      assert.ok(
        e.status !== 0,
        "종료 코드가 0이 아니어야 함"
      );
    }
  });

  it("--job-status: 존재하지 않는 job → 에러", () => {
    try {
      execSync(`bash "${ROUTE_SH}" --job-status nonexistent-job-id 2>&1`, {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.fail("존재하지 않는 job은 에러여야 함");
    } catch (e) {
      assert.ok(e.stdout?.includes("error") || e.stderr?.includes("error"));
    }
  });

  it("버전 문자열이 2.x 형식", () => {
    const src = readFileSync(join(ROOT, "scripts/tfx-route.sh"), "utf8");
    const vMatch = src.match(/^VERSION="?([\d.]+)"?/m);
    assert.ok(vMatch, "VERSION= 선언이 있어야 함");
    assert.match(vMatch[1], /^2\.\d+$/, `버전이 2.x 형식이어야 함: ${vMatch[1]}`);
  });
});
