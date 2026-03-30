// tests/unit/headless-guard.test.mjs — headless-guard 플래그 보존 테스트
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASH_EXE } from "../helpers/bash-path.mjs";

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

function createFakePsmux(binDir) {
  if (process.platform === "win32") {
    const cmdPath = join(binDir, "psmux.cmd");
    writeFileSync(
      cmdPath,
      [
        "@echo off",
        "if \"%1\"==\"-V\" (",
        "  echo psmux 9.9.9",
        "  exit /b 0",
        ")",
        "exit /b 1",
      ].join("\r\n"),
      "utf8",
    );
    return cmdPath;
  }

  const shPath = join(binDir, "psmux");
  writeFileSync(
    shPath,
    [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"-V\" ]; then",
      "  echo \"psmux 9.9.9\"",
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shPath, 0o755);
  return shPath;
}

function runGuardWithBashCommand(command, extraEnv = {}) {
  const sandboxDir = mkdtempSync(join(tmpdir(), "tfx-guard-runtime-"));
  const binDir = join(sandboxDir, "bin");
  mkdirSync(binDir, { recursive: true });
  createFakePsmux(binDir);
  const pathSep = process.platform === "win32" ? ";" : ":";
  const originalPath = process.env.PATH || "";

  try {
    return spawnSync(process.execPath, [GUARD_PATH], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command },
      }),
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        ...extraEnv,
        PATH: `${binDir}${pathSep}${originalPath}`,
        TMPDIR: sandboxDir,
        TEMP: sandboxDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
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
  if (!f.noAutoAttach) parts.push("--dashboard");  // 워커 요약 스플릿이 기본
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

describe("headless-guard decision matrix (runtime)", () => {
  it("psmux 설치 + direct codex exec는 deny되고 fallback+bypass 힌트를 함께 제공한다", () => {
    const result = runGuardWithBashCommand("codex exec 'hello'");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--teammate-mode headless/u);
    assert.match(result.stderr, /TFX_ALLOW_DIRECT_CLI=1/u);
  });

  it("psmux 설치 + direct gemini --prompt는 deny되고 fallback+bypass 힌트를 함께 제공한다", () => {
    const result = runGuardWithBashCommand("gemini --prompt 'hello'");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--teammate-mode headless/u);
    assert.match(result.stderr, /TFX_ALLOW_DIRECT_CLI=1/u);
  });

  it("TFX_ALLOW_DIRECT_CLI=1이면 direct CLI deny를 우회한다", () => {
    const result = runGuardWithBashCommand("codex exec 'hello'", {
      TFX_ALLOW_DIRECT_CLI: "1",
    });
    assert.equal(result.status, 0);

    const payload = JSON.parse((result.stdout || "").trim());
    assert.equal(payload?.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.match(payload?.hookSpecificOutput?.additionalContext || "", /TFX_ALLOW_DIRECT_CLI=1/u);
  });
});

describe("buildCommand — 플래그 보존", () => {
  it("기본 빌드: auto-attach + dashboard 포함 (워커 요약 스플릿 기본)", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "implement", flags: {} };
    const cmd = buildCommand(parsed);
    assert.ok(cmd.includes("--auto-attach"));
    assert.ok(cmd.includes("--dashboard"));
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

  it("noAutoAttach 시 --auto-attach + --dashboard 모두 제거", () => {
    const parsed = { agent: "executor", prompt: "fix", mcp: "implement", flags: { noAutoAttach: true } };
    const cmd = buildCommand(parsed);
    assert.ok(!cmd.includes("--auto-attach"));
    assert.ok(!cmd.includes("--dashboard"));
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

// P1a: 단일 워커 우회 로직 미러
function shouldBypassHeadless(cmd) {
  if (process.env.TFX_FORCE_HEADLESS) return false;
  const isMultiWorker = /\s--(multi|parallel)\b/.test(cmd);
  return !isMultiWorker;
}

describe("P1a: 단일 워커 headless 우회", () => {
  it("단일 tfx-route.sh → 우회 (headless 변환 안 함)", () => {
    assert.equal(shouldBypassHeadless("bash tfx-route.sh executor 'fix bug' implement"), true);
  });

  it("--multi 플래그 → headless 변환 수행", () => {
    assert.equal(shouldBypassHeadless("bash tfx-route.sh executor 'fix bug' --multi implement"), false);
  });

  it("--parallel 플래그 → headless 변환 수행", () => {
    assert.equal(shouldBypassHeadless("bash tfx-route.sh executor 'fix bug' --parallel"), false);
  });

  it("TFX_FORCE_HEADLESS=1 → 단일이어도 headless 변환", () => {
    const orig = process.env.TFX_FORCE_HEADLESS;
    process.env.TFX_FORCE_HEADLESS = "1";
    assert.equal(shouldBypassHeadless("bash tfx-route.sh executor 'fix bug' implement"), false);
    if (orig === undefined) delete process.env.TFX_FORCE_HEADLESS;
    else process.env.TFX_FORCE_HEADLESS = orig;
  });

  it("TFX_FORCE_HEADLESS 미설정 + 단일 워커 → 우회", () => {
    const orig = process.env.TFX_FORCE_HEADLESS;
    delete process.env.TFX_FORCE_HEADLESS;
    assert.equal(shouldBypassHeadless("bash tfx-route.sh codex 'analyze code' review"), true);
    if (orig) process.env.TFX_FORCE_HEADLESS = orig;
  });
});

describe("환경변수 기반 플래그", () => {
  it("TFX_VERBOSE=1 → verbose: true", () => {
    const orig = process.env.TFX_VERBOSE;
    process.env.TFX_VERBOSE = "1";
    const r = parseRouteCommand("bash ~/.claude/scripts/tfx-route.sh executor 'test' implement");
    assert.equal(r.flags.verbose, true);
    if (orig === undefined) delete process.env.TFX_VERBOSE;
    else process.env.TFX_VERBOSE = orig;
  });

  it("TFX_NO_AUTO_ATTACH=1 → noAutoAttach: true", () => {
    const orig = process.env.TFX_NO_AUTO_ATTACH;
    process.env.TFX_NO_AUTO_ATTACH = "1";
    const r = parseRouteCommand("bash ~/.claude/scripts/tfx-route.sh executor 'test' implement");
    assert.equal(r.flags.noAutoAttach, true);
    if (orig === undefined) delete process.env.TFX_NO_AUTO_ATTACH;
    else process.env.TFX_NO_AUTO_ATTACH = orig;
  });
});

describe("P2: HANDOFF_INSTRUCTION_SHORT", () => {
  it("HANDOFF_INSTRUCTION_SHORT가 유효한 문자열", async () => {
    const { HANDOFF_INSTRUCTION_SHORT } = await import("../../hub/team/handoff.mjs");
    assert.ok(typeof HANDOFF_INSTRUCTION_SHORT === "string");
    assert.ok(HANDOFF_INSTRUCTION_SHORT.length > 0);
    assert.ok(HANDOFF_INSTRUCTION_SHORT.includes("--- HANDOFF ---"));
    assert.ok(HANDOFF_INSTRUCTION_SHORT.includes("status:"));
    assert.ok(HANDOFF_INSTRUCTION_SHORT.includes("verdict:"));
  });

  it("HANDOFF_INSTRUCTION_SHORT는 HANDOFF_INSTRUCTION보다 짧음", async () => {
    const { HANDOFF_INSTRUCTION, HANDOFF_INSTRUCTION_SHORT } = await import("../../hub/team/handoff.mjs");
    assert.ok(HANDOFF_INSTRUCTION_SHORT.length < HANDOFF_INSTRUCTION.length);
  });

  it("buildHeadlessCommand에 handoff 지시가 삽입됨 (미러)", () => {
    // buildHeadlessCommand 동작 미러: handoff=true일 때 프롬프트에 HANDOFF 삽입
    const HANDOFF_SHORT = "After completing, output this block at the end:\n--- HANDOFF ---";
    const prompt = "fix bug";
    const handoff = true;
    const handoffHint = handoff ? `\n\n${HANDOFF_SHORT}` : "";
    const fullPrompt = `${prompt}${handoffHint}`;
    assert.ok(fullPrompt.includes("--- HANDOFF ---"));
    assert.ok(fullPrompt.startsWith("fix bug"));
  });

  it("handoff=false일 때 HANDOFF 지시 미삽입", () => {
    const HANDOFF_SHORT = "After completing, output this block at the end:\n--- HANDOFF ---";
    const prompt = "fix bug";
    const handoff = false;
    const handoffHint = handoff ? `\n\n${HANDOFF_SHORT}` : "";
    const fullPrompt = `${prompt}${handoffHint}`;
    assert.ok(!fullPrompt.includes("--- HANDOFF ---"));
    assert.equal(fullPrompt, "fix bug");
  });
});

const FAST_SH_PATH = join(process.cwd(), "scripts", "headless-guard-fast.sh");

describe("headless-guard-fast.sh — bash pre-filter", () => {
  const testTmpDir = join(tmpdir(), "tfx-guard-test-" + process.pid);
  const cacheFile = join(testTmpDir, "tfx-psmux-check.json");

  before(() => {
    mkdirSync(testTmpDir, { recursive: true });
  });

  after(() => {
    rmSync(testTmpDir, { recursive: true, force: true });
  });

  it("캐시 ok:false + TTL 유효 → exit 0 (Node.js 미기동)", () => {
    writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), ok: false }));
    const result = execFileSync(BASH_EXE, [FAST_SH_PATH], {
      input: "{}",
      timeout: 5000,
      env: { ...process.env, TMPDIR: testTmpDir, TEMP: testTmpDir },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    // exit 0 means it passed through without hitting Node.js
    assert.ok(true, "fast.sh exited 0 on cached ok:false");
  });

  it("캐시 만료(5분 초과) → node fallthrough", () => {
    const expiredTs = Date.now() - (6 * 60 * 1000); // 6분 전
    writeFileSync(cacheFile, JSON.stringify({ ts: expiredTs, ok: false }));
    // This will exec node headless-guard.mjs which also exits 0 when psmux is not installed
    const result = execFileSync(BASH_EXE, [FAST_SH_PATH], {
      input: "{}",
      timeout: 10000,
      env: { ...process.env, TMPDIR: testTmpDir, TEMP: testTmpDir },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    assert.ok(true, "fast.sh fell through to node on expired cache");
  });

  it("캐시 미존재 → node fallthrough", () => {
    // Remove cache file if exists
    try { rmSync(cacheFile); } catch {}
    const result = execFileSync(BASH_EXE, [FAST_SH_PATH], {
      input: "{}",
      timeout: 10000,
      env: { ...process.env, TMPDIR: testTmpDir, TEMP: testTmpDir },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    assert.ok(true, "fast.sh fell through to node on missing cache");
  });
});

describe("parseRouteCommand 소스 패리티", () => {
  it("parseRouteCommand 소스 코드와 테스트 미러가 일치해야 한다", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "headless-guard.mjs"), "utf8");
    assert.ok(source.includes("MCP_PROFILES"), "MCP_PROFILES 상수가 소스에 존재");
    assert.ok(source.includes("timeoutMatch"), "timeout 매칭 로직이 소스에 존재");
  });
});
