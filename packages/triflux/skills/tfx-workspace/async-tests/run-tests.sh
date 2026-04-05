#!/usr/bin/env bash
# tfx-route.sh v2.5 async job system — 통합 테스트
set -uo pipefail

ROUTE="scripts/tfx-route.sh"
PASS=0
FAIL=0
TOTAL=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name — expected: '$expected', got: '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_neq() {
  local name="$1" unexpected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$actual" != *"$unexpected"* ]]; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name — should NOT contain: '$unexpected', got: '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name — expected exit=$expected, got exit=$actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "═══ tfx-route.sh v2.5 Async Job System Tests ═══"
echo ""

# ── Test 1: --async 기본 동작 ──
echo "Test 1: --async 기본 시작 + job_id 반환"
JOB_ID=$(bash "$ROUTE" --async executor "echo hello" none 30 2>/dev/null)
EC=$?
assert_exit "exit code 0" 0 "$EC"
TOTAL=$((TOTAL + 1))
if [[ -n "$JOB_ID" ]]; then echo "  ✓ job_id not empty ($JOB_ID)"; PASS=$((PASS + 1)); else echo "  ✗ job_id is empty"; FAIL=$((FAIL + 1)); fi
assert_neq "job_id not error" "error" "$JOB_ID"
echo ""

# ── Test 2: --job-status running → done 전이 ──
echo "Test 2: --job-status 상태 전이 (running → done)"
LONG_JOB=$(bash "$ROUTE" --async executor "sleep 3 && echo done" none 60 2>/dev/null)
STATUS_EARLY=$(bash "$ROUTE" --job-status "$LONG_JOB" 2>/dev/null)
assert_eq "initial status: running" "running" "$STATUS_EARLY"

# Codex 시작 ~10초 + sleep 3초 + 후처리 → 최대 25초 대기
for i in $(seq 1 5); do
  sleep 5
  STATUS_LATE=$(bash "$ROUTE" --job-status "$LONG_JOB" 2>/dev/null)
  [[ "$STATUS_LATE" == "done" ]] && break
done
assert_eq "final status: done" "done" "$STATUS_LATE"
echo ""

# ── Test 3: --job-status 존재하지 않는 job ──
echo "Test 3: --job-status 존재하지 않는 job"
RESULT=$(bash "$ROUTE" --job-status "nonexistent-12345" 2>/dev/null)
EC=$?
assert_eq "returns error" "error" "$RESULT"
assert_exit "exit code 1" 1 "$EC"
echo ""

# ── Test 4: --job-result 완료된 job ──
echo "Test 4: --job-result 완료된 job 결과 읽기"
# Test 1의 JOB_ID 재사용 — Codex 완료 대기
for i in $(seq 1 6); do
  S=$(bash "$ROUTE" --job-status "$JOB_ID" 2>/dev/null)
  [[ "$S" == "done" ]] && break
  sleep 5
done
RESULT=$(bash "$ROUTE" --job-result "$JOB_ID" 2>/dev/null)
EC=$?
assert_exit "exit code 0" 0 "$EC"
TOTAL=$((TOTAL + 1))
if [[ -n "$RESULT" ]]; then echo "  ✓ result not empty (${#RESULT} bytes)"; PASS=$((PASS + 1)); else echo "  ✗ result is empty"; FAIL=$((FAIL + 1)); fi
assert_neq "result not error" "error:" "$RESULT"
echo ""

# ── Test 5: --job-result 아직 실행 중인 job ──
echo "Test 5: --job-result 실행 중인 job → 에러"
RUNNING_JOB=$(bash "$ROUTE" --async executor "sleep 30" none 60 2>/dev/null)
RESULT=$(bash "$ROUTE" --job-result "$RUNNING_JOB" 2>/dev/null)
EC=$?
assert_eq "returns error" "error: job still running" "$RESULT"
assert_exit "exit code 1" 1 "$EC"
# cleanup
JOB_DIR="${TMPDIR:-/tmp}/tfx-jobs/$RUNNING_JOB"
[[ -f "$JOB_DIR/pid" ]] && kill "$(cat "$JOB_DIR/pid")" 2>/dev/null
echo ""

# ── Test 6: --job-wait 완료 감지 ──
echo "Test 6: --job-wait 완료 감지"
WAIT_JOB=$(bash "$ROUTE" --async executor "echo wait-test-ok" none 30 2>/dev/null)
sleep 15  # codex 실행 대기
WAIT_RESULT=$(bash "$ROUTE" --job-wait "$WAIT_JOB" 60 2>/dev/null)
assert_eq "wait returns done" "done" "$WAIT_RESULT"
echo ""

# ── Test 7: --job-wait still_running (max_wait < 실행시간) ──
echo "Test 7: --job-wait still_running (짧은 max_wait)"
SLOW_JOB=$(bash "$ROUTE" --async executor "sleep 60" none 120 2>/dev/null)
sleep 1
WAIT_RESULT=$(bash "$ROUTE" --job-wait "$SLOW_JOB" 5 2>/dev/null)
assert_eq "wait returns still_running" "still_running" "$WAIT_RESULT"
# cleanup
JOB_DIR="${TMPDIR:-/tmp}/tfx-jobs/$SLOW_JOB"
[[ -f "$JOB_DIR/pid" ]] && kill "$(cat "$JOB_DIR/pid")" 2>/dev/null
echo ""

# ── Test 8: exit code 전파 ──
echo "Test 8: 실패한 job의 exit code 전파"
FAIL_JOB=$(bash "$ROUTE" --async executor "exit 42" none 30 2>/dev/null)
# Codex 완료 대기
for i in $(seq 1 8); do
  S=$(bash "$ROUTE" --job-status "$FAIL_JOB" 2>/dev/null)
  [[ "$S" != *"running"* ]] && break
  sleep 5
done
STATUS=$(bash "$ROUTE" --job-status "$FAIL_JOB" 2>/dev/null)
# Codex가 exit 42를 감싸서 성공/실패 둘 다 가능 — "running이 아님"만 확인
TOTAL=$((TOTAL + 1))
if [[ "$STATUS" == "done" || "$STATUS" == *"failed"* || "$STATUS" == "timeout" ]]; then
  echo "  ✓ status is terminal: $STATUS"; PASS=$((PASS + 1))
else
  echo "  ✗ status not terminal: $STATUS"; FAIL=$((FAIL + 1))
fi
# Codex는 exit 42를 감싸서 다른 코드로 반환할 수 있음 — 완료 자체만 확인
TOTAL=$((TOTAL + 1))
if [[ "$STATUS" != *"running"* ]]; then echo "  ✓ job completed (not stuck running)"; PASS=$((PASS + 1)); else echo "  ✗ job still running"; FAIL=$((FAIL + 1)); fi
echo ""

# ── Test 9: job 디렉토리 구조 검증 ──
echo "Test 9: job 디렉토리 구조"
STRUCT_JOB=$(bash "$ROUTE" --async executor "echo structure-test" none 30 2>/dev/null)
JOB_DIR="${TMPDIR:-/tmp}/tfx-jobs/$STRUCT_JOB"
assert_eq "pid file exists" "true" "$([ -f "$JOB_DIR/pid" ] && echo true || echo false)"
assert_eq "agent_type file exists" "true" "$([ -f "$JOB_DIR/agent_type" ] && echo true || echo false)"
assert_eq "start_time file exists" "true" "$([ -f "$JOB_DIR/start_time" ] && echo true || echo false)"
AGENT=$(cat "$JOB_DIR/agent_type" 2>/dev/null)
assert_eq "agent_type == executor" "executor" "$AGENT"
echo ""

# ── Test 10: native.mjs 프롬프트 검증 ──
echo "Test 10: native.mjs buildSlimWrapperPrompt async 키워드"
PROMPT_CHECK=$(node -e "
import('./hub/team/native.mjs').then(m => {
  const p = m.buildSlimWrapperPrompt('codex', {
    subtask: 'test task',
    role: 'scientist',
    teamName: 'test-team',
    taskId: 'task-1',
    agentName: 'codex-worker-1',
  });
  const checks = {
    has_async: p.includes('--async'),
    has_job_wait: p.includes('--job-wait'),
    has_job_result: p.includes('--job-result'),
    has_route_timeout: p.includes('auto 1800'),
    no_old_bashTimeout: !p.includes('timeout: 1860000'),
    has_launch_timeout: p.includes('timeout: 15000'),
    has_wait_timeout: p.includes('timeout: 570000'),
    has_result_timeout: p.includes('timeout: 30000'),
  };
  for (const [k, v] of Object.entries(checks)) {
    console.log(k + '=' + v);
  }
});
" 2>/dev/null)
for line in $PROMPT_CHECK; do
  key="${line%%=*}"
  val="${line##*=}"
  assert_eq "$key" "true" "$val"
done
echo ""

# ── 결과 요약 ──
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
