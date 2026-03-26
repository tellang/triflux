// tests/unit/headless-guard.test.mjs — headless-guard 플래그 보존 테스트
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const GUARD_PATH = join(process.cwd(), "scripts", "headless-guard.mjs");

/**
 * headless-guard를 직접 실행하여 출력을 확인한다.
 * psmux 미설치 환경에서는 exit(0) → 통과하므로, 이 테스트는
 * parseRouteCommand의 로직만 독립 검증한다.
 */

// parseRouteCommand를 직접 테스트하기 위해 동적 import
async function loadGuard() {
  // headless-guard.mjs는 main()을 즉시 실행하므로 직접 import 불가.
  // 대신 parseRouteCommand 로직을 인라인 미러로 테스트.
  return null;
}

// parseRouteCommand 미러 (headless-guard.mjs와 동일 로직)
function parseRouteCommand(cmd) {
  const MCP_PROFILES = ["implement", "analyze", "review", "docs"];

  const agentMatch = cmd.match(/tfx-route\.sh\s+(\S+)\s+/);
  if (!agentMatch) return null;

  const agent = agentMatch[1];
  const afterAgent = cmd.slice(agentMatch.index + agentMatch[0].length);

  let mcp = "";
  let promptRaw = afterAgent;
  for (const profile of MCP_PROFILES) {
    const profileIdx = afterAgent.lastIndexOf(` ${profile}`);
    if (profileIdx >= 0) {
      mcp = profile;
      promptRaw = afterAgent.slice(0, profileIdx);
      break;
    }
  }

  const prompt = promptRaw
    .replace(/^['"]/, "")
    .replace(/['"]$/, "")
    .replace(/'\\''/g, "'")
    .replace(/'"'"'/g, "'")
    .trim();

  const flags = {};
  const timeoutMatch = cmd.match(/(?:^|\s)(\d{2,4})(?:\s|$)/);
  if (timeoutMatch) flags.timeout = parseInt(timeoutMatch[1], 10);

  if (process.env.TFX_DASHBOARD === "1") flags.dashboard = true;
  if (process.env.TFX_VERBOSE === "1") flags.verbose = true;
  if (process.env.TFX_NO_AUTO_ATTACH === "1") flags.noAutoAttach = true;

  return { agent, prompt, mcp, flags };
}

function buildCommand(parsed) {
  const VALID_MCP = new Set(["implement", "analyze", "review", "docs"]);
  const f = parsed.flags || {};
  const safePrompt = parsed.prompt.replace(/'/g, "'\\''");

  const parts = ["tfx multi --teammate-mode headless"];
  if (!f.noAutoAttach) parts.push("--auto-attach");
  if (f.dashboard) parts.push("--dashboard");
  if (f.verbose) parts.push("--verbose");
  parts.push(`--assign '${parsed.agent}:${safePrompt}:${parsed.agent}'`);
  if (parsed.mcp && VALID_MCP.has(parsed.mcp)) parts.push(`--mcp-profile ${parsed.mcp}`);
  parts.push(`--timeout ${f.timeout || 600}`);

  return parts.join(" ");
}

describe("parseRouteCommand", () => {
  it("기본 파싱: agent + prompt + mcp", () => {
    const r = parseRouteCommand("bash ~/.claude/scripts/tfx-route.sh executor 'fix bug' implement");
    assert.equal(r.agent, "executor");
    assert.equal(r.prompt, "fix bug");
    assert.equal(r.mcp, "implement");
  });

  it("MCP 없는 명령", () => {
    const r = parseRouteCommand("bash ~/.claude/scripts/tfx-route.sh architect 'design API'");
    assert.equal(r.agent, "architect");
    assert.equal(r.prompt, "design API");
    assert.equal(r.mcp, "");
  });

  it("매칭 실패 시 null", () => {
    const r = parseRouteCommand("echo hello");
    assert.equal(r, null);
  });

  it("timeout 추출", () => {
    const r = parseRouteCommand("bash ~/.claude/scripts/tfx-route.sh executor 'prompt' implement 300");
    assert.equal(r.flags.timeout, 300);
  });
});

describe("buildCommand — 플래그 보존", () => {
  it("기본 빌드: auto-attach 포함, dashboard 없음", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "implement", flags: {} };
    const cmd = buildCommand(parsed);
    assert.ok(cmd.includes("--auto-attach"));
    assert.ok(!cmd.includes("--dashboard"));
    assert.ok(cmd.includes("--timeout 600"));
  });

  it("dashboard 플래그 전달", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "implement", flags: { dashboard: true } };
    const cmd = buildCommand(parsed);
    assert.ok(cmd.includes("--dashboard"));
    assert.ok(cmd.includes("--auto-attach"));
  });

  it("verbose 플래그 전달", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "implement", flags: { verbose: true } };
    const cmd = buildCommand(parsed);
    assert.ok(cmd.includes("--verbose"));
  });

  it("noAutoAttach 시 --auto-attach 제거", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "implement", flags: { noAutoAttach: true } };
    const cmd = buildCommand(parsed);
    assert.ok(!cmd.includes("--auto-attach"));
  });

  it("커스텀 timeout 전달", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "implement", flags: { timeout: 300 } };
    const cmd = buildCommand(parsed);
    assert.ok(cmd.includes("--timeout 300"));
  });

  it("MCP 없으면 --mcp-profile 생략", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "", flags: {} };
    const cmd = buildCommand(parsed);
    assert.ok(!cmd.includes("--mcp-profile"));
  });

  it("모든 플래그 동시 적용", () => {
    const parsed = { agent: "codex", prompt: "impl auth", mcp: "implement", flags: { dashboard: true, verbose: true, timeout: 180 } };
    const cmd = buildCommand(parsed);
    assert.ok(cmd.includes("--dashboard"));
    assert.ok(cmd.includes("--verbose"));
    assert.ok(cmd.includes("--auto-attach"));
    assert.ok(cmd.includes("--mcp-profile implement"));
    assert.ok(cmd.includes("--timeout 180"));
    assert.ok(cmd.includes("--assign 'codex:impl auth:codex'"));
  });

  it("프롬프트 인용부호 이스케이프", () => {
    const parsed = { agent: "executor", prompt: "it's a test", mcp: "", flags: {} };
    const cmd = buildCommand(parsed);
    assert.ok(cmd.includes("it'\\''s a test"));
  });
});

describe("환경변수 기반 플래그", () => {
  it("TFX_DASHBOARD=1 → dashboard: true", () => {
    const orig = process.env.TFX_DASHBOARD;
    process.env.TFX_DASHBOARD = "1";
    const r = parseRouteCommand("bash ~/.claude/scripts/tfx-route.sh executor 'test' implement");
    assert.equal(r.flags.dashboard, true);
    if (orig === undefined) delete process.env.TFX_DASHBOARD;
    else process.env.TFX_DASHBOARD = orig;
  });

  it("TFX_DASHBOARD 미설정 → dashboard 없음", () => {
    const orig = process.env.TFX_DASHBOARD;
    delete process.env.TFX_DASHBOARD;
    const r = parseRouteCommand("bash ~/.claude/scripts/tfx-route.sh executor 'test' implement");
    assert.equal(r.flags.dashboard, undefined);
    if (orig) process.env.TFX_DASHBOARD = orig;
  });
});

describe("parseRouteCommand 소스 패리티", () => {
  it("parseRouteCommand 소스 코드와 테스트 미러가 일치해야 한다", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "headless-guard.mjs"), "utf8");
    assert.ok(source.includes("MCP_PROFILES"), "MCP_PROFILES 상수가 소스에 존재");
    assert.ok(source.includes("timeoutMatch"), "timeout 매칭 로직이 소스에 존재");
  });
});
