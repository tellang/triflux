// tfx-route 결과검증 (#result-verification)
// 근본 결함: Codex MCP transport 채널이 실행 중 죽으면 codex exec가 exit 0 + 빈
// stdout 으로 끝나고, recover_codex_stdout 이 stderr 크래시 노이즈를 STDOUT_LOG 에
// backfill 해 no-op 가드의 `! -s STDOUT_LOG` 를 무력화 → 빈손 실행이 success 로 오보고.
// 원칙: "복구된 stderr 는 진짜 산출물이 아니다" — 복구 진입을 플래그로 노출하고,
// transport 크래시 서명을 검출해 가드가 실패로 승격한다. 진짜 출력 있는 성공은 무영향.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const LIB = "scripts/lib/codex-recovery.sh";
const ROUTE = "scripts/tfx-route.sh";
const POST = "scripts/tfx-route-post.mjs";

// recover_codex_stdout 실행 후 CODEX_STDOUT_WAS_RECOVERED 플래그를 회수한다.
function runRecoveryFlag(stdoutContent, stderrContent) {
  const tmp = mkdtempSync(join(tmpdir(), "tfx-rv-flag-"));
  const stdoutLog = join(tmp, "stdout.log");
  const stderrLog = join(tmp, "stderr.log");
  writeFileSync(stdoutLog, stdoutContent);
  writeFileSync(stderrLog, stderrContent);
  const res = spawnSync(
    "bash",
    [
      "-c",
      `source "${LIB}"; STDOUT_LOG="${stdoutLog}"; STDERR_LOG="${stderrLog}"; recover_codex_stdout; echo "FLAG=\${CODEX_STDOUT_WAS_RECOVERED}"`,
    ],
    { encoding: "utf-8" },
  );
  const m = (res.stdout || "").match(/FLAG=(\S*)/);
  rmSync(tmp, { recursive: true, force: true });
  return { flag: m ? m[1] : null, stderr: res.stderr || "" };
}

// codex_stdout_transport_crashed 판정을 회수한다 (CRASHED / CLEAN).
function runTransportCheck(stderrContent) {
  const tmp = mkdtempSync(join(tmpdir(), "tfx-rv-tc-"));
  const stderrLog = join(tmp, "stderr.log");
  writeFileSync(stderrLog, stderrContent);
  const res = spawnSync(
    "bash",
    [
      "-c",
      `source "${LIB}"; if codex_stdout_transport_crashed "${stderrLog}"; then echo CRASHED; else echo CLEAN; fi`,
    ],
    { encoding: "utf-8" },
  );
  rmSync(tmp, { recursive: true, force: true });
  return (res.stdout || "").trim();
}

const MCP_CRASH_STDERR = [
  "OpenAI Codex",
  "mcp: connecting http://127.0.0.1:8101/mcp",
  "rmcp::transport worker quit with fatal: Transport channel closed",
  "workdir: /Users/x/proj",
  "tokens used",
  "1,234",
].join("\n");

describe("recover_codex_stdout — CODEX_STDOUT_WAS_RECOVERED 플래그", () => {
  it("진짜 stdout 이 있으면 복구 미진입 → FLAG=0", () => {
    const { flag } = runRecoveryFlag(
      "진짜 워커 최종 응답입니다\n",
      "some stderr noise\n",
    );
    assert.equal(flag, "0", "genuine output 은 복구되지 않아야 한다");
  });

  it("빈 stdout + 비어있지 않은 stderr → 복구 진입 → FLAG=1", () => {
    const { flag } = runRecoveryFlag("", MCP_CRASH_STDERR);
    assert.equal(flag, "1", "빈 stdout 은 복구 진입으로 플래그가 서야 한다");
  });

  it("빈 stdout + 빈 stderr → 복구할 것 없음 → FLAG=0", () => {
    const { flag } = runRecoveryFlag("", "");
    assert.equal(flag, "0");
  });
});

describe("codex_stdout_transport_crashed — MCP transport 사망 서명", () => {
  it("Transport channel closed 서명 → CRASHED", () => {
    assert.equal(runTransportCheck(MCP_CRASH_STDERR), "CRASHED");
  });

  it("rmcp::transport worker quit with fatal 서명 → CRASHED", () => {
    assert.equal(
      runTransportCheck("rmcp::transport worker quit with fatal: boom\n"),
      "CRASHED",
    );
  });

  it("정상 stderr → CLEAN (false-positive 없음)", () => {
    assert.equal(
      runTransportCheck("tokens used\n99,999\nAll good.\n"),
      "CLEAN",
    );
  });
});

describe("tfx-route.sh no-op 가드 배선", () => {
  const src = readFileSync(ROUTE, "utf8");
  it("가드가 복구 플래그(CODEX_STDOUT_WAS_RECOVERED)를 진짜-출력-부재 판정에 쓴다", () => {
    assert.match(src, /CODEX_STDOUT_WAS_RECOVERED/);
  });
  it("가드가 transport 크래시 검출을 승격 조건에 쓴다", () => {
    assert.match(src, /codex_stdout_transport_crashed/);
  });
  it("아우터 run 함수가 플래그를 매 실행 초기화한다(스테일 방지)", () => {
    assert.match(src, /CODEX_STDOUT_WAS_RECOVERED=0/);
  });
});

describe("tfx-route-post.mjs — mcp_transport 이슈 추적(관측성)", () => {
  it("stderr 에 transport 크래시 서명이 있으면 cli-issues.jsonl 에 mcp_transport 기록", () => {
    const home = mkdtempSync(join(tmpdir(), "tfx-rv-home-"));
    const logdir = mkdtempSync(join(tmpdir(), "tfx-rv-logs-"));
    const stderrLog = join(logdir, "stderr.log");
    const stdoutLog = join(logdir, "stdout.log");
    writeFileSync(stderrLog, MCP_CRASH_STDERR);
    writeFileSync(stdoutLog, "");
    const res = spawnSync(
      process.execPath,
      [
        POST,
        "--agent",
        "tester",
        "--cli",
        "codex",
        "--exit-code",
        "68",
        "--stderr-log",
        stderrLog,
        "--stdout-log",
        stdoutLog,
      ],
      { encoding: "utf-8", env: { ...process.env, HOME: home } },
    );
    assert.equal(res.status, 0, `post 실행 실패: ${res.stderr}`);
    const issues = join(home, ".claude", "cache", "cli-issues.jsonl");
    const content = readFileSync(issues, "utf-8");
    const patterns = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).pattern);
    rmSync(home, { recursive: true, force: true });
    rmSync(logdir, { recursive: true, force: true });
    assert.ok(
      patterns.includes("mcp_transport"),
      `mcp_transport 이슈가 기록돼야 한다; got=${patterns.join(",")}`,
    );
  });

  it("exit 0(정상 성공)에서 transport teardown 로그는 mcp_transport 로 기록하지 않는다(P3-3)", () => {
    const home = mkdtempSync(join(tmpdir(), "tfx-rv-home0-"));
    const logdir = mkdtempSync(join(tmpdir(), "tfx-rv-logs0-"));
    const stderrLog = join(logdir, "stderr.log");
    const stdoutLog = join(logdir, "stdout.log");
    // 채널 teardown 로그가 stderr 에 있으나 exit 0 + 진짜 stdout 존재(정상 성공).
    writeFileSync(
      stderrLog,
      "rmcp::transport worker quit with fatal: Transport channel closed\n",
    );
    writeFileSync(stdoutLog, "진짜 최종 응답\n");
    const res = spawnSync(
      process.execPath,
      [
        POST,
        "--agent",
        "tester",
        "--cli",
        "codex",
        "--exit-code",
        "0",
        "--stderr-log",
        stderrLog,
        "--stdout-log",
        stdoutLog,
      ],
      { encoding: "utf-8", env: { ...process.env, HOME: home } },
    );
    assert.equal(res.status, 0, `post 실행 실패: ${res.stderr}`);
    const issues = join(home, ".claude", "cache", "cli-issues.jsonl");
    let patterns = [];
    try {
      patterns = readFileSync(issues, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).pattern);
    } catch {
      // 파일 미생성 = 이슈 기록 없음 = 기대 동작
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(logdir, { recursive: true, force: true });
    assert.ok(
      !patterns.includes("mcp_transport"),
      `정상 성공의 teardown 로그를 이슈로 기록하면 안 된다; got=${patterns.join(",")}`,
    );
  });
});
