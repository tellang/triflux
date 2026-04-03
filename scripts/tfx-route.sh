#!/usr/bin/env bash
# tfx-route.sh v2.4 — CLI 라우팅 래퍼 (triflux)
#
# v1.x: cli-route.sh (jq+python3+node 혼재, 동기 후처리 ~1s)
# v2.0: tfx-route.sh 리네임
#   - 후처리 전부 tfx-route-post.mjs로 이관 (node 단일 ~100ms)
#   - per-process 에이전트 등록 (race condition 구조적 제거)
#   - get_mcp_hint 통합 (캐시/비캐시 단일 코드경로)
#   - Gemini health check 지수 백오프 (30×1s → 5×exp)
#   - 컨텍스트 파일 5번째 인자 지원
#
VERSION="2.5"
#
# 사용법:
#   tfx-route.sh <agent_type> <prompt> [mcp_profile] [timeout_sec] [context_file]
#   tfx-route.sh --async <agent_type> <prompt> [mcp_profile] [timeout_sec] [context_file]
#   tfx-route.sh --job-status <job_id>
#   tfx-route.sh --job-result <job_id>
#
# --async: 백그라운드 실행, 즉시 job_id 반환 (Claude Code Bash 600초 제한 우회)
# --job-status: running | done | timeout | failed
# --job-result: 완료된 잡의 전체 출력
#
# 예시:
#   tfx-route.sh executor "코드 구현" implement
#   tfx-route.sh --async scientist "딥 리서치" auto 1440
#   tfx-route.sh --job-status 1742400000-12345-9876
#   tfx-route.sh --job-result 1742400000-12345-9876

set -euo pipefail

# ── timeout 명령 호환성 — Windows에서 TIMEOUT.exe 대신 Git Bash coreutils timeout 사용 ──
if command -v /usr/bin/timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="/usr/bin/timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"  # macOS homebrew
else
  TIMEOUT_BIN="timeout"   # Linux 기본
fi

# ── 임시 디렉토리 정규화 ──
resolve_tmp_dir() {
  local candidate=""
  for candidate in "${TMPDIR:-}" "${TEMP:-}" "${TMP:-}" "/tmp"; do
    [[ -n "$candidate" ]] || continue
    if mkdir -p "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  candidate="$(pwd)/.tfx-tmp"
  mkdir -p "$candidate" >/dev/null 2>&1 || true
  printf '%s\n' "$candidate"
}

TFX_TMP="$(resolve_tmp_dir)"

# ── config.toml sandbox/approval_mode 감지 ──
# config.toml에 이미 설정되어 있으면 CLI 플래그 중복 시 Codex가 에러를 던짐
_CODEX_CONFIG="${HOME}/.codex/config.toml"
_CODEX_HAS_SANDBOX=""
if [[ -f "$_CODEX_CONFIG" ]] && grep -qE '^\s*(sandbox|approval_mode)\s*=' "$_CODEX_CONFIG" 2>/dev/null; then
  _CODEX_HAS_SANDBOX="1"
fi

build_codex_base() {
  if [[ -n "$_CODEX_HAS_SANDBOX" ]]; then
    echo "--skip-git-repo-check"
  else
    echo "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"
  fi
}

# ── Async Job 디렉토리 ──
TFX_JOBS_DIR="${TFX_TMP}/tfx-jobs"

# ── --job-status / --job-result 핸들러 (인자 파싱 전에 처리) ──
if [[ "${1:-}" == "--job-status" ]]; then
  job_id="${2:?job_id 필수}"
  job_dir="$TFX_JOBS_DIR/$job_id"
  [[ -d "$job_dir" ]] || { echo "error: job not found"; exit 1; }

  if [[ -f "$job_dir/done" ]]; then
    exit_code=$(cat "$job_dir/exit_code" 2>/dev/null || echo 1)
    if [[ "$exit_code" -eq 0 ]]; then
      echo "done"
    elif [[ "$exit_code" -eq 124 ]]; then
      echo "timeout"
    else
      echo "failed"
    fi
  elif [[ -f "$job_dir/pid" ]]; then
    pid=$(cat "$job_dir/pid")
    if [[ "$pid" == "starting" ]]; then
      echo "starting"
      exit 0
    fi
    if kill -0 "$pid" 2>/dev/null; then
      # 진행 상황 힌트
      local_bytes=$(wc -c < "$job_dir/result.log" 2>/dev/null | tr -d ' ' || echo 0)
      elapsed=$(( $(date +%s) - $(cat "$job_dir/start_time" 2>/dev/null || date +%s) ))
      echo "running elapsed=${elapsed}s output=${local_bytes}B"
    else
      # 프로세스 종료됐는데 done 마커 없음 → 비정상 종료
      echo "failed"
    fi
  else
    echo "error: invalid job state"
    exit 1
  fi
  exit 0
fi

if [[ "${1:-}" == "--job-result" ]]; then
  job_id="${2:?job_id 필수}"
  job_dir="$TFX_JOBS_DIR/$job_id"
  [[ -d "$job_dir" ]] || { echo "error: job not found"; exit 1; }
  [[ -f "$job_dir/done" ]] || { echo "error: job still running"; exit 1; }

  result_bytes=$(wc -c < "$job_dir/result.log" 2>/dev/null | tr -d ' ' || echo 0)
  if [[ "$result_bytes" -eq 0 ]] && [[ -s "$job_dir/stderr.log" ]]; then
    cat "$job_dir/stderr.log" 2>/dev/null
  else
    cat "$job_dir/result.log" 2>/dev/null
  fi
  exit_code=$(cat "$job_dir/exit_code" 2>/dev/null || echo 1)
  exit "$exit_code"
fi

# ── --job-wait: 내부 폴링으로 완료 대기 (Bash 도구 호출 횟수 최소화) ──
# 사용법: tfx-route.sh --job-wait <job_id> [max_seconds=540]
# 출력: 주기적 "waiting elapsed=Ns" + 최종 "done"|"timeout"|"failed"|"still_running"
if [[ "${1:-}" == "--job-wait" ]]; then
  job_id="${2:?job_id 필수}"
  max_wait="${3:-540}"  # 기본 540초 (9분, Bash 도구 600초 제한 이내)
  poll_interval=15
  job_dir="$TFX_JOBS_DIR/$job_id"
  [[ -d "$job_dir" ]] || { echo "error: job not found"; exit 1; }

  elapsed=0
  while [[ "$elapsed" -lt "$max_wait" ]]; do
    if [[ -f "$job_dir/done" ]]; then
      ec=$(cat "$job_dir/exit_code" 2>/dev/null || echo 1)
      if [[ "$ec" -eq 0 ]]; then echo "done"
      elif [[ "$ec" -eq 124 ]]; then echo "timeout"
      else echo "failed (exit=$ec)"
      fi
      exit 0
    fi
    sleep "$poll_interval"
    elapsed=$((elapsed + poll_interval))
    stderr_bytes=$(wc -c < "$job_dir/stderr.log" 2>/dev/null || echo 0)
    echo "waiting elapsed=${elapsed}s progress=${stderr_bytes}B"
  done

  # max_wait 도달했지만 아직 실행 중
  echo "still_running elapsed=${elapsed}s"
  exit 0
fi

# ── --async 플래그 감지 ──
TFX_ASYNC_MODE=0
if [[ "${1:-}" == "--async" ]]; then
  TFX_ASYNC_MODE=1
  shift
fi

# ── 인자 파싱 ──
AGENT_TYPE="${1:?에이전트 타입 필수 (executor, debugger, designer 등)}"
PROMPT="${2:?프롬프트 필수}"
MCP_PROFILE="${3:-auto}"
USER_TIMEOUT="${4:-}"
CONTEXT_FILE="${5:-}"

# ── CLI 이름은 route_agent()에서 기본 역할 alias로 처리됨 (codex→executor, gemini→designer, claude→explore) ──

# ── 인자 검증: MCP_PROFILE이 --flag 형태인 경우 거절 ──
if [[ "$MCP_PROFILE" == --* ]]; then
  echo "ERROR: MCP 프로필 위치(3번째 인자)에 플래그 '$MCP_PROFILE'가 들어왔습니다." >&2
  echo "사용법: tfx-route.sh <역할> \"프롬프트\" [mcp_profile] [timeout]" >&2
  echo "지원 프로필: auto, executor, analyze, implement, review, minimal, full" >&2
  exit 64
fi

# ── CLI 경로 해석 (Windows npm global 대응) ──
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || echo codex)}"
GEMINI_BIN="${GEMINI_BIN:-$(command -v gemini 2>/dev/null || echo gemini)}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo claude)}"
GEMINI_BIN_ARGS_JSON="${GEMINI_BIN_ARGS_JSON:-[]}"
CLAUDE_BIN_ARGS_JSON="${CLAUDE_BIN_ARGS_JSON:-[]}"

# ── Gemini 프로필 경로 (Codex config.toml 대칭) ──
GEMINI_PROFILES_PATH="${GEMINI_PROFILES_PATH:-$(eval echo ~)/.gemini/triflux-profiles.json}"

# ── 상수 ──
MAX_STDOUT_BYTES=51200  # 50KB — Claude 컨텍스트 절약
TIMESTAMP=$(date +%s)
RUN_ID="${TIMESTAMP}-$$-${RANDOM}"
STDERR_LOG="${TFX_TMP}/tfx-route-${AGENT_TYPE}-${RUN_ID}-stderr.log"
STDOUT_LOG="${TFX_TMP}/tfx-route-${AGENT_TYPE}-${RUN_ID}-stdout.log"

# ── 팀 환경변수 ──
TFX_TEAM_NAME="${TFX_TEAM_NAME:-}"
TFX_TEAM_TASK_ID="${TFX_TEAM_TASK_ID:-}"
TFX_TEAM_AGENT_NAME="${TFX_TEAM_AGENT_NAME:-${AGENT_TYPE}-worker-$$}"
TFX_TEAM_LEAD_NAME="${TFX_TEAM_LEAD_NAME:-team-lead}"
TFX_HUB_PIPE="${TFX_HUB_PIPE:-}"
TFX_HUB_URL="${TFX_HUB_URL:-http://127.0.0.1:27888}"  # bridge.mjs HTTP fallback hint

# ── 패키지 루트 해석 (setup.mjs가 기록한 breadcrumb) ──
TFX_PKG_ROOT=""
_tfx_breadcrumb="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.tfx-pkg-root"
if [[ -f "$_tfx_breadcrumb" ]]; then
  TFX_PKG_ROOT="$(head -1 "$_tfx_breadcrumb" 2>/dev/null | tr -d '\r\n')"
fi
unset _tfx_breadcrumb

# fallback 시 원래 에이전트 정보 보존
ORIGINAL_AGENT=""
ORIGINAL_CLI_ARGS=""

# JSON 문자열 이스케이프:
# - "\", """ 필수 이스케이프
# - 제어문자 U+0000..U+001F 이스케이프
# - 비ASCII 문자는 \uXXXX(또는 surrogate pair)로 강제
json_escape() {
  local s="${1:-}"

  if command -v "$NODE_BIN" &>/dev/null; then
    "$NODE_BIN" -e '
      const input = process.argv[1] ?? "";
      let out = "";
      for (const ch of input) {
        const cp = ch.codePointAt(0);
        if (cp === 0x22) { out += "\\\""; continue; }   // "
        if (cp === 0x5c) { out += "\\\\"; continue; }   // \
        if (cp <= 0x1f) {
          if (cp === 0x08) { out += "\\b"; continue; }
          if (cp === 0x09) { out += "\\t"; continue; }
          if (cp === 0x0a) { out += "\\n"; continue; }
          if (cp === 0x0c) { out += "\\f"; continue; }
          if (cp === 0x0d) { out += "\\r"; continue; }
          out += `\\u${cp.toString(16).padStart(4, "0")}`;
          continue;
        }
        if (cp >= 0x20 && cp <= 0x7e) {
          out += ch;
          continue;
        }
        if (cp <= 0xffff) {
          out += `\\u${cp.toString(16).padStart(4, "0")}`;
          continue;
        }
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      }
      process.stdout.write(out);
    ' -- "$s"
    return
  fi

  echo "[tfx-route] ERROR: node 미설치로 안전한 JSON 이스케이프를 수행할 수 없습니다." >&2
  return 1
}

# ── Per-process 에이전트 등록 (원자적, 락 불필요) ──
register_agent() {
  local agent_file="${TFX_TMP}/tfx-agent-$$.json"
  local safe_cli safe_agent started_at
  safe_cli=$(json_escape "$CLI_TYPE" 2>/dev/null || true)
  safe_agent=$(json_escape "$AGENT_TYPE" 2>/dev/null || true)
  started_at=$(date +%s)

  # fail-closed: 안전 인코딩 불가 시 agent 파일을 쓰지 않는다
  if [[ -n "$CLI_TYPE" && -z "$safe_cli" ]]; then
    return 0
  fi
  if [[ -n "$AGENT_TYPE" && -z "$safe_agent" ]]; then
    return 0
  fi

  printf '{"pid":%s,"cli":"%s","agent":"%s","started":%s}\n' "$$" "$safe_cli" "$safe_agent" "$started_at" \
    > "$agent_file" 2>/dev/null || true
}

deregister_agent() {
  rm -f "${TFX_TMP}/tfx-agent-$$.json" 2>/dev/null || true
}

normalize_script_path() {
  local path="${1:-}"
  if [[ -z "$path" ]]; then
    return 0
  fi

  if command -v cygpath &>/dev/null; then
    case "$path" in
      [A-Za-z]:\\*|[A-Za-z]:/*)
        cygpath -u "$path"
        return 0
        ;;
    esac
  fi

  printf '%s\n' "$path"
}

# ── 팀 Hub Bridge 통신 ──
resolve_bridge_script() {
  if [[ -n "${TFX_BRIDGE_SCRIPT:-}" && -f "$TFX_BRIDGE_SCRIPT" ]]; then
    printf '%s\n' "$TFX_BRIDGE_SCRIPT"
    return 0
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local candidates=()
  [[ -n "$TFX_PKG_ROOT" ]] && candidates+=("$TFX_PKG_ROOT/hub/bridge.mjs")
  candidates+=(
    "$script_dir/../hub/bridge.mjs"
    "$script_dir/hub/bridge.mjs"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

bridge_cli() {
  if ! command -v "$NODE_BIN" &>/dev/null; then
    return 127
  fi

  local bridge_script
  if ! bridge_script=$(resolve_bridge_script); then
    return 127
  fi

  TFX_HUB_PIPE="$TFX_HUB_PIPE" TFX_HUB_URL="$TFX_HUB_URL" TFX_HUB_TOKEN="${TFX_HUB_TOKEN:-}" \
    "$NODE_BIN" "$bridge_script" "$@" 2>/dev/null
}

bridge_json_get() {
  local json="${1:-}"
  local path="${2:-}"
  [[ -z "$json" || -z "$path" ]] && return 1

  "$NODE_BIN" -e '
    const data = JSON.parse(process.argv[1] || "{}");
    const keys = String(process.argv[2] || "").split(".").filter(Boolean);
    let value = data;
    for (const key of keys) value = value?.[key];
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
  ' -- "$json" "$path" 2>/dev/null
}

bridge_json_stringify() {
  local mode="${1:-}"
  shift || true

  case "$mode" in
    metadata-patch)
      "$NODE_BIN" -e '
        process.stdout.write(JSON.stringify({
          result: process.argv[1] || "",
          summary: process.argv[2] || "",
        }));
      ' -- "${1:-}" "${2:-}"
      ;;
    task-result)
      "$NODE_BIN" -e '
        process.stdout.write(JSON.stringify({
          task_id: process.argv[1] || "",
          result: process.argv[2] || "",
        }));
      ' -- "${1:-}" "${2:-}"
      ;;
    *)
      return 1
      ;;
  esac
}

team_send_message() {
  local text="${1:-}"
  local summary="${2:-}"
  [[ -z "$TFX_TEAM_NAME" || -z "$text" ]] && return 0

  if ! bridge_cli_with_restart "팀 메시지 전송" "Hub 재시작 후 팀 메시지 전송 성공." \
    team-send-message \
    --team "$TFX_TEAM_NAME" \
    --from "$TFX_TEAM_AGENT_NAME" \
    --to "$TFX_TEAM_LEAD_NAME" \
    --text "$text" \
    --summary "${summary:-status update}"; then
    echo "[tfx-route] 경고: 팀 메시지 전송 실패 (team=$TFX_TEAM_NAME, to=$TFX_TEAM_LEAD_NAME)" >&2
    return 0
  fi

  return 0
}

# ── Hub 자동 재시작 (슬립 복귀 등으로 Hub 종료 시) ──
try_restart_hub() {
  local hub_server script_dir hub_port
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  hub_server=""
  local _hub_candidates=()
  [[ -n "$TFX_PKG_ROOT" ]] && _hub_candidates+=("$TFX_PKG_ROOT/hub/server.mjs")
  _hub_candidates+=("$script_dir/../hub/server.mjs")
  for _hc in "${_hub_candidates[@]}"; do
    if [[ -f "$_hc" ]]; then hub_server="$_hc"; break; fi
  done
  unset _hub_candidates _hc

  if [[ -z "$hub_server" ]]; then
    echo "[tfx-route] Hub 서버 스크립트 미발견 (pkg_root=${TFX_PKG_ROOT:-unset}, script_dir=$script_dir)" >&2
    return 1
  fi

  # TFX_HUB_URL에서 포트 추출 (기본 27888)
  hub_port="${TFX_HUB_URL##*:}"
  hub_port="${hub_port%%/*}"
  [[ -z "$hub_port" || "$hub_port" == "$TFX_HUB_URL" ]] && hub_port=27888

  echo "[tfx-route] Hub 미응답 — 자동 재시작 시도 (port=$hub_port)..." >&2
  TFX_HUB_PORT="$hub_port" "$NODE_BIN" "$hub_server" &>/dev/null &
  local hub_pid=$!

  # 최대 4초 대기 (0.5초 간격)
  local i
  for i in 1 2 3 4 5 6 7 8; do
    sleep 0.5
    if curl -sf "${TFX_HUB_URL}/status" >/dev/null 2>&1; then
      echo "[tfx-route] Hub 재시작 성공 (pid=$hub_pid)" >&2
      return 0
    fi
  done

  echo "[tfx-route] Hub 재시작 실패 — claim 없이 계속 실행" >&2
  return 1
}

bridge_cli_with_restart() {
  local action_label="${1:-bridge 호출}"
  local success_message="${2:-}"
  shift 2 || true

  if bridge_cli "$@" >/dev/null 2>&1; then
    return 0
  fi

  if ! try_restart_hub; then
    return 1
  fi

  if bridge_cli "$@" >/dev/null 2>&1; then
    [[ -n "$success_message" ]] && echo "[tfx-route] ${success_message}" >&2
    return 0
  fi

  echo "[tfx-route] 경고: Hub 재시작 후 ${action_label} 재시도 실패." >&2
  return 1
}

team_claim_task() {
  [[ -z "$TFX_TEAM_NAME" || -z "$TFX_TEAM_TASK_ID" ]] && return 0
  local response ok error_code error_message owner_before status_before
  response=$(bridge_cli team-task-update \
    --team "$TFX_TEAM_NAME" \
    --task-id "$TFX_TEAM_TASK_ID" \
    --claim \
    --owner "$TFX_TEAM_AGENT_NAME" \
    --status in_progress || true)

  ok=$(bridge_json_get "$response" "ok" || true)
  error_code=$(bridge_json_get "$response" "error.code" || true)
  error_message=$(bridge_json_get "$response" "error.message" || true)
  owner_before=$(bridge_json_get "$response" "error.details.task_before.owner" || true)
  status_before=$(bridge_json_get "$response" "error.details.task_before.status" || true)

  case "$ok:$error_code" in
    true:*) ;;
    false:CLAIM_CONFLICT)
      if [[ "$owner_before" == "$TFX_TEAM_AGENT_NAME" && "$status_before" == "in_progress" ]]; then
        echo "[tfx-route] 동일 owner(${TFX_TEAM_AGENT_NAME})가 이미 claim한 task ${TFX_TEAM_TASK_ID} — 계속 실행." >&2
        return 0
      fi
      echo "[tfx-route] CLAIM_CONFLICT: task ${TFX_TEAM_TASK_ID}가 이미 claim됨(owner=${owner_before:-unknown}, status=${status_before:-unknown}). 실행 중단." >&2
      team_send_message \
        "task ${TFX_TEAM_TASK_ID} claim conflict: owner=${owner_before:-unknown}, status=${status_before:-unknown}" \
        "task ${TFX_TEAM_TASK_ID} claim conflict"
      exit 0 ;;
    :|false:)
      # Hub 연결 실패 → 자동 재시작 시도 후 claim 재시도
      if try_restart_hub; then
        response=$(bridge_cli team-task-update \
          --team "$TFX_TEAM_NAME" \
          --task-id "$TFX_TEAM_TASK_ID" \
          --claim \
          --owner "$TFX_TEAM_AGENT_NAME" \
          --status in_progress || true)
        ok=$(bridge_json_get "$response" "ok" || true)
        if [[ "$ok" == "true" ]]; then
          echo "[tfx-route] Hub 재시작 후 claim 성공." >&2
        else
          echo "[tfx-route] 경고: Hub 재시작 후 claim 실패. claim 없이 계속 실행." >&2
        fi
      else
        echo "[tfx-route] 경고: Hub 연결 실패 (미실행?). claim 없이 계속 실행." >&2
      fi ;;
    *)
      echo "[tfx-route] 경고: Hub claim 실패 (${error_code:-unknown}${error_message:+: ${error_message}}). claim 없이 계속 실행." >&2 ;;
  esac
}

team_complete_task() {
  local result="${1:-success}"            # success/failed/timeout
  local result_summary="${2:-작업 완료}"
  [[ -z "$TFX_TEAM_NAME" || -z "$TFX_TEAM_TASK_ID" ]] && return 0

  local summary_trimmed result_payload
  summary_trimmed=$(echo "$result_summary" | head -c 4096)
  result_payload=$(bridge_json_stringify task-result "$TFX_TEAM_TASK_ID" "$result" 2>/dev/null || true)

  # task 파일 completion 쓰기는 Worker Step 6 TaskUpdate가 authority다.
  # route 레벨에서는 task.result 발행 + 로컬 backup만 유지한다.

  # Hub result 발행 (poll_messages 채널 활성화)
  if [[ -n "$result_payload" ]]; then
    if ! bridge_cli_with_restart "Hub result 발행" "Hub 재시작 후 Hub result 발행 성공." \
      result \
      --agent "$TFX_TEAM_AGENT_NAME" \
      --topic task.result \
      --payload "$result_payload" \
      --trace "$TFX_TEAM_NAME"; then
      echo "[tfx-route] 경고: Hub result 발행 실패 (agent=$TFX_TEAM_AGENT_NAME, task=$TFX_TEAM_TASK_ID)" >&2
    fi
  fi

  # 로컬 결과 파일 백업 (세션 끊김 복구용)
  # Claude 재로그인 시 Agent 래퍼가 죽어도 이 파일로 결과 수집 가능
  local result_dir="${TFX_RESULT_DIR:-${HOME}/.claude/tfx-results/${TFX_TEAM_NAME}}"
  if mkdir -p "$result_dir" 2>/dev/null; then
    cat > "${result_dir}/${TFX_TEAM_TASK_ID}.json" 2>/dev/null <<RESULT_EOF
{"taskId":"${TFX_TEAM_TASK_ID}","agent":"${TFX_TEAM_AGENT_NAME}","team":"${TFX_TEAM_NAME}","result":"${result}","summary":$(printf '%s' "$summary_trimmed" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(d)))" 2>/dev/null || echo '""'),"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
RESULT_EOF
    [[ $? -eq 0 ]] && echo "[tfx-route] 결과 백업: ${result_dir}/${TFX_TEAM_TASK_ID}.json" >&2
  fi
}

detect_quota_exceeded() {
  local stdout_file="$1"
  local stderr_file="$2"
  local -a patterns=(
    "usage limit exceeded" "rate limit exceeded" "rate limit reached"
    "try again at" "purchase more credits"
    "quota exceeded" "RESOURCE_EXHAUSTED" "rateLimitExceeded" "Too Many Requests"
    "rate_limit_error" "overloaded_error" "insufficient_quota"
  )
  local pattern
  for pattern in "${patterns[@]}"; do
    if grep -qi "$pattern" "$stdout_file" 2>/dev/null || grep -qi "$pattern" "$stderr_file" 2>/dev/null; then
      echo "[tfx-quota] 감지: '$pattern' in $CLI_TYPE" >&2
      return 0
    fi
  done
  return 1
}

auto_reroute() {
  local failed_cli="$1"
  local target_cli=""
  case "$failed_cli" in
    codex) target_cli="gemini"; echo "[tfx-quota] Codex → Gemini 자동 전환" >&2 ;;
    gemini) target_cli="codex"; echo "[tfx-quota] Gemini → Codex 자동 전환" >&2 ;;
    *) echo "[tfx-quota] $failed_cli 대체 CLI 없음" >&2; return 1 ;;
  esac

  # 대상 CLI 존재 확인 (P2: command not found 방지)
  local target_bin
  case "$target_cli" in
    codex) target_bin="$CODEX_BIN" ;;
    gemini) target_bin="$GEMINI_BIN" ;;
  esac
  if ! command -v "$target_bin" &>/dev/null; then
    echo "[tfx-quota] $target_cli CLI 미설치 — 자동 전환 불가" >&2
    return 1
  fi

  local quota_marker="$TFX_TMP/tfx-quota-${failed_cli}-$(date +%Y%m%d)"
  echo "$(date +%s)" >> "$quota_marker"
  ORIGINAL_AGENT="$AGENT_TYPE"
  ORIGINAL_CLI_ARGS="$CLI_ARGS"
  export TFX_REROUTED_FROM="$CLI_TYPE"
  TFX_CLI_MODE="$target_cli" exec bash "${BASH_SOURCE[0]}" \
    "$AGENT_TYPE" "$PROMPT" "$MCP_PROFILE" "$USER_TIMEOUT" "$CONTEXT_FILE"
}

capture_workspace_signature() {
  if ! command -v git &>/dev/null; then
    return 1
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 1
  fi

  git status --short --untracked-files=all --ignore-submodules=all 2>/dev/null || return 1
}

# ── Codex CLI 버전 감지 (캐시) ──
_CODEX_VERSION=""
get_codex_version() {
  if [[ -n "$_CODEX_VERSION" ]]; then echo "$_CODEX_VERSION"; return; fi
  local raw
  raw=$("$CODEX_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  _CODEX_VERSION="${raw:-0.0.0}"
  echo "$_CODEX_VERSION"
}

# codex_gte <min_version>: 현재 버전이 min 이상이면 true(0), 아니면 false(1)
codex_gte() {
  local min="$1"
  local cur
  cur=$(get_codex_version)
  printf '%s\n%s' "$min" "$cur" | sort -V | head -1 | grep -q "^${min}$"
}

# ── Gemini 프로필 해석 (Codex --profile 대칭) ──
_GEMINI_PROFILE_CACHE=""
resolve_gemini_profile() {
  local profile="$1"
  if [[ "$profile" == gemini-* ]]; then
    echo "$profile"
    return
  fi
  if [[ -z "$_GEMINI_PROFILE_CACHE" && -f "$GEMINI_PROFILES_PATH" ]]; then
    _GEMINI_PROFILE_CACHE=$(cat "$GEMINI_PROFILES_PATH" 2>/dev/null || echo "{}")
  fi
  local settings_path="${HOME}/.gemini/settings.json"
  local settings_cache="{}"
  if [[ -f "$settings_path" ]]; then
    settings_cache=$(cat "$settings_path" 2>/dev/null || echo "{}")
  fi
  local result
  result=$("$NODE_BIN" -e "
    const name = process.argv[1];
    const primaryRaw = process.argv[2] || '{}';
    const settingsRaw = process.argv[3] || '{}';
    const defaults = {
      pro31: 'gemini-3.1-pro-preview',
      flash3: 'gemini-3-flash-preview',
      pro25: 'gemini-2.5-pro',
      flash25: 'gemini-2.5-flash',
      lite25: 'gemini-2.5-flash-lite'
    };

    if (typeof name === 'string' && name.startsWith('gemini-')) {
      process.stdout.write(name);
      process.exit(0);
    }

    const parseJson = (raw) => {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    };

    const getModelValue = (entry) => {
      if (!entry) return '';
      if (typeof entry === 'string') return entry;
      if (typeof entry !== 'object') return '';
      if (typeof entry.model === 'string') return entry.model;
      if (typeof entry.name === 'string' && entry.name.startsWith('gemini-')) return entry.name;
      if (entry.model && typeof entry.model.name === 'string') return entry.model.name;
      return '';
    };

    const getProfileBuckets = (cfg) => {
      const buckets = [];
      if (cfg.profiles && typeof cfg.profiles === 'object') buckets.push(cfg.profiles);
      if (cfg.model?.profiles && typeof cfg.model.profiles === 'object') buckets.push(cfg.model.profiles);
      if (cfg.modelProfiles && typeof cfg.modelProfiles === 'object') buckets.push(cfg.modelProfiles);
      if (cfg.models && typeof cfg.models === 'object') buckets.push(cfg.models);
      return buckets;
    };

    const getDefaultModel = (cfg) => {
      return (
        (typeof cfg.defaultModel === 'string' && cfg.defaultModel) ||
        (typeof cfg.default_profile === 'string' && cfg.default_profile) ||
        (typeof cfg.defaultProfile === 'string' && cfg.defaultProfile) ||
        (typeof cfg.model === 'string' && cfg.model) ||
        (typeof cfg.model?.default === 'string' && cfg.model.default) ||
        ''
      );
    };

    const sources = [parseJson(primaryRaw), parseJson(settingsRaw)];
    for (const cfg of sources) {
      for (const bucket of getProfileBuckets(cfg)) {
        const value = getModelValue(bucket[name]);
        if (value) {
          process.stdout.write(value);
          process.exit(0);
        }
      }
    }

    if (name === 'default') {
      for (const cfg of sources) {
        const value = getDefaultModel(cfg);
        if (value) {
          process.stdout.write(value);
          process.exit(0);
        }
      }
    }

    process.stdout.write(defaults[name] || defaults.pro31);
  " "$profile" "$_GEMINI_PROFILE_CACHE" "$settings_cache" 2>/dev/null)
  echo "${result:-gemini-3.1-pro-preview}"
}

# ── 라우팅 테이블 ──
# CLI_TYPE/CLI_CMD: agent-map.json 단일 소스. 상세 설정: 아래 case 문.
# 반환: CLI_TYPE, CLI_CMD, CLI_ARGS, CLI_EFFORT, DEFAULT_TIMEOUT, RUN_MODE, OPUS_OVERSIGHT
route_agent() {
  local agent="$1"
  local codex_base
  codex_base="$(build_codex_base)"
  echo "[tfx-route] Codex 버전: $(get_codex_version)" >&2
  local map_file
  map_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../hub/team/agent-map.json"
  # ── breadcrumb 폴백 (synced 환경: ~/.claude/scripts/) ──
  if [[ ! -f "$map_file" && -n "$TFX_PKG_ROOT" ]]; then
    map_file="$TFX_PKG_ROOT/hub/team/agent-map.json"
  fi
  if [[ ! -f "$map_file" ]]; then
    echo "ERROR: agent-map.json 미발견 (경로: $map_file, TFX_PKG_ROOT=${TFX_PKG_ROOT:-unset})" >&2
    exit 1
  fi

  # ── CLI_TYPE: 단일 소스 (agent-map.json) ──
  local _raw_type
  _raw_type=$(node -e "
    const p=require('path').resolve(process.argv[1]);
    const m=JSON.parse(require('fs').readFileSync(p,'utf8'));
    const t=m[process.argv[2]];
    if(t)process.stdout.write(t);
  " "$map_file" "$agent" 2>/dev/null)

  if [[ -z "$_raw_type" ]]; then
    echo "ERROR: 알 수 없는 에이전트 타입: $agent" >&2
    echo "사용 가능: $(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(require('path').resolve(process.argv[1]),'utf8'))).join(', '))" "$map_file" 2>/dev/null)" >&2
    exit 1
  fi

  # "claude" → "claude-native" (headless.mjs는 "claude", route.sh는 "claude-native")
  CLI_TYPE="$_raw_type"
  [[ "$CLI_TYPE" == "claude" ]] && CLI_TYPE="claude-native"

  # ── CLI_CMD: CLI_TYPE에서 파생 ──
  case "$CLI_TYPE" in
    codex)         CLI_CMD="codex" ;;
    gemini)        CLI_CMD="gemini" ;;
    claude-native) CLI_CMD=""; CLI_ARGS="" ;;
  esac

  # ── 에이전트별 상세 설정 ──
  case "$agent" in
    # ─── 구현 레인 ───
    executor)
      CLI_ARGS="exec --profile codex53_high ${codex_base}"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1080; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    build-fixer)
      CLI_ARGS="exec --profile codex53_low ${codex_base}"
      CLI_EFFORT="codex53_low"; DEFAULT_TIMEOUT=540; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    debugger)
      CLI_ARGS="exec --profile codex53_high ${codex_base}"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    deep-executor)
      CLI_ARGS="exec --profile gpt54_xhigh ${codex_base}"
      CLI_EFFORT="gpt54_xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;

    # ─── 설계/분석 레인 (5.4: 1M 컨텍스트, 에이전틱) ───
    architect)
      CLI_ARGS="exec --profile gpt54_xhigh ${codex_base}"
      CLI_EFFORT="gpt54_xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    planner)
      CLI_ARGS="exec --profile gpt54_xhigh ${codex_base}"
      CLI_EFFORT="gpt54_xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="fg"; OPUS_OVERSIGHT="true" ;;
    critic)
      CLI_ARGS="exec --profile gpt54_xhigh ${codex_base}"
      CLI_EFFORT="gpt54_xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    analyst)
      CLI_ARGS="exec --profile gpt54_xhigh ${codex_base}"
      CLI_EFFORT="gpt54_xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="fg"; OPUS_OVERSIGHT="true" ;;

    # ─── 리뷰 레인 (5.3-codex: SWE-Bench 72%) ───
    code-reviewer)
      CLI_ARGS="exec --profile codex53_high ${codex_base} review"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    security-reviewer)
      CLI_ARGS="exec --profile codex53_high ${codex_base} review"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    quality-reviewer)
      CLI_ARGS="exec --profile codex53_high ${codex_base} review"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 리서치 레인 ───
    scientist)
      CLI_ARGS="exec --profile codex53_high ${codex_base}"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1440; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    scientist-deep)
      CLI_ARGS="exec --profile gpt54_high ${codex_base}"
      CLI_EFFORT="gpt54_high"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    document-specialist)
      CLI_ARGS="exec --profile codex53_high ${codex_base}"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1440; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── UI/문서 레인 ───
    designer)
      CLI_ARGS="-m $(resolve_gemini_profile pro31) -y --prompt"
      CLI_EFFORT="pro31"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    writer)
      CLI_ARGS="-m $(resolve_gemini_profile flash3) -y --prompt"
      CLI_EFFORT="flash3"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 탐색 (Claude-native: Glob/Grep/Read 직접 접근) ───
    explore)
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=600; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;

    # ─── 검증/테스트 (Codex: 무료 + 파일 쓰기 가능) ───
    verifier)
      CLI_ARGS="exec --profile codex53_high ${codex_base} review"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1200; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    test-engineer)
      CLI_ARGS="exec --profile codex53_high ${codex_base}"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1200; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    qa-tester)
      CLI_ARGS="exec --profile codex53_high ${codex_base} review"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1200; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 경량 ───
    spark)
      CLI_ARGS="exec --profile spark53_low ${codex_base}"
      CLI_EFFORT="spark53_low"; DEFAULT_TIMEOUT=180; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    # ─── CLI 이름 alias (사용자 편의) ───
    codex)
      CLI_ARGS="exec --profile codex53_high ${codex_base}"
      CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1080; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    gemini)
      CLI_ARGS="-m $(resolve_gemini_profile pro31) -y --prompt"
      CLI_EFFORT="pro31"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    claude)
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=600; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    # ─── agent-map.json에만 정의된 신규 에이전트 (CLI_TYPE별 기본값) ───
    *)
      case "$CLI_TYPE" in
        codex)
          CLI_ARGS="exec --profile codex53_high ${codex_base}"
          CLI_EFFORT="codex53_high"; DEFAULT_TIMEOUT=1080; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
        gemini)
          CLI_ARGS="-m $(resolve_gemini_profile pro31) -y --prompt"
          CLI_EFFORT="pro31"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
        claude-native)
          CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=600; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
      esac ;;
  esac
}

# ── CLI 모드 오버라이드 (tfx-codex / tfx-gemini 스킬용) ──
TFX_CLI_MODE="${TFX_CLI_MODE:-auto}"
TFX_NO_CLAUDE_NATIVE="${TFX_NO_CLAUDE_NATIVE:-0}"
TFX_VERIFIER_OVERRIDE="${TFX_VERIFIER_OVERRIDE:-auto}"
TFX_CODEX_TRANSPORT="${TFX_CODEX_TRANSPORT:-exec}"
# Preflight 캐시 일괄 로드 — CLI/Hub 가용성 + Codex 요금제를 환경변수로 내보냄
# 하위 프로세스(스킬 포함)가 TFX_CODEX_OK, TFX_GEMINI_OK, TFX_HUB_OK로 즉시 참조 가능
if [[ -z "${TFX_PREFLIGHT_LOADED:-}" ]]; then
  eval "$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(require("path").join(require("os").homedir(),".claude","cache","tfx-preflight.json"),"utf8"));
      const lines = [];
      lines.push("export TFX_CODEX_OK=" + (c?.codex?.ok ? "1" : "0"));
      lines.push("export TFX_GEMINI_OK=" + (c?.gemini?.ok ? "1" : "0"));
      lines.push("export TFX_HUB_OK=" + (c?.hub?.ok ? "1" : "0"));
      const p = c?.codex_plan?.plan;
      if (p && p !== "unknown" && p !== "api") lines.push("export TFX_CODEX_PLAN=" + p);
      const agents = c?.available_agents;
      if (Array.isArray(agents)) lines.push("export TFX_AVAILABLE_AGENTS=" + agents.join(","));
      lines.push("export TFX_PREFLIGHT_LOADED=1");
      process.stdout.write(lines.join("\n") + "\n");
    } catch { process.stdout.write("export TFX_PREFLIGHT_LOADED=1\n"); }
  ' 2>/dev/null)"
  TFX_CODEX_PLAN="${TFX_CODEX_PLAN:-pro}"
fi
TFX_WORKER_INDEX="${TFX_WORKER_INDEX:-}"
TFX_SEARCH_TOOL="${TFX_SEARCH_TOOL:-}"
case "$TFX_NO_CLAUDE_NATIVE" in
  0|1) ;;
  *)
    echo "ERROR: TFX_NO_CLAUDE_NATIVE 값은 0 또는 1이어야 합니다. (현재: $TFX_NO_CLAUDE_NATIVE)" >&2
    exit 1
    ;;
esac
case "$TFX_CODEX_PLAN" in
  pro|plus|free) ;;
  *)
    echo "ERROR: TFX_CODEX_PLAN 값은 pro, plus, free 중 하나여야 합니다. (현재: $TFX_CODEX_PLAN)" >&2
    exit 1
    ;;
esac
case "$TFX_CODEX_TRANSPORT" in
  auto|mcp|exec) ;;
  *)
    echo "ERROR: TFX_CODEX_TRANSPORT 값은 auto, mcp, exec 중 하나여야 합니다. (현재: $TFX_CODEX_TRANSPORT)" >&2
    exit 1
    ;;
esac
case "$TFX_VERIFIER_OVERRIDE" in
  auto|claude) ;;
  *)
    echo "ERROR: TFX_VERIFIER_OVERRIDE 값은 auto 또는 claude여야 합니다. (현재: $TFX_VERIFIER_OVERRIDE)" >&2
    exit 1
    ;;
esac
case "$TFX_WORKER_INDEX" in
  "") ;;
  *[!0-9]*|0)
    echo "ERROR: TFX_WORKER_INDEX 값은 1 이상의 정수여야 합니다. (현재: $TFX_WORKER_INDEX)" >&2
    exit 1
    ;;
esac
case "$TFX_SEARCH_TOOL" in
  ""|brave-search|tavily|exa) ;;
  *)
    echo "ERROR: TFX_SEARCH_TOOL 값은 brave-search, tavily, exa 중 하나여야 합니다. (현재: $TFX_SEARCH_TOOL)" >&2
    exit 1
    ;;
esac
CODEX_MCP_TRANSPORT_EXIT_CODE=70

apply_cli_mode() {
  local codex_base
  codex_base="$(build_codex_base)"
  local gemini_tier=""

  case "$TFX_CLI_MODE" in
    codex)
      if [[ "$CLI_TYPE" == "gemini" ]]; then
        CLI_TYPE="codex"; CLI_CMD="codex"
        case "$AGENT_TYPE" in
          designer)
            CLI_ARGS="exec --profile gpt54_xhigh ${codex_base}"; CLI_EFFORT="gpt54_xhigh"; DEFAULT_TIMEOUT=600 ;;
          writer)
            CLI_ARGS="exec --profile spark53_low ${codex_base}"; CLI_EFFORT="spark53_low"; DEFAULT_TIMEOUT=180 ;;
        esac
        echo "[tfx-route] TFX_CLI_MODE=codex: $AGENT_TYPE → codex($CLI_EFFORT)로 리매핑" >&2
      fi ;;
    gemini)
      if [[ "$CLI_TYPE" == "codex" ]]; then
        case "$AGENT_TYPE" in
          verifier)
            CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
            CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=1200; RUN_MODE="fg"; OPUS_OVERSIGHT="false"
            echo "[tfx-route] TFX_CLI_MODE=gemini: verifier는 claude-native 유지" >&2
            return 0
            ;;
          test-engineer)
            CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
            CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=1200; RUN_MODE="bg"; OPUS_OVERSIGHT="false"
            echo "[tfx-route] TFX_CLI_MODE=gemini: test-engineer는 claude-native 유지" >&2
            return 0
            ;;
        esac
        CLI_TYPE="gemini"; CLI_CMD="gemini"
        case "$AGENT_TYPE" in
          executor|debugger|deep-executor|architect|planner|critic|analyst|\
          code-reviewer|security-reviewer|quality-reviewer|scientist-deep|designer)
            CLI_ARGS="-m $(resolve_gemini_profile pro31) -y --prompt"; CLI_EFFORT="pro31" ;;
          build-fixer|spark)
            CLI_ARGS="-m $(resolve_gemini_profile flash3) -y --prompt"; CLI_EFFORT="flash3"; DEFAULT_TIMEOUT=180 ;;
          writer)
            CLI_ARGS="-m $(resolve_gemini_profile flash3) -y --prompt"; CLI_EFFORT="flash3" ;;
          *)
            CLI_ARGS="-m $(resolve_gemini_profile flash3) -y --prompt"; CLI_EFFORT="flash3" ;;
        esac
        case "$CLI_EFFORT" in
          pro*) gemini_tier="pro" ;;
          flash*|lite*) gemini_tier="flash" ;;
          *) gemini_tier="$CLI_EFFORT" ;;
        esac
        echo "[tfx-route] TFX_CLI_MODE=gemini: $AGENT_TYPE → gemini($gemini_tier)로 리매핑" >&2
      fi ;;
    auto)
      if [[ "$CLI_TYPE" == "codex" ]] && ! command -v "$CODEX_BIN" &>/dev/null; then
        if command -v "$GEMINI_BIN" &>/dev/null; then
          TFX_CLI_MODE="gemini"; apply_cli_mode; return
        else
          ORIGINAL_AGENT="${AGENT_TYPE}"; ORIGINAL_CLI_ARGS="$CLI_ARGS"
          CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
          echo "[tfx-route] codex/gemini 모두 미설치: $AGENT_TYPE → claude-native fallback" >&2
        fi
      elif [[ "$CLI_TYPE" == "gemini" ]] && ! command -v "$GEMINI_BIN" &>/dev/null; then
        if command -v "$CODEX_BIN" &>/dev/null; then
          TFX_CLI_MODE="codex"; apply_cli_mode; return
        else
          ORIGINAL_AGENT="${AGENT_TYPE}"; ORIGINAL_CLI_ARGS="$CLI_ARGS"
          CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
          echo "[tfx-route] codex/gemini 모두 미설치: $AGENT_TYPE → claude-native fallback" >&2
        fi
      fi ;;
  esac
}

# ── Codex 요금제 가드 (spark 프로필은 Pro 전용) ──
apply_plan_guard() {
  [[ "$CLI_TYPE" != "codex" ]] && return
  [[ "$TFX_CODEX_PLAN" == "pro" ]] && return

  if [[ "$CLI_EFFORT" == spark53_* ]]; then
    local codex_base
  codex_base="$(build_codex_base)"
    CLI_ARGS="exec --profile codex53_high ${codex_base}"
    CLI_EFFORT="codex53_high"
    echo "[tfx-route] TFX_CODEX_PLAN=$TFX_CODEX_PLAN: spark → codex53_high로 다운그레이드 (Pro 전용)" >&2
  fi
}

# ── Claude 네이티브 제거 (Codex 리드 환경에서 선택적 활성화) ──
apply_no_claude_native_mode() {
  local codex_base
  codex_base="$(build_codex_base)"

  [[ "$TFX_NO_CLAUDE_NATIVE" != "1" ]] && return
  [[ "$TFX_CLI_MODE" == "gemini" ]] && return
  [[ "$CLI_TYPE" != "claude-native" ]] && return

  if ! command -v "$CODEX_BIN" &>/dev/null; then
    echo "[tfx-route] TFX_NO_CLAUDE_NATIVE=1 이지만 codex를 찾지 못해 claude-native 유지" >&2
    return
  fi

  ORIGINAL_AGENT="${AGENT_TYPE}"
  CLI_TYPE="codex"; CLI_CMD="codex"

  case "$AGENT_TYPE" in
    explore)
      CLI_ARGS="exec --profile codex53_low ${codex_base}"
      CLI_EFFORT="codex53_low"
      DEFAULT_TIMEOUT=600
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    verifier)
      CLI_ARGS="exec --profile codex53_high ${codex_base} review"
      CLI_EFFORT="codex53_high"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    test-engineer)
      CLI_ARGS="exec --profile codex53_high ${codex_base}"
      CLI_EFFORT="codex53_high"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    qa-tester)
      CLI_ARGS="exec --profile codex53_high ${codex_base} review"
      CLI_EFFORT="codex53_high"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    *)
      # claude-native 타입 중 위에 없는 경우는 보수적으로 유지
      CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
      return
      ;;
  esac

  echo "[tfx-route] TFX_NO_CLAUDE_NATIVE=1: $AGENT_TYPE -> codex($CLI_EFFORT) 리매핑" >&2
}

apply_verifier_override() {
  [[ "$AGENT_TYPE" != "verifier" ]] && return

  case "$TFX_VERIFIER_OVERRIDE" in
    auto|"")
      return 0
      ;;
    claude)
      ORIGINAL_AGENT="${ORIGINAL_AGENT:-$AGENT_TYPE}"
      CLI_TYPE="claude-native"
      CLI_CMD=""
      CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=1200; RUN_MODE="fg"; OPUS_OVERSIGHT="false"
      echo "[tfx-route] TFX_VERIFIER_OVERRIDE=claude: verifier -> claude-native" >&2
      ;;
  esac

  return 0
}

# ── MCP 인벤토리 캐시 ──
MCP_CACHE="${HOME}/.claude/cache/mcp-inventory.json"
MCP_FILTER_SCRIPT=""
MCP_PROFILE_REQUESTED="auto"
MCP_RESOLVED_PROFILE="default"
MCP_HINT=""
GEMINI_ALLOWED_SERVERS=()
CODEX_CONFIG_FLAGS=()
CODEX_CONFIG_JSON=""

get_cached_servers() {
  local cli_type="$1"
  if [[ -f "$MCP_CACHE" ]]; then
    node -e 'const[,f,t]=process.argv;const inv=JSON.parse(require("fs").readFileSync(f,"utf8"));const s=(inv[t]||{}).servers||[];console.log(s.filter(x=>x.status==="enabled"||x.status==="configured").map(x=>x.name).join(","))' -- "$MCP_CACHE" "$cli_type" 2>/dev/null
  fi
}

resolve_mcp_filter_script() {
  if [[ -n "$MCP_FILTER_SCRIPT" && -f "$MCP_FILTER_SCRIPT" ]]; then
    printf '%s\n' "$MCP_FILTER_SCRIPT"
    return 0
  fi

  local script_ref script_dir candidate
  local -a candidates=()

  script_ref="$(normalize_script_path "${BASH_SOURCE[0]}")"
  if [[ -n "$script_ref" ]]; then
    script_dir="$(cd "$(dirname "$script_ref")" 2>/dev/null && pwd -P || true)"
    [[ -n "$script_dir" ]] && candidates+=("$script_dir/lib/mcp-filter.mjs")
  fi

  candidates+=(
    "$PWD/scripts/lib/mcp-filter.mjs"
    "$PWD/lib/mcp-filter.mjs"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      MCP_FILTER_SCRIPT="$candidate"
      printf '%s\n' "$MCP_FILTER_SCRIPT"
      return 0
    fi
  done

  return 1
}

resolve_mcp_policy() {
  local filter_script available_servers
  if ! filter_script=$(resolve_mcp_filter_script); then
    echo "[tfx-route] 경고: mcp-filter.mjs를 찾지 못해 기본 MCP 정책을 사용합니다." >&2
    MCP_PROFILE_REQUESTED="$MCP_PROFILE"
    MCP_RESOLVED_PROFILE="$MCP_PROFILE"
    MCP_HINT=""
    GEMINI_ALLOWED_SERVERS=()
    CODEX_CONFIG_FLAGS=()
    CODEX_CONFIG_JSON=""
    return 0
  fi

  available_servers=$(get_cached_servers "$CLI_TYPE")
  if [[ "$CLI_TYPE" == "codex" && "${TFX_CODEX_TRANSPORT:-auto}" != "mcp" ]]; then
    available_servers=""
  fi
  # Codex 0.115+: 미등록 서버에 config override(enabled=true/false 모두)를 보내면
  # "invalid transport" 에러 발생. 캐시 비어있으면 빈 문자열로 유지하여
  # mcp-filter가 override를 생성하지 않도록 한다.
  [[ -z "$available_servers" ]] && available_servers=""

  local -a cmd=(
    "$NODE_BIN" "$filter_script" shell
    "--agent" "$AGENT_TYPE"
    "--profile" "$MCP_PROFILE"
    "--available" "$available_servers"
    "--inventory-file" "$MCP_CACHE"
    "--task-text" "$PROMPT"
  )
  [[ -n "$TFX_SEARCH_TOOL" ]] && cmd+=("--search-tool" "$TFX_SEARCH_TOOL")
  [[ -n "$TFX_WORKER_INDEX" ]] && cmd+=("--worker-index" "$TFX_WORKER_INDEX")

  local shell_exports
  if ! shell_exports="$("${cmd[@]}")"; then
    echo "[tfx-route] ERROR: MCP 정책 계산 실패" >&2
    return 1
  fi

  eval "$shell_exports"
}

get_claude_model() {
  case "$AGENT_TYPE" in
    explore) echo "haiku" ;;
    *) echo "sonnet" ;;
  esac
}

emit_claude_native_metadata() {
  local model
  model=$(get_claude_model)
  echo "ROUTE_TYPE=claude-native"
  echo "AGENT=$AGENT_TYPE"
  echo "MODEL=$model"
  echo "RUN_MODE=$RUN_MODE"
  echo "OPUS_OVERSIGHT=$OPUS_OVERSIGHT"
  echo "TIMEOUT=$TIMEOUT_SEC"
  echo "MCP_PROFILE=$MCP_PROFILE"
  [[ -n "$ORIGINAL_AGENT" ]] && echo "ORIGINAL_AGENT=$ORIGINAL_AGENT"
  echo "PROMPT=$PROMPT"
  echo "--- Claude Task($model) 에이전트로 위임하세요 ---"
}

# heartbeat_monitor PID [INTERVAL] [STALL_THRESHOLD]
# - PID: 감시할 워커 프로세스 PID
# - INTERVAL: heartbeat 출력 간격 (초, 기본 10)
# - STALL_THRESHOLD: stall 경고 임계값 (초, 기본 60)
# 환경변수: TFX_HEARTBEAT (0이면 비활성화), TFX_HEARTBEAT_INTERVAL, TFX_STALL_THRESHOLD
heartbeat_monitor() {
  [[ "${TFX_HEARTBEAT:-1}" -eq 0 ]] && return 0
  local pid="$1"
  local interval="${2:-${TFX_HEARTBEAT_INTERVAL:-10}}"
  local stall_threshold="${3:-${TFX_STALL_THRESHOLD:-60}}"
  local last_size=0 stall_count=0

  while kill -0 "$pid" 2>/dev/null; do
    sleep "$interval"
    local current_size=0
    [[ -f "$STDOUT_LOG" ]] && current_size=$(wc -c < "$STDOUT_LOG" 2>/dev/null || echo 0)
    # P3: stderr 활동도 포함하여 거짓 STALL 방지
    local stderr_size=0
    [[ -f "$STDERR_LOG" ]] && stderr_size=$(wc -c < "$STDERR_LOG" 2>/dev/null || echo 0)
    current_size=$((current_size + stderr_size))
    local elapsed=$(($(date +%s) - TIMESTAMP))

    if [[ "$current_size" -gt "$last_size" ]]; then
      stall_count=0
      echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B status=active" >&2
    else
      stall_count=$((stall_count + interval))
      if [[ "$stall_count" -ge "$stall_threshold" ]]; then
        echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B status=STALL stall=${stall_count}s" >&2
      else
        echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B status=quiet stall=${stall_count}s" >&2
      fi
    fi
    last_size=$current_size
  done
  echo "[tfx-heartbeat] pid=$pid terminated" >&2
}

resolve_worker_runner_script() {
  if [[ -n "${TFX_ROUTE_WORKER_RUNNER:-}" && -f "$TFX_ROUTE_WORKER_RUNNER" ]]; then
    printf '%s\n' "$TFX_ROUTE_WORKER_RUNNER"
    return 0
  fi

  local script_ref script_dir
  script_ref="$(normalize_script_path "${BASH_SOURCE[0]}")"
  script_dir="$(cd "$(dirname "$script_ref")" && pwd -P)"
  local candidate="$script_dir/tfx-route-worker.mjs"
  [[ -f "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

run_stream_worker() {
  local worker_type="$1"
  local prompt="$2"
  local use_tee_flag="$3"
  shift 3
  local exit_code_local=0
  local worker_pid hb_pid

  local runner_script
  if ! runner_script=$(resolve_worker_runner_script); then
    echo "[tfx-route] 경고: stream worker runner를 찾지 못했습니다." >&2
    return 127
  fi

  if ! command -v "$NODE_BIN" &>/dev/null; then
    echo "[tfx-route] 경고: node를 찾지 못해 stream worker를 실행할 수 없습니다." >&2
    return 127
  fi

  local -a worker_cmd=(
    "$NODE_BIN"
    "$runner_script"
    "--type" "$worker_type"
    "--timeout-ms" "$((TIMEOUT_SEC * 1000))"
    "--cwd" "$PWD"
    "$@"
  )

  if [[ "$use_tee_flag" == "true" ]]; then
    printf '%s' "$prompt" | "$TIMEOUT_BIN" "$TIMEOUT_SEC" "${worker_cmd[@]}" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    printf '%s' "$prompt" | "$TIMEOUT_BIN" "$TIMEOUT_SEC" "${worker_cmd[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  worker_pid=$!

  heartbeat_monitor "$worker_pid" &
  hb_pid=$!

  wait "$worker_pid" || exit_code_local=$?
  kill "$hb_pid" 2>/dev/null; wait "$hb_pid" 2>/dev/null
  return "$exit_code_local"
}

# Gemini 429 지수 백오프 재시도 래퍼
# 사용: gemini_with_retry <use_tee_flag> <gemini_args_array_name> <prompt>
# 429/rate limit 감지 시 최대 3회 재시도 (2→4→8초 백오프)
_gemini_run_once() {
  local use_tee_flag="$1"
  local prompt="$2"
  shift 2
  local -a g_args=("$@")

  if [[ "$use_tee_flag" == "true" ]]; then
    "$TIMEOUT_BIN" "$TIMEOUT_SEC" "$CLI_CMD" "${g_args[@]}" "$prompt" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    "$TIMEOUT_BIN" "$TIMEOUT_SEC" "$CLI_CMD" "${g_args[@]}" "$prompt" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  GEMINI_RUN_PID=$!
}

gemini_with_retry() {
  local use_tee_flag="$1"
  local prompt="$2"
  shift 2
  local -a g_args=("$@")

  local max_retries=3
  local attempt=0
  local delay=2
  local exit_code_local=0

  while (( attempt < max_retries )); do
    exit_code_local=0
    local pid
    _gemini_run_once "$use_tee_flag" "$prompt" "${g_args[@]}"
    pid="${GEMINI_RUN_PID:-}"
    if [[ -z "$pid" ]]; then
      echo "[tfx-route] Gemini: worker pid 획득 실패" >&2
      return 1
    fi

    local health_ok=true
    local intervals=(1 2 3 5 8)
    for wait_sec in "${intervals[@]}"; do
      sleep "$wait_sec"
      if [[ -s "$STDOUT_LOG" ]] || [[ -s "$STDERR_LOG" ]]; then
        break
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        health_ok=false
        echo "[tfx-route] Gemini: 출력 없이 프로세스 종료 (${wait_sec}초 체크)" >&2
        break
      fi
    done

    local hb_pid
    if [[ "$health_ok" == "false" ]]; then
      wait "$pid" 2>/dev/null
    else
      heartbeat_monitor "$pid" &
      hb_pid=$!
      wait "$pid" || exit_code_local=$?
      kill "$hb_pid" 2>/dev/null; wait "$hb_pid" 2>/dev/null
    fi

    # 성공 시 즉시 반환
    if [[ $exit_code_local -eq 0 ]]; then
      return 0
    fi

    # 429 / rate limit 감지
    if grep -qiE '429|rate.limit|too many requests' "$STDERR_LOG" 2>/dev/null; then
      attempt=$(( attempt + 1 ))
      if (( attempt < max_retries )); then
        echo "[tfx-route] Gemini 429 감지. ${delay}초 후 재시도 ($attempt/$max_retries)..." >&2
        kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        sleep "$delay"
        delay=$(( delay * 2 ))
        : > "$STDOUT_LOG"
        : > "$STDERR_LOG"
        continue
      else
        echo "[tfx-route] Gemini 429: ${max_retries}회 재시도 실패" >&2
      fi
    fi

    # 비-429 에러 또는 최대 재시도 초과 시 즉시 반환
    return "$exit_code_local"
  done

  return "$exit_code_local"
}

run_legacy_gemini() {
  local prompt="$1"
  local use_tee_flag="$2"
  local -a gemini_args=()
  read -r -a gemini_args <<< "$CLI_ARGS"

  if [[ ${#GEMINI_ALLOWED_SERVERS[@]} -gt 0 ]]; then
    local gemini_mcp_filter prompt_index=-1
    gemini_mcp_filter=$(IFS=,; echo "${GEMINI_ALLOWED_SERVERS[*]}")
    for i in "${!gemini_args[@]}"; do
      if [[ "${gemini_args[$i]}" == "--prompt" ]]; then
        prompt_index="$i"
        break
      fi
    done
    if [[ "$prompt_index" -ge 0 ]]; then
      gemini_args=(
        "${gemini_args[@]:0:$prompt_index}"
        "--allowed-mcp-server-names" "$gemini_mcp_filter"
        "${gemini_args[@]:$prompt_index}"
      )
      echo "[tfx-route] Gemini MCP 필터: $gemini_mcp_filter" >&2
    fi
  fi

  gemini_with_retry "$use_tee_flag" "$prompt" "${gemini_args[@]}"
}

resolve_codex_mcp_script() {
  if [[ -n "${TFX_CODEX_MCP_SCRIPT:-}" && -f "$TFX_CODEX_MCP_SCRIPT" ]]; then
    printf '%s\n' "$TFX_CODEX_MCP_SCRIPT"
    return 0
  fi

  local script_ref script_dir
  script_ref="$(normalize_script_path "${BASH_SOURCE[0]}")"
  script_dir="$(cd "$(dirname "$script_ref")" && pwd -P)"
  local candidates=()
  [[ -n "$TFX_PKG_ROOT" ]] && candidates+=("$TFX_PKG_ROOT/hub/workers/codex-mcp.mjs")
  candidates+=(
    "$script_dir/hub/workers/codex-mcp.mjs"
    "$script_dir/../hub/workers/codex-mcp.mjs"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

run_codex_exec() {
  local prompt="$1"
  local use_tee_flag="$2"
  local exit_code_local=0
  local worker_pid hb_pid
  local -a codex_args=()
  read -r -a codex_args <<< "$CLI_ARGS"
  if [[ ${#CODEX_CONFIG_FLAGS[@]} -gt 0 ]]; then
    codex_args+=("${CODEX_CONFIG_FLAGS[@]}")
  fi

  if [[ "$use_tee_flag" == "true" ]]; then
    "$TIMEOUT_BIN" "$TIMEOUT_SEC" "$CLI_CMD" "${codex_args[@]}" "$prompt" < /dev/null 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    "$TIMEOUT_BIN" "$TIMEOUT_SEC" "$CLI_CMD" "${codex_args[@]}" "$prompt" < /dev/null >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  worker_pid=$!

  heartbeat_monitor "$worker_pid" &
  hb_pid=$!

  wait "$worker_pid" || exit_code_local=$?
  kill "$hb_pid" 2>/dev/null; wait "$hb_pid" 2>/dev/null

  if [[ ! -s "$STDOUT_LOG" && -s "$STDERR_LOG" ]]; then
    # stderr에서 마지막 "codex" 마커 이후의 텍스트를 stdout으로 복구
    # 1차: "codex" 마커 기반 (Windows \r 제거 후 매칭)
    sed 's/\r$//' "$STDERR_LOG" \
      | awk '/^codex$/{found=NR;content=""} found && NR>found{content=content RS $0} END{if(content) print substr(content,2)}' \
      > "$STDOUT_LOG"

    # 2차: 마커 없을 때 node fallback (MCP/헤더/sandbox 로그 제외, 응답 부분만 추출)
    if [[ ! -s "$STDOUT_LOG" ]]; then
      node -e '
        const fs=require("fs"),lines=fs.readFileSync(process.argv[1],"utf-8").split(/\r?\n/);
        const skip=/^(mcp[: ]|OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|user$|tokens used|EXIT:|exec$|"[A-Z]:|succeeded in |\s*$)/;
        const out=lines.filter(l=>!skip.test(l));
        if(out.length) fs.writeFileSync(process.argv[2],out.join("\n"));
      ' -- "$STDERR_LOG" "$STDOUT_LOG" 2>/dev/null || true
    fi

    if [[ -s "$STDOUT_LOG" ]]; then
      echo "[tfx-route] 경고: codex stdout 비어있음, stderr에서 응답 복구 ($(wc -c < "$STDOUT_LOG" | tr -d ' ') bytes)" >&2
    else
      echo "[tfx-route] 경고: codex stdout 비어있음, stderr 복구도 실패" >&2
    fi
  fi

  return "$exit_code_local"
}

run_codex_mcp() {
  local prompt="$1"
  local use_tee_flag="$2"
  local mcp_script node_bin
  local exit_code_local=0
  local worker_pid hb_pid

  if ! mcp_script=$(resolve_codex_mcp_script); then
    echo "[tfx-route] 경고: Codex MCP 래퍼를 찾지 못했습니다." >&2
    return "$CODEX_MCP_TRANSPORT_EXIT_CODE"
  fi

  node_bin="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"
  if ! command -v "$node_bin" &>/dev/null; then
    echo "[tfx-route] 경고: node를 찾지 못해 Codex MCP 경로를 사용할 수 없습니다." >&2
    return "$CODEX_MCP_TRANSPORT_EXIT_CODE"
  fi

  local -a mcp_args=(
    "$mcp_script"
    "--prompt" "$prompt"
    "--cwd" "$PWD"
    "--profile" "$CLI_EFFORT"
    "--approval-policy" "never"
    "--sandbox" "danger-full-access"
    "--timeout-ms" "$((TIMEOUT_SEC * 1000))"
    "--codex-command" "$CODEX_BIN"
  )

  if [[ -n "$CODEX_CONFIG_JSON" && "$CODEX_CONFIG_JSON" != "{}" ]]; then
    mcp_args+=("--config-json" "$CODEX_CONFIG_JSON")
  fi

  case "$AGENT_TYPE" in
    code-reviewer)
      mcp_args+=(
        "--developer-instructions"
        "코드 리뷰 모드로 동작하라. 버그, 리스크, 회귀, 테스트 누락을 우선 식별하라."
      )
      ;;
    security-reviewer)
      mcp_args+=(
        "--developer-instructions"
        "보안 리뷰 모드로 동작하라. 취약점, 권한 경계, 비밀정보 노출 가능성을 우선 식별하라."
      )
      ;;
    quality-reviewer)
      mcp_args+=(
        "--developer-instructions"
        "품질 리뷰 모드로 동작하라. 로직 결함, 유지보수성 저하, 테스트 누락을 우선 식별하라."
      )
      ;;
  esac

  if [[ "$use_tee_flag" == "true" ]]; then
    "$TIMEOUT_BIN" "$TIMEOUT_SEC" "$node_bin" "${mcp_args[@]}" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    "$TIMEOUT_BIN" "$TIMEOUT_SEC" "$node_bin" "${mcp_args[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  worker_pid=$!

  heartbeat_monitor "$worker_pid" &
  hb_pid=$!

  wait "$worker_pid" || exit_code_local=$?
  kill "$hb_pid" 2>/dev/null; wait "$hb_pid" 2>/dev/null

  # 모듈 로드 실패(의존성 누락) → MCP transport exit code로 변환하여 fallback 트리거
  if [[ "$exit_code_local" -ne 0 && "$exit_code_local" -ne 124 ]] && grep -q 'ERR_MODULE_NOT_FOUND' "$STDERR_LOG" 2>/dev/null; then
    echo "[tfx-route] Codex MCP 모듈 로드 실패 — fallback 가능 exit code로 변환" >&2
    return "$CODEX_MCP_TRANSPORT_EXIT_CODE"
  fi

  return "$exit_code_local"
}

# ── 메인 실행 ──
main() {
  # 종료 시 per-process 에이전트 파일 자동 삭제
  trap 'deregister_agent' EXIT

  route_agent "$AGENT_TYPE"
  apply_cli_mode
  apply_no_claude_native_mode
  apply_plan_guard
  apply_verifier_override

  # CLI 경로 해석
  case "$CLI_CMD" in
    codex) CLI_CMD="$CODEX_BIN" ;;
    gemini) CLI_CMD="$GEMINI_BIN" ;;
    claude) CLI_CMD="$CLAUDE_BIN" ;;
  esac

  # 타임아웃 결정 (에이전트별 최소값 보장)
  local MIN_TIMEOUT
  case "$AGENT_TYPE" in
    deep-executor|architect|planner|critic|analyst) MIN_TIMEOUT=900 ;;
    document-specialist|scientist|scientist-deep) MIN_TIMEOUT=900 ;;
    code-reviewer|security-reviewer|quality-reviewer) MIN_TIMEOUT=600 ;;
    executor|debugger) MIN_TIMEOUT=300 ;;
    *) MIN_TIMEOUT=120 ;;
  esac

  if [[ -n "$USER_TIMEOUT" ]]; then
    if ! [[ "$USER_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
      echo "[tfx-route] 경고: 유효하지 않은 타임아웃 값 ($USER_TIMEOUT), 기본값 사용" >&2
      USER_TIMEOUT=""
      TIMEOUT_SEC="$DEFAULT_TIMEOUT"
    elif [[ "$USER_TIMEOUT" -lt "$MIN_TIMEOUT" ]]; then
      echo "[tfx-route] 경고: 타임아웃 ${USER_TIMEOUT}s < 최소 ${MIN_TIMEOUT}s ($AGENT_TYPE), 최소값 적용" >&2
      TIMEOUT_SEC="$MIN_TIMEOUT"
    else
      TIMEOUT_SEC="$USER_TIMEOUT"
    fi
  else
    TIMEOUT_SEC="$DEFAULT_TIMEOUT"
  fi

  # 컨텍스트 파일 → 프롬프트에 주입
  if [[ -n "$CONTEXT_FILE" && -f "$CONTEXT_FILE" ]]; then
    local ctx_content
    ctx_content=$(cat "$CONTEXT_FILE" 2>/dev/null | head -c 32768)  # 32KB 상한
    PROMPT="${PROMPT}

<prior_context>
${ctx_content}
</prior_context>"
  fi

  resolve_mcp_policy

  # Claude native는 팀 비-TTY 환경에서 subprocess wrapper를 우선 시도
  if [[ "$CLI_TYPE" == "claude-native" && -n "$TFX_TEAM_NAME" ]]; then
    if { [[ ! -t 0 ]] || [[ ! -t 1 ]]; } && command -v "$CLAUDE_BIN" &>/dev/null && resolve_worker_runner_script >/dev/null 2>&1; then
      CLI_TYPE="claude"
      CLI_CMD="$CLAUDE_BIN"
      echo "[tfx-route] non-tty 팀 환경: claude-native -> claude stream wrapper 전환" >&2
    else
      echo "[tfx-route] claude stream wrapper 미사용: native metadata 유지" >&2
    fi
  fi

  # Claude 네이티브 에이전트는 이 스크립트로 처리 불가
  if [[ "$CLI_TYPE" == "claude-native" ]]; then
    if [[ -n "$TFX_TEAM_NAME" ]]; then
      # 팀 모드: Hub에 fallback 필요 시그널 전송 후 구조화된 출력
      echo "[tfx-route] claude-native 역할($AGENT_TYPE)은 tfx-route.sh로 실행 불가 — Claude Agent fallback 필요" >&2
      team_complete_task "fallback" "claude-native 역할 실행 불가: ${AGENT_TYPE}. Claude Task(sonnet) 에이전트로 위임하세요."
      cat <<FALLBACK_EOF
=== TFX_NEEDS_FALLBACK ===
agent_type: ${AGENT_TYPE}
reason: claude-native roles require Claude Agent tools (Read/Edit/Grep). tfx-route.sh cannot provide these.
action: Lead should spawn Agent(subagent_type="${AGENT_TYPE}") for this task.
task_id: ${TFX_TEAM_TASK_ID:-none}
FALLBACK_EOF
      exit 0
    fi
    emit_claude_native_metadata
    exit 0
  fi

  local FULL_PROMPT="$PROMPT"
  [[ -n "$MCP_HINT" ]] && FULL_PROMPT="${PROMPT}. ${MCP_HINT}"
  local codex_transport_effective="n/a"

  # 메타정보 (stderr)
  echo "[tfx-route] v${VERSION} type=$CLI_TYPE agent=$AGENT_TYPE effort=$CLI_EFFORT mode=$RUN_MODE timeout=${TIMEOUT_SEC}s" >&2
  echo "[tfx-route] opus_oversight=$OPUS_OVERSIGHT mcp_profile=$MCP_PROFILE resolved_profile=$MCP_RESOLVED_PROFILE verifier_override=$TFX_VERIFIER_OVERRIDE" >&2
  if [[ ${#GEMINI_ALLOWED_SERVERS[@]} -gt 0 ]]; then
    echo "[tfx-route] allowed_mcp_servers=$(IFS=,; echo "${GEMINI_ALLOWED_SERVERS[*]}")" >&2
  else
    echo "[tfx-route] allowed_mcp_servers=none" >&2
  fi
  if [[ -n "$TFX_WORKER_INDEX" || -n "$TFX_SEARCH_TOOL" ]]; then
    echo "[tfx-route] worker_index=${TFX_WORKER_INDEX:-auto} search_tool=${TFX_SEARCH_TOOL:-auto}" >&2
  fi
  if [[ "$CLI_TYPE" == "codex" ]]; then
    echo "[tfx-route] codex_transport_request=$TFX_CODEX_TRANSPORT" >&2
  fi
  [[ -n "$TFX_TEAM_NAME" ]] && echo "[tfx-route] team=$TFX_TEAM_NAME task=$TFX_TEAM_TASK_ID agent=$TFX_TEAM_AGENT_NAME" >&2
  [[ -n "${TFX_REROUTED_FROM:-}" ]] && echo "[tfx-route] rerouted_from=$TFX_REROUTED_FROM" >&2

  # Per-process 에이전트 등록
  register_agent

  # 팀 모드: task claim
  team_claim_task
  team_send_message "작업 시작: ${TFX_TEAM_AGENT_NAME}" "task ${TFX_TEAM_TASK_ID} started"

  # CLI 실행 (stderr 분리 + 타임아웃 + 소요시간 측정)
  local exit_code=0
  local start_time
  start_time=$(date +%s)
  local workspace_signature_before=""
  local workspace_signature_after=""
  local workspace_probe_supported=false
  if workspace_signature_before=$(capture_workspace_signature); then
    workspace_probe_supported=true
  fi

  # tee 활성화 조건: 팀 모드 + 실제 터미널(TTY/tmux)
  # Agent 래퍼 안에서는 가상 stdout 캡처로 tee 출력이 사용자에게 안 보임 → 파일 전용
  # 실시간 모니터링은 Shift+Down으로 워커 pane 전환 권장
  local use_tee=false
  if [[ -n "$TFX_TEAM_NAME" ]]; then
    if [[ -t 1 ]] || [[ -n "${TMUX:-}" ]]; then
      use_tee=true
    fi
  fi

  if [[ "$CLI_TYPE" == "codex" ]]; then
    codex_transport_effective="exec"
    if [[ "$TFX_CODEX_TRANSPORT" != "exec" ]]; then
      run_codex_mcp "$FULL_PROMPT" "$use_tee" || exit_code=$?
      if [[ "$exit_code" -eq 0 ]]; then
        codex_transport_effective="mcp"
      elif [[ "$exit_code" -eq "$CODEX_MCP_TRANSPORT_EXIT_CODE" && "$TFX_CODEX_TRANSPORT" == "auto" ]]; then
        echo "[tfx-route] Codex MCP bootstrap 실패(exit=${exit_code}). legacy exec 경로로 fallback합니다." >&2
        : > "$STDOUT_LOG"
        : > "$STDERR_LOG"
        exit_code=0
        run_codex_exec "$FULL_PROMPT" "$use_tee" || exit_code=$?
        codex_transport_effective="exec-fallback"
      else
        codex_transport_effective="mcp"
      fi
    else
      run_codex_exec "$FULL_PROMPT" "$use_tee" || exit_code=$?
      codex_transport_effective="exec"
    fi
    echo "[tfx-route] codex_transport_effective=$codex_transport_effective" >&2

  elif [[ "$CLI_TYPE" == "gemini" ]]; then
    local gemini_model
    gemini_model=$(awk '{
      for (i = 1; i <= NF; i++) {
        if ($i == "-m" || $i == "--model") {
          print $(i + 1)
          exit
        }
      }
    }' <<< "$CLI_ARGS")
    local -a gemini_worker_args=(
      "--command" "$CLI_CMD"
      "--command-args-json" "$GEMINI_BIN_ARGS_JSON"
      "--model" "$gemini_model"
      "--approval-mode" "yolo"
    )

    if [[ ${#GEMINI_ALLOWED_SERVERS[@]} -gt 0 ]]; then
      echo "[tfx-route] Gemini MCP 서버: $(IFS=' '; echo "${GEMINI_ALLOWED_SERVERS[*]}")" >&2
      local server_name
      for server_name in "${GEMINI_ALLOWED_SERVERS[@]}"; do
        gemini_worker_args+=("--allowed-mcp-server-name" "$server_name")
      done
    fi

    run_stream_worker "gemini" "$FULL_PROMPT" "$use_tee" "${gemini_worker_args[@]}" || exit_code=$?
    if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
      echo "[tfx-route] Gemini stream wrapper 실패(exit=${exit_code}). legacy CLI 경로로 fallback합니다." >&2
      : > "$STDOUT_LOG"
      : > "$STDERR_LOG"
      exit_code=0
      run_legacy_gemini "$FULL_PROMPT" "$use_tee" || exit_code=$?
    fi

  elif [[ "$CLI_TYPE" == "claude" ]]; then
    local claude_model
    claude_model=$(get_claude_model)
    local -a claude_worker_args=(
      "--command" "$CLI_CMD"
      "--command-args-json" "$CLAUDE_BIN_ARGS_JSON"
      "--model" "$claude_model"
      "--permission-mode" "bypassPermissions"
      "--allow-dangerously-skip-permissions"
    )

    run_stream_worker "claude" "$FULL_PROMPT" "$use_tee" "${claude_worker_args[@]}" || exit_code=$?
    if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
      echo "[tfx-route] Claude stream wrapper 실패(exit=${exit_code}). native metadata로 fallback합니다." >&2
      cat > "$STDOUT_LOG" <<EOF
$(emit_claude_native_metadata)
EOF
      : > "$STDERR_LOG"
      exit_code=0
      CLI_TYPE="claude-native"
    fi
  fi

  local end_time
  end_time=$(date +%s)
  local elapsed=$((end_time - start_time))

  if [[ "$exit_code" -eq 0 ]]; then
    local workspace_changed="unknown"
    if [[ "$workspace_probe_supported" == "true" ]]; then
      if workspace_signature_after=$(capture_workspace_signature); then
        if [[ "$workspace_signature_before" != "$workspace_signature_after" ]]; then
          workspace_changed="yes"
        else
          workspace_changed="no"
        fi
      fi
    fi

    if [[ ! -s "$STDOUT_LOG" && "$workspace_changed" == "no" ]]; then
      printf '%s\n' "[tfx-route] exit 0 이지만 stdout 비어있고 워크스페이스 변화가 없습니다. no-op 성공을 실패로 승격합니다." >> "$STDERR_LOG"
      exit_code=68
    fi
  fi

  # 쿼타 감지 + 자동 re-route
  if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
    if [[ "${TFX_QUOTA_REROUTE:-1}" -ne 0 ]] && [[ -z "${TFX_REROUTED_FROM:-}" ]] && detect_quota_exceeded "$STDOUT_LOG" "$STDERR_LOG"; then
      export TFX_REROUTED_FROM="$CLI_TYPE"
      auto_reroute "$CLI_TYPE"
    fi
  fi

  # 팀 모드: task complete + 리드 보고
  if [[ -n "$TFX_TEAM_NAME" ]]; then
    if [[ "$exit_code" -eq 0 ]]; then
      local output_preview
      output_preview=$(head -c 2048 "$STDOUT_LOG" 2>/dev/null || echo "출력 없음")
      team_complete_task "success" "$output_preview"
    elif [[ "$exit_code" -eq 124 ]]; then
      team_complete_task "timeout" "타임아웃 (${TIMEOUT_SEC}초)"
    else
      local err_preview
      err_preview=$(tail -c 1024 "$STDERR_LOG" 2>/dev/null || echo "에러 정보 없음")
      team_complete_task "failed" "exit_code=${exit_code}: ${err_preview}"
    fi
  fi

  # ── 후처리: 단일 node 프로세스로 위임 ──
  # 토큰 추출, 출력 필터링, 로그, 토큰 누적, AIMD, 이슈 추적, 결과 출력 전부 처리
  local post_script="${HOME}/.claude/scripts/tfx-route-post.mjs"
  if [[ -f "$post_script" ]]; then
    node "$post_script" \
      --agent "$AGENT_TYPE" \
      --cli "$CLI_TYPE" \
      --cli-cmd "$CLI_CMD" \
      --effort "$CLI_EFFORT" \
      --run-mode "$RUN_MODE" \
      --opus "$OPUS_OVERSIGHT" \
      --exit-code "$exit_code" \
      --elapsed "$elapsed" \
      --timeout "$TIMEOUT_SEC" \
      --mcp-profile "$MCP_PROFILE" \
      --stderr-log "$STDERR_LOG" \
      --stdout-log "$STDOUT_LOG" \
      --rerouted-from "${TFX_REROUTED_FROM:-}" \
      --max-bytes "$MAX_STDOUT_BYTES" \
      --tee-active "$use_tee" \
      --clean-tui "${TFX_CLEAN_TUI:-true}"
  else
    # post.mjs 없으면 기본 출력 (fallback)
    echo "=== TFX-ROUTE RESULT ==="
    echo "agent: $AGENT_TYPE"
    echo "cli: $CLI_TYPE"
    [[ -n "${TFX_REROUTED_FROM:-}" ]] && echo "rerouted_from: $TFX_REROUTED_FROM"
    echo "exit_code: $exit_code"
    echo "elapsed: ${elapsed}s"
    echo "status: $([ $exit_code -eq 0 ] && echo success || echo failed)"
    echo "=== OUTPUT ==="
    if [[ "${TFX_CLEAN_TUI:-1}" != "0" ]]; then
      cat "$STDOUT_LOG" 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
        | sed '/^[[:space:]]*[╭╮╰╯│─┌┐└┘├┤┬┴┼]/d' \
        | sed '/^[[:space:]]*[›❯][[:space:]]*$/d' \
        | head -c "$MAX_STDOUT_BYTES"
    else
      cat "$STDOUT_LOG" 2>/dev/null | head -c "$MAX_STDOUT_BYTES"
    fi
  fi

  # 결과를 파일에도 저장 — run_in_background에서 TaskOutput이 stdout을 놓칠 때 대비
  local result_file="${TFX_TMP}/tfx-route-${AGENT_TYPE}-${RUN_ID}-result.log"
  {
    echo "agent: $AGENT_TYPE"
    echo "cli: $CLI_TYPE"
    echo "exit_code: $exit_code"
    echo "elapsed: ${elapsed}s"
    echo "status: $([ $exit_code -eq 0 ] && echo success || echo failed)"
    echo "stdout_log: $STDOUT_LOG"
    echo "result_file: $result_file"
  } > "$result_file" 2>/dev/null
  echo "[tfx-route] result_file=$result_file" >&2

  return "$exit_code"
}

# ── Async 모드: 백그라운드 실행 + 즉시 job_id 반환 ──
if [[ "$TFX_ASYNC_MODE" -eq 1 ]]; then
  mkdir -p "$TFX_JOBS_DIR"
  JOB_ID="$TIMESTAMP-$$-${RANDOM}"
  JOB_DIR="$TFX_JOBS_DIR/$JOB_ID"
  mkdir -p "$JOB_DIR"
  echo "$AGENT_TYPE" > "$JOB_DIR/agent_type"
  date +%s > "$JOB_DIR/start_time"

  # 백그라운드 서브쉘: main 실행 → 결과 저장
  echo "starting" > "$JOB_DIR/pid"
  (
    set +e  # main 내부 에러가 exit_code 기록 전에 서브쉘을 죽이는 것 방지
    exec > "$JOB_DIR/result.log" 2>"$JOB_DIR/stderr.log"
    main; _ec=$?
    echo "$_ec" > "$JOB_DIR/exit_code"
    touch "$JOB_DIR/done"
  ) &
  bg_pid=$!
  echo "$bg_pid" > "$JOB_DIR/pid"

  # 종료 감지 데몬 (main이 signal/crash로 죽어도 done 마커 생성)
  (
    wait "$bg_pid" 2>/dev/null
    ec=$?
    if [[ ! -f "$JOB_DIR/done" ]]; then
      echo "$ec" > "$JOB_DIR/exit_code"
      touch "$JOB_DIR/done"
    fi
  ) &
  disown

  # 즉시 리턴: 1초 이내에 Claude Code Bash 도구 완료
  echo "$JOB_ID"
  exit 0
fi

main
