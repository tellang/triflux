// tests/unit/tfx-route-stall-kill.test.mjs
// #144/#66 regression: heartbeat_monitor 가 STALL 상태에서 worker 를 kill 하는지 확인.
//
// 본격적인 process-level E2E 는 flaky 가능성이 있어 shape + integration smoke 만 수행한다:
// 1. tfx-route.sh 내 heartbeat_monitor 블록에 STALL_KILL 분기 + SIGTERM/SIGKILL 호출이 존재
// 2. 짧은 interval 로 heartbeat_monitor 를 기동 → stall 유지된 child 가 실제로 kill 되는지
//
// 본 test 는 triflux 가 "codex MCP worker 가 output=0B 로 무한 stall" 사고를 더 이상
// 900s timeout 에 맡기지 않고 조기 종료하도록 보장한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "tfx-route.sh");

function extractFunction(name) {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `${name} 정의를 찾을 수 없음`);
  let depth = 0;
  let end = start;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

describe("#144/#66 heartbeat stall kill — shape", () => {
  it("heartbeat_monitor 는 STALL_KILL 분기와 TFX_STALL_KILL env, SIGTERM/SIGKILL 호출을 포함한다", () => {
    const hb = extractFunction("heartbeat_monitor");
    assert.match(hb, /TFX_STALL_KILL/, "TFX_STALL_KILL env opt-out 이 필요");
    assert.match(hb, /TFX_STALL_KILL_GRACE/, "grace 시간 env override 가 필요");
    assert.match(hb, /STALL_KILL/, "STALL_KILL 상태 로그가 필요");
    assert.match(hb, /kill -TERM "\$pid"/, "SIGTERM 호출 필수");
    assert.match(hb, /kill -KILL "\$pid"/, "SIGKILL 강제 경로 필수");
  });

  it("kill_on_stall 기본값은 classify 이고, grace 기본값은 30초 (#165)", () => {
    // PR #160: default 1 → 0 으로 임시 후퇴 (false kill 방지)
    // PR #165: 0 → classify 승격. evidence 는 남기되 kill 은 명시적 opt-in.
    const hb = extractFunction("heartbeat_monitor");
    assert.match(hb, /kill_on_stall="\$\{TFX_STALL_KILL:-classify\}"/);
    assert.match(hb, /kill_grace="\$\{TFX_STALL_KILL_GRACE:-30\}"/);
  });

  it("TFX_STALL_KILL 은 kill / classify / off 세 모드를 지원한다 (#165)", () => {
    const hb = extractFunction("heartbeat_monitor");
    // case 문에 세 모드 모두 존재해야 함
    assert.match(hb, /1\|on\|kill/, "kill alias (1|on|kill) case arm 필요");
    assert.match(
      hb,
      /classify\|0\|off\|disabled/,
      "no-kill alias (classify|0|off|disabled) case arm 필요",
    );
    assert.match(
      hb,
      /STALL_CLASSIFY/,
      "classify mode 의 evidence 로그 STALL_CLASSIFY 필요",
    );
    assert.match(
      hb,
      /no-kill — TFX_STALL_KILL=classify/,
      "STALL_CLASSIFY 로그에 사용자 개입 힌트 필요",
    );
  });

  it("Windows(MINGW/MSYS) 에서는 taskkill /T /F 로 프로세스 트리를 종료한다", () => {
    const hb = extractFunction("heartbeat_monitor");
    assert.match(hb, /MINGW\*\|MSYS\*/, "Windows 감지 case 필요");
    assert.match(hb, /taskkill \/T \/F/, "Windows 트리 종료 명령 필요");
    assert.match(hb, /MSYS_NO_PATHCONV=1/, "MSYS 경로 변환 비활성화 필요");
  });

  it("STALL_KILL 은 SIGTERM 전에 자식 PID 를 스냅샷하고 orphan sweep 을 수행한다", () => {
    // 2026-04-22 사용자 보고: SIGTERM 으로 wrapper 가 조기 종료되면 taskkill /T 가
    // 부모를 못 찾아 codex 자식이 orphan 으로 남음. SIGTERM 이전에 자식 PID 를
    // 스냅샷해두고, wrapper 정리 후에도 살아있는 자식을 tree kill 해야 한다.
    const hb = extractFunction("heartbeat_monitor");
    assert.match(
      hb,
      /_stall_children=\$\(_find_fork_pids "\$pid"/,
      "SIGTERM 이전에 _find_fork_pids 로 자식 PID 스냅샷이 필요",
    );
    assert.match(
      hb,
      /orphan children detected/,
      "orphan sweep 로그 라인 필요 (stderr 진단용)",
    );
    assert.match(
      hb,
      /for _cpid in \$_orphan_alive/,
      "살아있는 orphan 만 tree kill 하는 loop 필요",
    );
  });
});

describe("#144/#66 heartbeat stall kill — integration", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function buildStallScript({ killMode, stdoutLog, stderrLog }) {
    const hb = extractFunction("heartbeat_monitor");
    const findForks = extractFunction("_find_fork_pids");
    // bash file 로 실행. spawnSync("bash", ["-c", script]) 는 Windows Git Bash 에서
    // 긴 script 의 line ending / argv 한도 문제로 EOF 오류를 내는 경우가 있어
    // 파일 경유가 안전하다.
    return [
      "#!/usr/bin/env bash",
      "set -u",
      "export TFX_HEARTBEAT=1",
      "export TFX_HEARTBEAT_INTERVAL=1",
      "export TFX_STALL_THRESHOLD=2",
      `export TFX_STALL_KILL=${killMode}`,
      "export TFX_STALL_KILL_GRACE=1",
      `STDOUT_LOG='${stdoutLog}'`,
      `STDERR_LOG='${stderrLog}'`,
      "TIMESTAMP=$(date +%s)",
      "",
      findForks,
      hb,
      "",
      "sleep 30 &",
      "CHILD_PID=$!",
      'echo "CHILD_PID=$CHILD_PID" >&2',
      "",
      'heartbeat_monitor "$CHILD_PID" 1 2 &',
      "HB_PID=$!",
      "",
      "for i in 1 2 3 4 5 6 7 8 9 10; do",
      "  sleep 1",
      '  if ! kill -0 "$CHILD_PID" 2>/dev/null; then',
      '    echo "CHILD_KILLED_AFTER=${i}s" >&2',
      "    break",
      "  fi",
      "done",
      "",
      'kill "$HB_PID" 2>/dev/null || true',
      'wait "$HB_PID" 2>/dev/null || true',
      'kill "$CHILD_PID" 2>/dev/null || true',
      "",
      'if kill -0 "$CHILD_PID" 2>/dev/null; then',
      '  echo "RESULT=child_still_alive" >&2',
      "  exit 1",
      "else",
      '  echo "RESULT=child_terminated" >&2',
      "fi",
      "",
    ].join("\n");
  }

  it("TFX_STALL_KILL=kill 이면 stall 지속 시 worker 에게 SIGTERM 을 보내고 loop 을 break 한다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-stall-kill-"));
    cleanupDirs.push(dir);
    const stdoutLog = path.join(dir, "stdout.log");
    const stderrLog = path.join(dir, "stderr.log");
    const scriptFile = path.join(dir, "run.sh");
    writeFileSync(stdoutLog, "");
    writeFileSync(stderrLog, "");
    writeFileSync(
      scriptFile,
      buildStallScript({ killMode: "kill", stdoutLog, stderrLog }),
    );
    const result = spawnSync("bash", [scriptFile], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      timeout: 20_000,
    });
    assert.equal(
      result.status,
      0,
      `child was not terminated by STALL_KILL.\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /status=STALL_KILL/, "STALL_KILL 상태 로그");
    assert.match(result.stderr, /SIGTERM/, "SIGTERM 발사 로그");
    assert.match(result.stderr, /RESULT=child_terminated/);
  });

  it("TFX_STALL_KILL=classify (default) 이면 stall 은 STALL_CLASSIFY 로그만 내고 kill 안 한다 (#165)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-stall-classify-"));
    cleanupDirs.push(dir);
    const stdoutLog = path.join(dir, "stdout.log");
    const stderrLog = path.join(dir, "stderr.log");
    const scriptFile = path.join(dir, "run.sh");
    writeFileSync(stdoutLog, "");
    writeFileSync(stderrLog, "");
    writeFileSync(
      scriptFile,
      buildStallScript({ killMode: "classify", stdoutLog, stderrLog }),
    );
    const result = spawnSync("bash", [scriptFile], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      timeout: 20_000,
    });
    // classify 는 kill 안 함 → child 는 우리가 수동 kill 하므로 terminated.
    // 중요한 건 STALL_KILL 은 안 뜨고 STALL_CLASSIFY 가 떴어야 한다.
    assert.match(
      result.stderr,
      /STALL_CLASSIFY/,
      "classify evidence 로그 필요",
    );
    assert.doesNotMatch(
      result.stderr,
      /status=STALL_KILL/,
      "classify mode 에서는 STALL_KILL 로그가 없어야 함",
    );
    assert.doesNotMatch(
      result.stderr,
      /SIGTERM/,
      "classify mode 에서는 SIGTERM 이 발사되면 안 됨",
    );
  });
});
