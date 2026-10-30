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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { routeTestEnv } from "../fixtures/route-test-env.mjs";

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

  it("kill_on_stall 기본값은 kill 이고, stall 기본값은 1200초다", () => {
    // T1: 외부 timeout이 hard ceiling으로 이동했으므로 heartbeat가 기본 방어선이다.
    const hb = extractFunction("heartbeat_monitor");
    assert.match(hb, /TFX_STALL_THRESHOLD:-1200/);
    assert.match(hb, /kill_on_stall="\$\{TFX_STALL_KILL:-kill\}"/);
    assert.match(hb, /kill_grace="\$\{TFX_STALL_KILL_GRACE:-30\}"/);
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

  function isolatedRouteEnv(dir, overrides = {}) {
    const env = routeTestEnv();
    for (const key of Object.keys(env)) {
      if (/^(TFX_JEV|JEV_|TYPESAFE_API_KEY$)/.test(key)) delete env[key];
    }
    const homes = {
      HOME: path.join(dir, "home"),
      CODEX_HOME: path.join(dir, "codex-home"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
    };
    for (const home of Object.values(homes))
      mkdirSync(home, { recursive: true });
    return {
      ...env,
      ...homes,
      CLI_TYPE: "test",
      TFX_CODEX_ROLLOUT_FILE: "",
      TFX_EXPECTED_DURATION_SEC: "",
      TFX_PROBE_DIR: path.join(dir, "probe"),
      TFX_PROBE_STATE_FILE: path.join(dir, "probe.json"),
      NODE_BIN: process.execPath,
      ...overrides,
    };
  }

  function writeJevBridge(dir) {
    const bridgeScript = path.join(dir, "bridge.mjs");
    const callsLog = path.join(dir, "bridge-calls.jsonl");
    writeFileSync(callsLog, "");
    writeFileSync(
      bridgeScript,
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'if (process.argv[2] === "judge-stall") {',
        '  console.log(JSON.stringify({ ok: true, enabled: true, status: "progressing", confidence: 0.99 }));',
        '} else if (process.argv[2] === "judge-route") {',
        '  console.log(["high", "astra", "", "", "", "120", "headless", "none", "", "0.99"].join("\\x1e"));',
        "} else { process.exit(1); }",
      ].join("\n"),
    );
    return { bridgeScript, callsLog };
  }

  function readBridgeCalls(callsLog) {
    return readFileSync(callsLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  // 정수 heartbeat tick은 유지하고 테스트의 실제 대기만 줄인다.
  // Bash 3.2의 비동기 함수에서 command가 호출자를 exec하지 않도록 sleep만 subshell로 감싼다.
  function buildStallScript({
    killMode,
    stdoutLog,
    stderrLog,
    bridgeScript,
    interval = 1,
    stallThreshold = 2,
    logicalClock = false,
  }) {
    const hb = extractFunction("heartbeat_monitor");
    const findForks = extractFunction("_find_fork_pids");
    const rolloutActivity = extractFunction("_codex_rollout_activity_bytes");
    // bash file 로 실행. spawnSync("bash", ["-c", script]) 는 Windows Git Bash 에서
    // 긴 script 의 line ending / argv 한도 문제로 EOF 오류를 내는 경우가 있어
    // 파일 경유가 안전하다.
    return [
      "#!/usr/bin/env bash",
      "set -u",
      ...(logicalClock
        ? [
            "LOGICAL_TICK=0",
            "sleep() { LOGICAL_TICK=$((LOGICAL_TICK + $1)); (command sleep 0.05); }",
            'date() { if [[ "$1" == "+%s" ]]; then printf "%s\\n" "$((1000000 + LOGICAL_TICK))"; else command date "$@"; fi; }',
          ]
        : ["sleep() { (command sleep 0.2); }"]),
      "export TFX_HEARTBEAT=1",
      "export TFX_HEARTBEAT_INTERVAL=1",
      "export TFX_STALL_THRESHOLD=2",
      `export TFX_STALL_KILL=${killMode}`,
      "export TFX_STALL_KILL_GRACE=1",
      `STDOUT_LOG='${stdoutLog}'`,
      `STDERR_LOG='${stderrLog}'`,
      ...(bridgeScript
        ? [
            `TFX_BRIDGE_SCRIPT='${bridgeScript}'`,
            'resolve_bridge_script() { printf "%s\\n" "$TFX_BRIDGE_SCRIPT"; }',
          ]
        : []),
      "TIMESTAMP=$(date +%s)",
      "",
      findForks,
      rolloutActivity,
      extractFunction("read_probe_state"),
      extractFunction("jev_enabled"),
      hb,
      "",
      "command sleep 30 &",
      "CHILD_PID=$!",
      'trap \'for test_pid in "${HB_PID:-}" "$CHILD_PID"; do [[ -n "$test_pid" ]] || continue; kill "$test_pid" 2>/dev/null || true; wait "$test_pid" 2>/dev/null || true; done\' EXIT',
      "trap 'exit 143' TERM",
      "trap 'exit 130' INT",
      'echo "CHILD_PID=$CHILD_PID" >&2',
      "",
      `heartbeat_monitor "$CHILD_PID" ${interval} ${stallThreshold} &`,
      "HB_PID=$!",
      "CHILD_KILLED=0",
      "",
      "for i in 1 2 3 4 5 6 7 8 9 10; do",
      "  command sleep 0.2",
      '  if ! kill -0 "$CHILD_PID" 2>/dev/null; then',
      '    echo "CHILD_KILLED_AFTER_TICK=$i" >&2',
      "    CHILD_KILLED=1",
      "    break",
      "  fi",
      "done",
      "",
      ...(killMode === "classify"
        ? [
            'if ! kill -0 "$CHILD_PID" 2>/dev/null; then',
            '  echo "RESULT=classify_killed_child" >&2',
            '  kill "$HB_PID" "$CHILD_PID" 2>/dev/null || true',
            '  wait "$HB_PID" "$CHILD_PID" 2>/dev/null || true',
            "  exit 1",
            "fi",
          ]
        : [
            'if [[ "$CHILD_KILLED" -ne 1 ]]; then',
            '  echo "RESULT=heartbeat_did_not_kill_child" >&2',
            '  kill "$HB_PID" "$CHILD_PID" 2>/dev/null || true',
            '  wait "$HB_PID" "$CHILD_PID" 2>/dev/null || true',
            "  exit 1",
            "fi",
          ]),
      "",
      'kill "$HB_PID" 2>/dev/null || true',
      'wait "$HB_PID" 2>/dev/null || true',
      'kill "$CHILD_PID" 2>/dev/null || true',
      'wait "$CHILD_PID" 2>/dev/null || true',
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

  function buildCodexRolloutActivityScript({
    codexHome,
    stdoutLog,
    stderrLog,
    evidenceLog,
    stopFile,
  }) {
    const hb = extractFunction("heartbeat_monitor");
    const findForks = extractFunction("_find_fork_pids");
    const rolloutActivity = extractFunction("_codex_rollout_activity_bytes");
    return [
      "#!/usr/bin/env bash",
      "set -u",
      "sleep() { (command sleep 0.2); }",
      "export TFX_HEARTBEAT=1",
      "export TFX_HEARTBEAT_INTERVAL=1",
      "export TFX_STALL_THRESHOLD=2",
      "export TFX_STALL_KILL=kill",
      "export TFX_STALL_KILL_GRACE=1",
      "export CLI_TYPE=codex",
      `export CODEX_HOME='${codexHome}'`,
      `STDOUT_LOG='${stdoutLog}'`,
      `STDERR_LOG='${stderrLog}'`,
      `EVIDENCE_LOG='${evidenceLog}'`,
      `STOP_FILE='${stopFile}'`,
      "TIMESTAMP=$(date +%s)",
      "",
      findForks,
      rolloutActivity,
      extractFunction("jev_enabled"),
      hb,
      "",
      'session_dir="$CODEX_HOME/sessions/$(date +%Y/%m/%d)"',
      'mkdir -p "$session_dir"',
      'rollout_log="$session_dir/rollout-heartbeat-test.jsonl"',
      ': > "$rollout_log"',
      "(",
      '  exec 3>>"$rollout_log"',
      "  for i in {1..50}; do",
      "    sleep 1",
      '    printf \'{"event":"tick","i":%s}\\n\' "$i" >&3',
      '    [[ -f "$STOP_FILE" ]] && break',
      "  done",
      ") &",
      "CHILD_PID=$!",
      "",
      'heartbeat_monitor "$CHILD_PID" 1 2 2>"$EVIDENCE_LOG" &',
      "HB_PID=$!",
      "",
      "ACTIVE_COUNT=0",
      "for i in {1..50}; do",
      '  ACTIVE_COUNT=$(grep -c "status=active" "$EVIDENCE_LOG" 2>/dev/null || true)',
      '  [[ "$ACTIVE_COUNT" -ge 4 ]] && break',
      "  sleep 1",
      "done",
      ': > "$STOP_FILE"',
      'wait "$CHILD_PID"',
      "child_status=$?",
      'kill "$HB_PID" 2>/dev/null || true',
      'wait "$HB_PID" 2>/dev/null || true',
      'cat "$EVIDENCE_LOG" >&2',
      "",
      'if [[ "$child_status" -ne 0 || "$ACTIVE_COUNT" -lt 4 ]]; then',
      '  echo "RESULT=child_killed status=$child_status active=$ACTIVE_COUNT" >&2',
      "  exit 1",
      "fi",
      'echo "RESULT=child_completed" >&2',
      "",
    ].join("\n");
  }

  function buildUnrelatedCodexRolloutScript({
    codexHome,
    stdoutLog,
    stderrLog,
  }) {
    const hb = extractFunction("heartbeat_monitor");
    const findForks = extractFunction("_find_fork_pids");
    const rolloutActivity = extractFunction("_codex_rollout_activity_bytes");
    return [
      "#!/usr/bin/env bash",
      "set -u",
      "sleep() { (command sleep 0.2); }",
      "export TFX_HEARTBEAT=1",
      "export TFX_HEARTBEAT_INTERVAL=1",
      "export TFX_STALL_THRESHOLD=2",
      "export TFX_STALL_KILL=kill",
      "export TFX_STALL_KILL_GRACE=1",
      "export CLI_TYPE=codex",
      `export CODEX_HOME='${codexHome}'`,
      `STDOUT_LOG='${stdoutLog}'`,
      `STDERR_LOG='${stderrLog}'`,
      "TIMESTAMP=$(date +%s)",
      "",
      findForks,
      rolloutActivity,
      extractFunction("jev_enabled"),
      hb,
      "",
      'session_dir="$CODEX_HOME/sessions/$(date +%Y/%m/%d)"',
      'mkdir -p "$session_dir"',
      'rollout_log="$session_dir/rollout-unrelated-test.jsonl"',
      ': > "$rollout_log"',
      "(",
      '  exec 3>>"$rollout_log"',
      "  for i in {1..50}; do",
      "    sleep 1",
      '    printf \'{"event":"unrelated","i":%s}\\n\' "$i" >&3',
      "  done",
      ") &",
      "WRITER_PID=$!",
      "",
      "command sleep 30 &",
      "CHILD_PID=$!",
      'heartbeat_monitor "$CHILD_PID" 1 2 &',
      "HB_PID=$!",
      "CHILD_KILLED=0",
      "WRITER_ALIVE_AT_KILL=0",
      "",
      "for i in 1 2 3 4 5 6 7 8 9 10; do",
      "  sleep 1",
      '  if ! kill -0 "$CHILD_PID" 2>/dev/null; then',
      '    echo "CHILD_KILLED_AFTER_TICK=$i" >&2',
      "    CHILD_KILLED=1",
      '    kill -0 "$WRITER_PID" 2>/dev/null && WRITER_ALIVE_AT_KILL=1',
      "    break",
      "  fi",
      "done",
      "",
      'if [[ "$CHILD_KILLED" -ne 1 || "$WRITER_ALIVE_AT_KILL" -ne 1 || ! -s "$rollout_log" ]]; then',
      '  echo "RESULT=unrelated_activity_not_observed" >&2',
      '  kill "$HB_PID" "$WRITER_PID" "$CHILD_PID" 2>/dev/null || true',
      '  wait "$HB_PID" "$WRITER_PID" "$CHILD_PID" 2>/dev/null || true',
      "  exit 1",
      "fi",
      "",
      'kill "$HB_PID" "$WRITER_PID" 2>/dev/null || true',
      'wait "$HB_PID" "$WRITER_PID" 2>/dev/null || true',
      'kill "$CHILD_PID" 2>/dev/null || true',
      'wait "$CHILD_PID" 2>/dev/null || true',
      "",
      'if kill -0 "$CHILD_PID" 2>/dev/null; then',
      '  echo "RESULT=child_still_alive" >&2',
      "  exit 1",
      "fi",
      'echo "RESULT=child_terminated" >&2',
      "",
    ].join("\n");
  }

  for (const { name, env, interval, threshold, calls, killElapsed, grace } of [
    {
      name: "progressing은 한 번만 유예하고 stall 지속 시 기존 kill로 복귀한다",
      env: { TFX_JEV: "1" },
      interval: 1,
      threshold: 2,
      calls: [2],
      killElapsed: 5,
      grace: true,
    },
    {
      name: "공식 TFX_JEV_CLI만으로 grace-stall bridge에 도달한다",
      env: { TFX_JEV_CLI: "/unused/jev" },
      interval: 1,
      threshold: 2,
      calls: [2],
      killElapsed: 5,
      grace: true,
    },
    {
      name: "공식 TFX_JEV_CLI만으로 early-stall과 grace-stall bridge에 도달한다",
      env: { TFX_JEV_CLI: "/unused/jev" },
      interval: 30,
      threshold: 90,
      calls: [60, 90, 150],
      killElapsed: 210,
      grace: true,
    },
    {
      name: "legacy JEV_CLI_BIN의 early-stall과 grace-stall 활성화를 보존한다",
      env: { JEV_CLI_BIN: "/unused/legacy-jev" },
      interval: 30,
      threshold: 90,
      calls: [60, 90, 150],
      killElapsed: 210,
      grace: true,
    },
    {
      name: "TFX_JEV=0이면 공식 및 legacy CLI가 있어도 두 stall guard가 비활성이다",
      env: {
        TFX_JEV: "0",
        TFX_JEV_CLI: "/unused/jev",
        JEV_CLI_BIN: "/unused/legacy-jev",
      },
      interval: 30,
      threshold: 90,
      calls: [],
      killElapsed: 120,
      grace: false,
    },
  ]) {
    it(name, (t) => {
      const dir = mkdtempSync(path.join(tmpdir(), "tfx-stall-jev-"));
      cleanupDirs.push(dir);
      const stdoutLog = path.join(dir, "stdout.log");
      const stderrLog = path.join(dir, "stderr.log");
      const scriptFile = path.join(dir, "run.sh");
      const { bridgeScript, callsLog } = writeJevBridge(dir);
      writeFileSync(stdoutLog, "");
      writeFileSync(stderrLog, "");
      writeFileSync(
        scriptFile,
        buildStallScript({
          killMode: "kill",
          stdoutLog,
          stderrLog,
          bridgeScript,
          interval,
          stallThreshold: threshold,
          logicalClock: true,
        }),
      );
      const result = spawnSync("bash", [scriptFile], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: isolatedRouteEnv(dir, env),
        timeout: 20_000,
      });
      const actualCalls = readBridgeCalls(callsLog);
      t.diagnostic(
        JSON.stringify({ calls: actualCalls, stderr: result.stderr }),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        actualCalls,
        calls.map((elapsed) => [
          "judge-stall",
          "--stdout-log",
          stdoutLog,
          "--stderr-log",
          stderrLog,
          "--rollout-file",
          "",
          "--elapsed-sec",
          String(elapsed),
        ]),
      );
      assert.equal(
        (
          result.stderr.match(
            /Jev progressing 판정으로 stall 유예 1회 부여/g,
          ) || []
        ).length,
        grace ? 1 : 0,
        result.stderr,
      );
      assert.match(
        result.stderr,
        new RegExp(
          `elapsed=${killElapsed}s .*status=STALL_KILL stall=${threshold + interval}s`,
        ),
      );
      if (grace) {
        assert.ok(
          result.stderr.indexOf("stall 유예 1회 부여") <
            result.stderr.indexOf("status=STALL_KILL"),
          result.stderr,
        );
      }
      assert.match(result.stderr, /RESULT=child_terminated/);
    });
  }

  for (const mode of ["auto", "disabled", "explicit"]) {
    const disabled = mode === "disabled";
    const explicit = mode === "explicit";
    it(`공식 CLI-only pre-route: ${mode}`, (t) => {
      const dir = mkdtempSync(path.join(tmpdir(), "tfx-pre-route-jev-"));
      cleanupDirs.push(dir);
      const { bridgeScript, callsLog } = writeJevBridge(dir);
      const scriptFile = path.join(dir, "run.sh");
      writeFileSync(
        scriptFile,
        [
          "set -eu",
          'resolve_bridge_script() { printf "%s\\n" "$TFX_BRIDGE_SCRIPT"; }',
          extractFunction("bridge_cli"),
          extractFunction("jev_enabled"),
          extractFunction("apply_jev_pre_route"),
          "AGENT_TYPE=executor",
          "PROMPT='test route boundary'",
          `TFX_CODEX_PROFILE=${explicit ? "sol_high" : "auto"}`,
          "TFX_GEMINI_PROFILE=",
          "TFX_EXECUTION_MODE=auto",
          "MCP_PROFILE=auto",
          "apply_jev_pre_route",
          'printf "PROFILE=%s MODE=%s MCP=%s\\n" "$TFX_CODEX_PROFILE" "$TFX_EXECUTION_MODE" "$MCP_PROFILE"',
        ].join("\n"),
      );
      const result = spawnSync("bash", [scriptFile], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: isolatedRouteEnv(dir, {
          TFX_JEV_CLI: "/unused/jev",
          ...(disabled ? { TFX_JEV: "0" } : {}),
          TFX_BRIDGE_SCRIPT: bridgeScript,
          TFX_CLI_MODE: "codex",
        }),
        timeout: 20_000,
      });
      const calls = readBridgeCalls(callsLog);
      t.diagnostic(
        JSON.stringify({ calls, stdout: result.stdout, stderr: result.stderr }),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        calls,
        disabled
          ? []
          : [
              [
                "judge-route",
                "--agent",
                "executor",
                "--cli-type",
                "codex",
                "--prompt",
                "test route boundary",
                "--delimited",
              ],
            ],
      );
      assert.equal(
        result.stdout.trim(),
        disabled
          ? "PROFILE=auto MODE=auto MCP=auto"
          : `PROFILE=${explicit ? "sol_high" : "astra"} MODE=headless MCP=none`,
      );
      if (!disabled) {
        assert.match(result.stderr, /recommended_codex=astra/);
        assert.match(
          result.stderr,
          new RegExp(`effective_codex=${explicit ? "sol_high" : "astra"}`),
        );
        assert.match(
          result.stderr,
          new RegExp(
            `codex_reason=${explicit ? "explicit_override_preserved" : "jev_applied"}`,
          ),
        );
      }
    });
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
      env: isolatedRouteEnv(dir),
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

  it("TFX_STALL_KILL=classify 이면 stall 은 STALL_CLASSIFY 로그만 내고 kill 안 한다 (#165)", () => {
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
      env: isolatedRouteEnv(dir),
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
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

  it("intervene 실패는 stdin JSON을 bridge에 전달한 뒤 기존 kill ladder로 fallback한다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-stall-intervene-"));
    cleanupDirs.push(dir);
    const stdoutLog = path.join(dir, "stdout.log");
    const stderrLog = path.join(dir, "stderr.log");
    const marker = path.join(dir, "intervene-payload.json");
    const bridgeScript = path.join(dir, "bridge-fail.mjs");
    const scriptFile = path.join(dir, "run.sh");
    writeFileSync(stdoutLog, "");
    writeFileSync(stderrLog, "");
    writeFileSync(
      bridgeScript,
      `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, readFileSync(0, "utf8"));\nprocess.exit(1);\n`,
    );
    writeFileSync(
      scriptFile,
      buildStallScript({
        killMode: "intervene",
        stdoutLog,
        stderrLog,
        bridgeScript,
      }),
    );
    const result = spawnSync("bash", [scriptFile], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: isolatedRouteEnv(dir),
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /status=STALL_INTERVENE/);
    assert.match(result.stderr, /intervention 실패/);
    assert.match(result.stderr, /status=STALL_KILL/);
    assert.match(result.stderr, /RESULT=child_terminated/);

    const payload = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(payload.channel, "process");
    assert.equal(typeof payload.pid, "number");
    assert.equal(payload.stdoutLog, stdoutLog);
    assert.equal(payload.stderrLog, stderrLog);
    assert.equal(payload.rolloutFile, null);
  });

  it("Codex rollout jsonl activity resets stall detection when stdout/stderr stay empty (#267)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-codex-rollout-"));
    cleanupDirs.push(dir);
    const codexHome = path.join(realpathSync.native(dir), "codex-home");
    const stdoutLog = path.join(dir, "stdout.log");
    const stderrLog = path.join(dir, "stderr.log");
    const evidenceLog = path.join(dir, "heartbeat.log");
    const stopFile = path.join(dir, "stop");
    const scriptFile = path.join(dir, "run.sh");
    writeFileSync(stdoutLog, "");
    writeFileSync(stderrLog, "");
    writeFileSync(evidenceLog, "");
    writeFileSync(
      scriptFile,
      buildCodexRolloutActivityScript({
        codexHome,
        stdoutLog,
        stderrLog,
        evidenceLog,
        stopFile,
      }),
    );
    const result = spawnSync("bash", [scriptFile], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: isolatedRouteEnv(dir),
      timeout: 20_000,
    });
    assert.equal(
      result.status,
      0,
      `Codex worker should not be killed while rollout jsonl grows.\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /RESULT=child_completed/);
    assert.doesNotMatch(
      result.stderr,
      /status=STALL_KILL/,
      "rollout jsonl activity must prevent STALL_KILL",
    );
  });

  it("unrelated Codex rollout activity does not hide a stalled worker (#267)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-codex-rollout-scope-"));
    cleanupDirs.push(dir);
    const codexHome = path.join(realpathSync.native(dir), "codex-home");
    const stdoutLog = path.join(dir, "stdout.log");
    const stderrLog = path.join(dir, "stderr.log");
    const scriptFile = path.join(dir, "run.sh");
    writeFileSync(stdoutLog, "");
    writeFileSync(stderrLog, "");
    writeFileSync(
      scriptFile,
      buildUnrelatedCodexRolloutScript({ codexHome, stdoutLog, stderrLog }),
    );
    const result = spawnSync("bash", [scriptFile], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: isolatedRouteEnv(dir),
      timeout: 20_000,
    });
    assert.equal(
      result.status,
      0,
      `unrelated rollout activity should not keep a stalled worker alive.\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /status=STALL_KILL/);
    assert.match(result.stderr, /RESULT=child_terminated/);
  });
});
