#!/usr/bin/env bash
# tfx-route.sh v2.7 — CLI 라우팅 래퍼 (triflux)
#
# v1.x: cli-route.sh (jq+python3+node 혼재, 동기 후처리 ~1s)
# v2.0: tfx-route.sh 리네임
#   - 후처리 전부 tfx-route-post.mjs로 이관 (node 단일 ~100ms)
#   - per-process 에이전트 등록 (race condition 구조적 제거)
#   - get_mcp_hint 통합 (캐시/비캐시 단일 코드경로)
#   - Gemini health check 지수 백오프 (30×1s → 5×exp)
#   - 컨텍스트 파일 5번째 인자 지원
#
VERSION="2.7"
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

# ── Phase 0 PoC: Node single-entry gateway ──
# TFX_ROUTE_NODE=1 일 때 scripts/tfx-route.mjs 로 exec. Node 진입점이 다시 이 스크립트를
# 호출할 때는 TFX_ROUTE_NODE_BYPASS=1 을 세팅해 무한 루프를 방지한다.
# PRD: .triflux/plans/node-cli-single-entry-migration.md (Phase 0).
if [ "${TFX_ROUTE_NODE:-0}" = "1" ] && [ "${TFX_ROUTE_NODE_BYPASS:-0}" != "1" ]; then
  exec node "$(dirname "$0")/tfx-route.mjs" "$@"
fi

set -euo pipefail

# ── 영속 machine profile (env > profile > runtime observation) ──
# 신뢰 경계: 파일을 source/eval 하지 않고 allowlist literal만 읽는다.
resolve_machine_profile_path() {
  if [[ -n "${TFX_MACHINE_PROFILE_PATH:-}" ]]; then
    printf '%s\n' "$TFX_MACHINE_PROFILE_PATH"
    return 0
  fi
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*)
      local appdata_path="${APPDATA:-${HOME}/AppData/Roaming}"
      if command -v cygpath >/dev/null 2>&1; then
        appdata_path="$(cygpath -u "$appdata_path" 2>/dev/null || printf '%s' "$appdata_path")"
      else
        appdata_path="${appdata_path//\\//}"
      fi
      printf '%s/triflux/machine-profile.env\n' "${appdata_path%/}"
      ;;
    *)
      printf '%s/triflux/machine-profile.env\n' "${XDG_CONFIG_HOME:-${HOME}/.config}"
      ;;
  esac
}

load_machine_profile() {
  local profile_path line key value
  profile_path="$(resolve_machine_profile_path)"
  [[ -r "$profile_path" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      echo "[tfx-route] machine profile 형식 무시: KEY=VALUE 아님" >&2
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ -z "$value" || "$value" == *[!A-Za-z0-9_.-]* ]]; then
      echo "[tfx-route] machine profile ${key} 값 무시: 안전한 literal 아님" >&2
      continue
    fi
    case "$key" in
      TFX_MACHINE_PROFILE_VERSION)
        [[ -n "${TFX_MACHINE_PROFILE_VERSION+x}" ]] || TFX_MACHINE_PROFILE_VERSION="$value" ;;
      TFX_MACHINE_OS)
        [[ -n "${TFX_MACHINE_OS+x}" ]] || TFX_MACHINE_OS="$value" ;;
      TFX_MULTIPLEXER_POLICY)
        [[ -n "${TFX_MULTIPLEXER_POLICY+x}" ]] || TFX_MULTIPLEXER_POLICY="$value" ;;
      TFX_DISABLE_CODEX)
        [[ -n "${TFX_DISABLE_CODEX+x}" ]] || TFX_DISABLE_CODEX="$value" ;;
      TFX_DISABLE_ANTIGRAVITY)
        [[ -n "${TFX_DISABLE_ANTIGRAVITY+x}" ]] || TFX_DISABLE_ANTIGRAVITY="$value" ;;
      TFX_TIMEOUT_POLICY)
        [[ -n "${TFX_TIMEOUT_POLICY+x}" ]] || TFX_TIMEOUT_POLICY="$value" ;;
      TFX_HARD_CEILING_SEC)
        [[ -n "${TFX_HARD_CEILING_SEC+x}" ]] || TFX_HARD_CEILING_SEC="$value" ;;
      TFX_STALL_THRESHOLD)
        [[ -n "${TFX_STALL_THRESHOLD+x}" ]] || TFX_STALL_THRESHOLD="$value" ;;
      TFX_STALL_KILL)
        [[ -n "${TFX_STALL_KILL+x}" ]] || TFX_STALL_KILL="$value" ;;
      *)
        echo "[tfx-route] machine profile key 무시: $key" >&2 ;;
    esac
  done < "$profile_path"
}

load_machine_profile

# 첫 인자(초)를 버리고 명령을 그대로 실행한다. timeout binary 부재 또는 명시적
# TFX_HARD_CEILING_SEC=0에서 사용한다.
_no_timeout() { shift; "$@"; }

# ── timeout 명령 호환성 — Windows에서 TIMEOUT.exe 대신 Git Bash coreutils timeout 사용 ──
if command -v /usr/bin/timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="/usr/bin/timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"  # macOS homebrew coreutils
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"   # Linux 기본
else
  if [[ "${TFX_HARD_CEILING_SEC:-21600}" != "0" ]]; then
    echo "[tfx-route] WARNING: timeout 명령을 찾을 수 없습니다 — TFX_HARD_CEILING_SEC 최후 방어선(기본 6h)이 비활성화됩니다. hung 워커 방어는 heartbeat stall kill 뿐입니다. macOS: brew install coreutils (gtimeout 제공)" >&2
  fi
  TIMEOUT_BIN="_no_timeout"
fi

# 활동 기반 수명주기: wall-clock timeout은 hard ceiling에서만 집행한다.
# coreutils timeout -k는 SIGTERM을 무시하는 프로세스를 5초 후 SIGKILL한다.
if [[ "$TIMEOUT_BIN" == "_no_timeout" ]]; then
  TIMEOUT_CMD=("_no_timeout")
else
  TIMEOUT_CMD=("$TIMEOUT_BIN" "-k" "${TFX_HARD_CEILING_KILL_GRACE:-5}")
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

# ── Worker PID 추적 (EXIT trap에서 정리) ──
_PID_TRACK="${TFX_TMP}/tfx-route-$$-pids"

track_worker_pid() {
  echo "$1" >> "$_PID_TRACK"
}

cleanup_workers() {
  _codex_config_swap "restore" 2>/dev/null || true
  deregister_agent 2>/dev/null || true
  [[ ! -f "$_PID_TRACK" ]] && return
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill -0 "$pid" 2>/dev/null || continue
    case "$(uname -s)" in
      MINGW*|MSYS*)
        # Windows: taskkill /T /F로 프로세스 트리 전체 종료
        MSYS_NO_PATHCONV=1 cmd.exe //c "taskkill /T /F /PID $pid" 2>/dev/null || true ;;
      *)
        # Unix: 프로세스 그룹 kill
        local pgid
        pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [[ -n "$pgid" && "$pgid" != "0" ]]; then
          kill -- "-$pgid" 2>/dev/null || true
        else
          kill "$pid" 2>/dev/null || true
        fi ;;
    esac
  done < "$_PID_TRACK"
  rm -f "$_PID_TRACK"
}

# ── Preflight env vars (P0 prompt-dodge): git/npm/gh 자동 응답 ──
# 워커가 dispatch 직후 git credential / npm install / gh auth prompt에서
# stall하지 않도록 환경변수를 선주입한다. 사용자 값이 있으면 존중.
export GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-0}"
export GIT_ASKPASS="${GIT_ASKPASS:-false}"
export npm_config_yes="${npm_config_yes:-true}"

_preflight_check_gh_auth() {
  command -v gh >/dev/null 2>&1 || return 0
  [[ -n "${GH_TOKEN:-}" || -n "${GITHUB_TOKEN:-}" ]] && return 0
  if ! gh auth status >/dev/null 2>&1; then
    echo "[tfx-route] 경고: gh 인증 미설정 (GH_TOKEN/GITHUB_TOKEN 미설정 + 'gh auth status' 실패). gh 명령 실행 시 prompt 발생 가능" >&2
  fi
}
_preflight_check_gh_auth

# ── config.toml sandbox/approval_mode 감지 ──
# config.toml에 이미 설정되어 있으면 CLI 플래그 중복 시 Codex가 에러를 던짐.
# 단, [mcp_servers.*.tools.*] 섹션 내부의 approval_mode는 tool 단위 승인 설정으로
# top-level sandbox/approval_mode와 의미가 다르다. 이 값이 "approve"이면
# codex exec이 non-TTY subprocess에서 승인 대기로 stall하므로 감지 대상에서 제외.
# (refs: tellang/triflux#66, Yeachan-Heo/oh-my-codex#1478)
# TFX_CODEX_CONFIG override: integration tests that run the full route script
# point this at an isolated tmpdir config so the MCP config-swap never mutates
# the real ~/.codex/config.toml (non-hermetic corruption guard). Defaults to the
# real path for normal runs.
_CODEX_CONFIG="${TFX_CODEX_CONFIG:-${HOME}/.codex/config.toml}"

_sanitize_codex_legacy_profiles() {
  local config="${1:-$_CODEX_CONFIG}"
  [[ -f "$config" ]] || return 0
  if ! grep -Eq '^[[:space:]]*profile[[:space:]]*=|^[[:space:]]*\[profiles\.' "$config" 2>/dev/null; then
    return 0
  fi
  local route_dir node_bin sanitizer
  route_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  sanitizer="${route_dir}/codex-profile-sanitize.mjs"
  [[ -f "$sanitizer" ]] || {
    echo "[tfx-route] 경고: Codex profile sanitizer 없음: $sanitizer" >&2
    return 0
  }
  node_bin="${NODE_BIN:-$(command -v node 2>/dev/null || command -v node.exe 2>/dev/null || echo node)}"
  if "$node_bin" "$sanitizer" "$config" --quiet; then
    echo "[tfx-route] Codex legacy inline profiles sanitized before exec" >&2
  else
    echo "[tfx-route] 경고: Codex legacy profile sanitizer 실패 — --profile 실행이 실패할 수 있음" >&2
  fi
}

_sanitize_codex_legacy_profiles "$_CODEX_CONFIG"

_CODEX_HAS_SANDBOX=""
if [[ -f "$_CODEX_CONFIG" ]] && awk '
  /^\[{1,2}mcp_servers\..*\.tools\./ { in_mcp_tool=1; next }
  /^\[/ { in_mcp_tool=0; next }
  !in_mcp_tool && /^[[:space:]]*(sandbox|approval_mode)[[:space:]]*=/ { found=1; exit }
  END { exit !found }
' "$_CODEX_CONFIG" 2>/dev/null; then
  _CODEX_HAS_SANDBOX="1"
fi

# ── MCP tool approval_mode stall 방지 (ISSUE-4) ──
# oh-my-codex 업데이트가 MCP tool 블록의 approval_mode를 "approve"로 복원함.
# codex exec는 non-TTY subprocess이므로 interactive 승인 대기 = output 0B stall.
# 실행 전 자동으로 "full-auto"로 교체한다.
if [[ -f "$_CODEX_CONFIG" ]] && grep -q 'approval_mode = "approve"' "$_CODEX_CONFIG" 2>/dev/null; then
  _approve_count=$(grep -c 'approval_mode = "approve"' "$_CODEX_CONFIG" 2>/dev/null || echo 0)
  if [[ "$_approve_count" -gt 0 ]]; then
    cp "$_CODEX_CONFIG" "${_CODEX_CONFIG}.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
    sed -i 's/approval_mode = "approve"/approval_mode = "full-auto"/g' "$_CODEX_CONFIG"
    echo "[tfx-route] MCP tool approval_mode stall 방지: ${_approve_count}개 블록 approve→full-auto 자동 수정" >&2
  fi
fi

build_codex_base() {
  # codex exec는 항상 non-TTY subprocess에서 실행되므로 --dangerously-bypass 필수.
  # --dangerously-bypass는 config.toml의 approval_mode/sandbox와 충돌하지 않음
  # (--full-auto와 달리 bypass는 config 값을 override할 뿐 에러를 던지지 않음).
  # 검증: approval_mode="auto" config에서 --dangerously-bypass 동시 사용 → exit 0 확인.
  #
  # Note: 위의 _CODEX_HAS_SANDBOX awk 감지는 현재 미사용이지만, 향후 codex가
  # bypass와 config.toml 충돌을 감지하면 분기 로직을 재활성화할 수 있으므로 유지.
  echo "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"
}

# ── Async Job 디렉토리 ──
# Honor caller-provided TFX_JOBS_DIR env (used by unit tests for isolated jobs dirs).
TFX_JOBS_DIR="${TFX_JOBS_DIR:-${TFX_TMP}/tfx-jobs}"

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
    elif [[ -s "$job_dir/child_pids" ]]; then
      # wrapper 죽었지만 codex child 가 살아남았으면 orphan-running 으로 분류 (Issue #176).
      while IFS= read -r child; do
        if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
          echo "orphan-running pid=$child"
          exit 0
        fi
      done < "$job_dir/child_pids"
      echo "failed"
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

# ── --async-self-test: 단위 테스트 전용 inert surface (CLI dispatch 우회) ──
# Inert self-test surface for unit tests. Bypasses CLI dispatch, exercises wrapper only.
if [[ "${1:-}" == "--async-self-test" ]]; then
  shift
  case "${1:-}" in
    wrapper-sleep-3)
      mkdir -p "$TFX_JOBS_DIR"
      JOB_ID="selftest-$$-$RANDOM"
      JOB_DIR="$TFX_JOBS_DIR/$JOB_ID"
      mkdir -p "$JOB_DIR"
      # Mirrors the wrapper pattern used by production --async (see Task E).
      ( set +e
        trap 'rc=$?; echo "$rc" > "$JOB_DIR/exit_code"; touch "$JOB_DIR/done"; exit "$rc"' INT TERM HUP
        exec > "$JOB_DIR/result.log" 2>"$JOB_DIR/stderr.log"
        sleep 3
        _ec=$?
        echo "$_ec" > "$JOB_DIR/exit_code"
        touch "$JOB_DIR/done"
        exit "$_ec"
      ) &
      bg_pid=$!
      echo "$bg_pid" > "$JOB_DIR/pid"
      disown "$bg_pid"
      echo "$JOB_ID"
      exit 0
      ;;
    main-overwrites-exit-trap)
      mkdir -p "$TFX_JOBS_DIR"
      JOB_ID="selftest-main-$$-$RANDOM"
      JOB_DIR="$TFX_JOBS_DIR/$JOB_ID"
      mkdir -p "$JOB_DIR"
      ( set +e
        selftest_main_overwrites_exit_trap() {
          trap 'echo selftest-cleanup' EXIT
          return 0
        }
        trap 'rc=$?; echo "$rc" > "$JOB_DIR/exit_code"; touch "$JOB_DIR/done"; exit "$rc"' INT TERM HUP
        exec > "$JOB_DIR/result.log" 2>"$JOB_DIR/stderr.log"
        selftest_main_overwrites_exit_trap
        _ec=$?
        echo "$_ec" > "$JOB_DIR/exit_code"
        touch "$JOB_DIR/done"
        exit "$_ec"
      ) &
      bg_pid=$!
      echo "$bg_pid" > "$JOB_DIR/pid"
      disown "$bg_pid"
      echo "$JOB_ID"
      exit 0
      ;;
    *)
      echo "[tfx-route] unknown async-self-test target: ${1:-<empty>}" >&2
      exit 2
      ;;
  esac
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

case "$AGENT_TYPE" in
  multi|team|codex-team)
    echo "ERROR: '$AGENT_TYPE' is a tfx CLI subcommand, not a tfx-route agent." >&2
    echo "Use: tfx multi ... for team/headless dispatch." >&2
    echo "macOS/Linux headless uses tmux; Windows uses psmux." >&2
    exit 64
    ;;
esac

# ── CLI 이름은 route_agent()에서 기본 역할 alias로 처리됨 (codex→executor, antigravity/agy→Antigravity, claude→explore) ──

# ── 인자 검증: MCP_PROFILE이 --flag 형태인 경우 거절 ──
if [[ "$MCP_PROFILE" == --* ]]; then
  echo "ERROR: MCP 프로필 위치(3번째 인자)에 플래그 '$MCP_PROFILE'가 들어왔습니다." >&2
  echo "사용법: tfx-route.sh <역할> \"프롬프트\" [mcp_profile] [timeout]" >&2
  echo "지원 프로필: auto, executor, analyze, implement, review, minimal, full" >&2
  exit 64
fi

# ── CLI 경로 해석 (Windows npm global 대응) ──
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || command -v node.exe 2>/dev/null || echo node)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || echo codex)}"
GEMINI_BIN="${GEMINI_BIN:-$(command -v gemini 2>/dev/null || echo gemini)}"
AGY_BIN="${AGY_BIN:-$(command -v agy 2>/dev/null || echo agy)}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo claude)}"
GEMINI_BIN_ARGS_JSON="${GEMINI_BIN_ARGS_JSON:-[]}"
# ── Gemini 확장 플래그 (issue #64) ──
TFX_GEMINI_EXTENSIONS="${TFX_GEMINI_EXTENSIONS:-}"
TFX_GEMINI_FLAGS="${TFX_GEMINI_FLAGS:-}"
CLAUDE_BIN_ARGS_JSON="${CLAUDE_BIN_ARGS_JSON:-[]}"

# ── Codex auth/home 명시 라우팅 (Issue #78 race 차단) ──
# TFX_CODEX_HOME 또는 TFX_CODEX_AUTH_FILE 설정 시 codex CLI에 명시적 CODEX_HOME 적용.
# AccountBroker 가 disable 되었거나 (TFX_DISABLE_ACCOUNT_BROKER=1) 호출자가
# 단일 account 를 강제 라우팅하고 싶을 때 사용. 미설정 시 codex default (~/.codex) 유지.
if [[ -n "${TFX_CODEX_HOME:-}" ]]; then
  export CODEX_HOME="$TFX_CODEX_HOME"
elif [[ -n "${TFX_CODEX_AUTH_FILE:-}" && -f "${TFX_CODEX_AUTH_FILE}" ]]; then
  # auth.json 파일 경로만 받으면 그 디렉토리를 CODEX_HOME 으로 사용
  _tfx_codex_auth_dir="$(dirname "$TFX_CODEX_AUTH_FILE")"
  if [[ -f "$_tfx_codex_auth_dir/auth.json" ]]; then
    export CODEX_HOME="$_tfx_codex_auth_dir"
  fi
  unset _tfx_codex_auth_dir
fi

# ── Gemini 프로필 경로 (Codex config.toml 대칭) ──
GEMINI_PROFILES_PATH="${GEMINI_PROFILES_PATH:-${HOME}/.gemini/triflux-profiles.json}"

# ── 상수 ──
MAX_STDOUT_BYTES=51200  # 50KB — Claude 컨텍스트 절약
TIMESTAMP=$(date +%s)
TFX_PROBE_DIR="${TFX_PROBE_DIR:-${TFX_TMP}/tfx-probe}"
mkdir -p "$TFX_PROBE_DIR" 2>/dev/null || true

estimate_expected_duration_sec() {
  local agent="${1:-}" profile="${2:-}" prompt="${3:-}"
  local text
  text=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')
  local expected=30

  case "$agent" in
    explore|style-reviewer) expected=30 ;;
    writer|verifier|qa-tester) expected=90 ;;
    executor|debugger|test-engineer) expected=300 ;;
    code-reviewer|security-reviewer|architect|planner|critic|analyst) expected=600 ;;
    scientist|scientist-deep|deep-executor|document-specialist) expected=900 ;;
  esac

  case "$profile" in
    minimal|default) [[ "$expected" -lt 60 ]] && expected=60 ;;
    analyze|review|full) [[ "$expected" -lt 300 ]] && expected=300 ;;
    implement|executor) [[ "$expected" -lt 300 ]] && expected=300 ;;
  esac

  if [[ "$text" =~ (deep|research|analy[sz]e|분석|리서치|조사|전체|전부|싹다|comprehensive) ]]; then
    [[ "$expected" -lt 600 ]] && expected=600
  fi
  if [[ "$text" =~ (refactor|migration|migrate|리팩터|마이그레이션|대규모|rewrite) ]]; then
    [[ "$expected" -lt 900 ]] && expected=900
  fi
  if [[ "$text" =~ (test|lint|build|npm|pnpm|pytest|검증|테스트) ]]; then
    [[ "$expected" -lt 180 ]] && expected=180
  fi
  if [[ "$text" =~ (mcp|browser|playwright|context7|exa|tavily|brave) ]]; then
    [[ "$expected" -lt 120 ]] && expected=120
  fi

  printf '%s\n' "$expected"
}

prepend_codex_north_star() {
  local prompt="${1:-}"
  local workdir="${WORKDIR:-$PWD}"
  local resolved_workdir="$workdir"
  if [[ -d "$workdir" ]]; then
    resolved_workdir="$(cd "$workdir" 2>/dev/null && pwd -P)" || resolved_workdir="$workdir"
  fi
  local brief_file="${workdir}/.triflux/lake/current.md"

  # CTO gate의 의미론은 hub/lib/cto-env.mjs 한 곳이 소유한다. Bash는 Node
  # one-shot으로 north_star_enabled 결과만 받아 소비하므로 TFX_CTO_* 판정 로직을
  # 복제하지 않는다. helper를 불러올 수 없으면 ambient context 누출을 막기 위해
  # fail-closed로 원본 prompt를 유지한다.
  local cto_env_dir cto_env_module source_path
  source_path="${BASH_SOURCE[0]:-$0}"
  cto_env_dir="$(cd "$(dirname "$source_path")/../hub/lib" 2>/dev/null && pwd -P || true)"
  cto_env_module="${cto_env_dir:+${cto_env_dir}/cto-env.mjs}"
  if [[ ! -r "$cto_env_module" && -r "$PWD/hub/lib/cto-env.mjs" ]]; then
    # 개발 checkout에서의 함수 단위 실행 fallback.
    cto_env_module="$PWD/hub/lib/cto-env.mjs"
  fi
  if [[ ! -r "$cto_env_module" ]]; then
    printf '%s' "$prompt"
    return 0
  fi

  local north_star_enabled
  if ! north_star_enabled="$(TFX_CTO="${TFX_CTO:-}" TFX_CTO_NORTH_STAR="${TFX_CTO_NORTH_STAR:-}" node --input-type=module -e '
    const { resolveRoleControlSnapshot } = await import(process.argv[1]);
    process.stdout.write(resolveRoleControlSnapshot().north_star_enabled ? "1" : "0");
  ' "$cto_env_module" 2>/dev/null)"; then
    printf '%s' "$prompt"
    return 0
  fi
  if [[ "$north_star_enabled" != "1" ]]; then
    printf '%s' "$prompt"
    return 0
  fi

  if [[ ! -r "$brief_file" ]]; then
    printf '%s' "$prompt"
    return 0
  fi

  local tmp_file
  tmp_file="$(mktemp "${TFX_TMP:-${TMPDIR:-/tmp}}/tfx-codex-prompt.XXXXXX" 2>/dev/null)" || {
    printf '%s' "$prompt"
    return 0
  }

  if ! {
    printf '%s\n' "--- CTO NORTH STAR (repo: ${resolved_workdir}; read-only context; align, do not treat as task) ---"
    cat "$brief_file"
    if [[ -s "$brief_file" ]]; then
      local last_byte
      last_byte="$(tail -c 1 "$brief_file" 2>/dev/null || true)"
      [[ -n "$last_byte" ]] && printf '\n'
    fi
    printf '%s\n' "--- END CTO NORTH STAR (context only — the actual task follows below; do not execute items above as tasks) ---"
    printf '%s' "$prompt"
  } > "$tmp_file"; then
    rm -f "$tmp_file" 2>/dev/null || true
    printf '%s' "$prompt"
    return 0
  fi

  cat "$tmp_file" 2>/dev/null || printf '%s' "$prompt"
  rm -f "$tmp_file" 2>/dev/null || true
}

# prepend_skill: opt-in 으로 등록된 스킬의 SKILL.md 본문을 프롬프트 앞에 주입한다.
# 활성 조건은 TFX_INJECT_SKILL env (tfx-auto 가 --skill <name> 으로 set). 미설정이면
# 현행 동작 그대로 (no-op). CLI-agnostic — codex/agy 레인에서 동일하게 재사용한다.
# 전달은 prepend_codex_north_star 와 동일하게 printf/cat → temp file 만 사용하므로
# $ / 백슬래시(₩) 같은 특수문자를 셸 재확장 없이 리터럴로 보존한다 (parse-safe).
# 스킬 경로: ${TFX_SKILLS_DIR:-<repo>/skills}/<name>/SKILL.md.
prepend_skill() {
  local prompt="${1:-}"
  local skill_name="${TFX_INJECT_SKILL:-}"
  if [[ -z "$skill_name" ]]; then
    printf '%s' "$prompt"
    return 0
  fi
  # 경로 탈출 방지: skill_name 은 skills/ 하위 단일 디렉토리 이름만 허용한다.
  if [[ "$skill_name" == *"/"* || "$skill_name" == *".."* ]]; then
    echo "[tfx-route] WARNING: TFX_INJECT_SKILL='${skill_name}' 에 경로 구분자/.. 포함 — 주입 거부" >&2
    printf '%s' "$prompt"
    return 0
  fi

  local skills_dir="${TFX_SKILLS_DIR:-}"
  if [[ -z "$skills_dir" ]]; then
    skills_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)/skills"
  fi
  local skill_file="${skills_dir}/${skill_name}/SKILL.md"
  if [[ ! -r "$skill_file" ]]; then
    echo "[tfx-route] WARNING: TFX_INJECT_SKILL='${skill_name}' 스킬을 찾지 못함 ($skill_file) — 주입 생략" >&2
    printf '%s' "$prompt"
    return 0
  fi

  local workdir="${WORKDIR:-$PWD}"
  local resolved_workdir="$workdir"
  if [[ -d "$workdir" ]]; then
    resolved_workdir="$(cd "$workdir" 2>/dev/null && pwd -P)" || resolved_workdir="$workdir"
  fi

  local tmp_file
  tmp_file="$(mktemp "${TFX_TMP:-${TMPDIR:-/tmp}}/tfx-skill-prompt.XXXXXX" 2>/dev/null)" || {
    printf '%s' "$prompt"
    return 0
  }

  if ! {
    printf '%s\n' "--- SKILL: ${skill_name} (workspace: ${resolved_workdir}; apply this methodology to the task below) ---"
    cat "$skill_file"
    if [[ -s "$skill_file" ]]; then
      local last_byte
      last_byte="$(tail -c 1 "$skill_file" 2>/dev/null || true)"
      [[ -n "$last_byte" ]] && printf '\n'
    fi
    printf '%s\n' "--- END SKILL ---"
    printf '%s' "$prompt"
  } > "$tmp_file"; then
    rm -f "$tmp_file" 2>/dev/null || true
    printf '%s' "$prompt"
    return 0
  fi

  cat "$tmp_file" 2>/dev/null || printf '%s' "$prompt"
  rm -f "$tmp_file" 2>/dev/null || true
}

# append_agy_anti_overclaim: agy(Gemini 3.x) 레인 전용 완료/grounding 규율 블록을
# 프롬프트 *뒤*에 붙인다. Gemini 3.x 는 과신(overconfidence) outlier 라 거짓 완료
# 주장·환각이 잦다 (AA-Omniscience 실증). 부정 제약은 Gemini 3 공식 가이드 권고대로
# 프롬프트 END 에 배치하고, blanket "do not guess" 대신 "주어진 context 로 추론 +
# 정확한 abstention 우선" 형태로 적는다 (open-ended negative 는 역효과). TFX_AGY_ANTI_OVERCLAIM=0 으로 opt-out.
append_agy_anti_overclaim() {
  local prompt="${1:-}"
  local repo_root="${2:-${WORKDIR:-$PWD}}"
  local resolved_repo_root="$repo_root"
  if [[ -d "$repo_root" ]]; then
    resolved_repo_root="$(cd "$repo_root" 2>/dev/null && pwd -P)" || resolved_repo_root="$repo_root"
  fi
  case "${TFX_AGY_ANTI_OVERCLAIM:-1}" in
    0|false|FALSE|off|OFF|no|NO)
      printf '%s' "$prompt"
      return 0
      ;;
  esac

  printf '%s' "$prompt"
  printf '\n\n%s\n' "--- COMPLETION & GROUNDING DISCIPLINE (apply strictly) ---"
  printf '%s\n' "Repository root (absolute): ${resolved_repo_root}. Resolve every relative path against this root only."
  printf '%s\n' "Before any file write, git add/commit/push, verify \`git rev-parse --show-toplevel\` equals the repository root above; if it differs, stop and report the mismatch instead of proceeding."
  printf '%s\n' "- Claim done/fixed/passing ONLY after running the check in this turn and seeing its output. With no fresh evidence, report what is still unverified instead of asserting success."
  printf '%s\n' "- Ground every answer in the provided context and the actual repository. If something is not verifiable from what you can see, say 'No Info / 확인 불가' and stop rather than inventing plausible-but-unconfirmed details."
  printf '%s\n' "- Use the provided context for deductions and prefer accurate abstention over confident guessing."
  printf '%s\n' "The task's own final output/format constraints above remain in effect."
  printf '%s' "--- END DISCIPLINE ---"
}

read_probe_state() {
  local pid="$1"
  local state_file="${TFX_PROBE_STATE_FILE:-${TFX_PROBE_DIR}/${pid}.json}"
  [[ -f "$state_file" ]] || return 1
  # 2-step read (#162): health-probe.mjs 의 atomic write (tmp+rename) 가 도입되었지만
  # writer 쪽 OS race 또는 race-free 보장을 못 받는 환경 (예: 일부 FS) 에서 빈/부분 파일
  # 을 sed 가 읽고 stale state 를 반환하는 것을 방지하기 위해 size 가 너무 작으면 무시.
  local size
  size=$(wc -c < "$state_file" 2>/dev/null || printf '0')
  [[ "$size" -ge 20 ]] || return 1
  sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state_file" 2>/dev/null | head -1
}
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

# ── 스크립트 경로 해석 공통 인프라 ──
_tfx_script_dir=""
_get_script_dir() {
  if [[ -z "$_tfx_script_dir" ]]; then
    local ref; ref="$(normalize_script_path "${BASH_SOURCE[0]}")"
    _tfx_script_dir="$(cd "$(dirname "$ref")" && pwd -P)"
  fi
  printf '%s\n' "$_tfx_script_dir"
}

# _resolve_script ENV_VAR_VALUE CANDIDATE... → 첫 번째 존재하는 파일 경로 반환
_resolve_script() {
  local env_val="${1:-}"; shift
  [[ -n "$env_val" && -f "$env_val" ]] && { printf '%s\n' "$env_val"; return 0; }
  local c; for c in "$@"; do [[ -f "$c" ]] && { printf '%s\n' "$c"; return 0; }; done
  return 1
}

# ── 팀 Hub Bridge 통신 ──
resolve_bridge_script() {
  local sd; sd="$(_get_script_dir)"
  _resolve_script "${TFX_BRIDGE_SCRIPT:-}" \
    ${TFX_PKG_ROOT:+"$TFX_PKG_ROOT/hub/bridge.mjs"} \
    "$sd/../hub/bridge.mjs" "$sd/hub/bridge.mjs"
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
is_ephemeral_hub_context() {
  local normalized_cwd="${PWD//\\//}"
  case "$normalized_cwd" in
    *"/.claude/worktrees/"*|*"/.worktrees/"*|*"/.codex-swarm/wt-"*|*"/wt-"*)
      return 0
      ;;
  esac

  local key
  for key in TFX_WORKER_SANDBOX_SCOPE TFX_WORKER_INDEX TFX_TEAM_TASK_ID TFX_TEAM_AGENT_NAME TFX_EPHEMERAL; do
    if [[ -n "${!key:-}" ]]; then
      return 0
    fi
  done

  return 1
}

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
  # Test-only opt-in (TFX_HUB_ALLOW_EPHEMERAL_PORT=1): keep the TFX_HUB_URL-derived
  # port in ephemeral context instead of forcing canonical 27888, so hub-restart
  # integration tests bind an isolated port without thrashing the live hub.
  # Default-off: unset/empty/non-"1" preserves the canonical force (production
  # unchanged). The elif keeps the bash↔node parity assertion matching
  # (then → hub_port=27888 stays adjacent).
  if [[ "${TFX_HUB_ALLOW_EPHEMERAL_PORT:-0}" == "1" ]]; then
    : # honor URL-derived hub_port (no canonical force)
  elif is_ephemeral_hub_context; then
    hub_port=27888
  fi

  echo "[tfx-route] Hub 미응답 — 자동 재시작 시도 (port=$hub_port)..." >&2
  TFX_HUB_PORT="$hub_port" TFX_HUB_ALLOW_EPHEMERAL_PORT="${TFX_HUB_ALLOW_EPHEMERAL_PORT:-0}" "$NODE_BIN" "$hub_server" &>/dev/null &
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
    # 전체를 Node.js로 안전하게 stringify — 변수 직접 삽입 인젝션 방지
    "$NODE_BIN" -e '
      const [,taskId,agent,team,result,summary,ts] = process.argv;
      process.stdout.write(JSON.stringify({taskId,agent,team,result,summary,timestamp:ts}));
    ' -- "$TFX_TEAM_TASK_ID" "$TFX_TEAM_AGENT_NAME" "$TFX_TEAM_NAME" "$result" "$summary_trimmed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "${result_dir}/${TFX_TEAM_TASK_ID}.json" 2>/dev/null \
      && echo "[tfx-route] 결과 백업: ${result_dir}/${TFX_TEAM_TASK_ID}.json" >&2
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

agy_supports_headless() {
  local agy_bin="$1"
  local help_text
  if ! command -v "$agy_bin" &>/dev/null; then
    return 1
  fi
  if ! help_text=$("$agy_bin" --help 2>&1); then
    return 1
  fi
  help_text="${help_text:0:20000}"
  [[ "$help_text" == *"--print"* && "$help_text" == *"--dangerously-skip-permissions"* ]]
}

codex_is_available() {
  [[ "${TFX_CODEX_OK:-0}" == "1" ]] \
    && command -v "${CODEX_BIN:-codex}" &>/dev/null
}

auto_reroute() {
  # Issue #281: code-change dispatch escalation is decided in the JS router
  # (hub/lib/tfx-route-args.mjs). This shell function only handles quota-driven
  # CLI fallback and must stay a transparent passthrough for dispatch mode.
  local failed_cli="$1"
  local target_cli=""
  local -a candidates=()
  case "$failed_cli" in
    codex) candidates=("antigravity") ;;
    gemini) candidates=("antigravity" "codex") ;;
    antigravity) candidates=("codex") ;;
    *) echo "[tfx-quota] $failed_cli 대체 CLI 없음" >&2; return 1 ;;
  esac

  # 대상 CLI 존재 확인 (P2: command not found 방지)
  local candidate target_bin
  for candidate in "${candidates[@]}"; do
    if is_cli_disabled "$candidate"; then
      echo "[tfx-quota] ${candidate} disabled — 자동 전환 후보에서 제외" >&2
      continue
    fi
    case "$candidate" in
      codex) target_bin="${CODEX_BIN:-codex}" ;;
      gemini) target_bin="${GEMINI_BIN:-gemini}" ;;
      antigravity) target_bin="${AGY_BIN:-agy}" ;;
    esac
    if [[ "$candidate" == "antigravity" ]]; then
      [[ "${TFX_ANTIGRAVITY_OK:-0}" == "1" ]] || continue
      agy_supports_headless "$target_bin" || continue
      target_cli="$candidate"
      break
    elif [[ "$candidate" == "codex" ]] && codex_is_available; then
      target_cli="$candidate"
      break
    fi
  done

  if [[ -z "$target_cli" ]]; then
    echo "[tfx-quota] $failed_cli 대체 CLI 미설치 — 자동 전환 불가" >&2
    return 78
  fi

  case "$failed_cli:$target_cli" in
    codex:antigravity) echo "[tfx-quota] Codex → Antigravity 자동 전환" >&2 ;;
    gemini:antigravity) echo "[tfx-quota] Gemini → Antigravity 자동 전환" >&2 ;;
    gemini:codex) echo "[tfx-quota] Gemini → Codex 자동 전환" >&2 ;;
    antigravity:codex) echo "[tfx-quota] Antigravity → Codex 자동 전환" >&2 ;;
  esac

  local quota_marker="$TFX_TMP/tfx-quota-${failed_cli}-$(date +%Y%m%d)"
  echo "$(date +%s)" >> "$quota_marker"
  ORIGINAL_AGENT="$AGENT_TYPE"
  export TFX_REROUTED_FROM="$CLI_TYPE"
  # EXIT trap 정리 — exec는 현재 프로세스를 교체하므로 trap이 실행되지 않음
  declare -F cleanup_workers >/dev/null && cleanup_workers
  TFX_CLI_MODE="$target_cli" exec bash "${BASH_SOURCE[0]}" \
    "$AGENT_TYPE" "$PROMPT" "$MCP_PROFILE" "${USER_TIMEOUT:-}" "${CONTEXT_FILE:-}"
}

capture_workspace_signature() {
  if ! command -v git &>/dev/null; then
    return 1
  fi

  if ! git -c core.fsmonitor=false rev-parse --is-inside-work-tree < /dev/null >/dev/null 2>&1; then
    return 1
  fi

  git -c core.fsmonitor=false status --short --untracked-files=all --ignore-submodules=all < /dev/null 2>/dev/null || return 1
}

# ── Codex CLI 버전 감지 (캐시) ──
_CODEX_VERSION=""
get_codex_version() {
  if [[ -n "$_CODEX_VERSION" ]]; then echo "$_CODEX_VERSION"; return; fi
  local raw
  raw=$("$CODEX_BIN" --version < /dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
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
      flash35_low: 'Gemini 3.5 Flash (Low)',
      flash35: 'Gemini 3.5 Flash (Medium)',
      flash35_high: 'Gemini 3.5 Flash (High)',
      pro31_low: 'Gemini 3.1 Pro (Low)',
      pro31: 'Gemini 3.1 Pro (High)',
      flash3: 'Gemini 3 Flash'
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

    process.stdout.write(defaults[name] || defaults[process.env.TFX_GEMINI_DEFAULT_PROFILE] || defaults.flash35);
  " "$profile" "$_GEMINI_PROFILE_CACHE" "$settings_cache" 2>/dev/null)
  echo "${result:-Gemini 3.5 Flash (Medium)}"
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
  _raw_type=$("$NODE_BIN" -e "
    const p=require('path').resolve(process.argv[1]);
    const m=JSON.parse(require('fs').readFileSync(p,'utf8'));
    const t=m[process.argv[2]];
    if(t)process.stdout.write(t);
  " "$map_file" "$agent" 2>/dev/null)

  if [[ -z "$_raw_type" ]]; then
    echo "ERROR: 알 수 없는 에이전트 타입: $agent" >&2
    echo "사용 가능: $("$NODE_BIN" -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(require('path').resolve(process.argv[1]),'utf8'))).join(', '))" "$map_file" 2>/dev/null)" >&2
    exit 1
  fi

  # "claude" → "claude-native" (headless.mjs는 "claude", route.sh는 "claude-native")
  CLI_TYPE="$_raw_type"
  [[ "$CLI_TYPE" == "claude" ]] && CLI_TYPE="claude-native"

  # ── CLI_CMD: CLI_TYPE에서 파생 ──
  case "$CLI_TYPE" in
    codex)         CLI_CMD="codex" ;;
    gemini)        CLI_CMD="gemini" ;;
    antigravity)   CLI_CMD="agy" ;;
    claude-native) CLI_CMD=""; CLI_ARGS="" ;;
  esac

  # ── Codex role policy: Node SSOT의 enum-validated TSV만 shell이 조립한다. ──
  if [[ "$CLI_TYPE" == "codex" ]]; then
    local route_dir policy_file policy_row policy_profile policy_timeout policy_mode policy_oversight policy_mcp policy_subcommand
    route_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    policy_file="$route_dir/lib/agent-route-policy.mjs"
    if [[ ! -f "$policy_file" && -n "$TFX_PKG_ROOT" ]]; then
      policy_file="$TFX_PKG_ROOT/scripts/lib/agent-route-policy.mjs"
    fi
    if [[ ! -f "$policy_file" ]]; then
      echo "ERROR: agent route policy 미발견 (경로: $policy_file)" >&2
      exit 1
    fi
    policy_row=$("$NODE_BIN" "$policy_file" --format tsv --agent "$agent") || {
      echo "ERROR: Codex agent route policy 조회 실패: $agent" >&2
      exit 1
    }
    IFS=$'\t' read -r policy_profile policy_timeout policy_mode policy_oversight policy_mcp policy_subcommand <<< "$policy_row"
    case "$policy_profile" in gpt56_sol_xhigh|gpt56_terra_high|gpt56_terra_med|gpt56_luna_low) ;; *) echo "ERROR: invalid Codex profile policy" >&2; exit 1 ;; esac
    [[ "$policy_timeout" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: invalid Codex timeout policy" >&2; exit 1; }
    case "$policy_mode" in fg|bg) ;; *) echo "ERROR: invalid Codex run mode policy" >&2; exit 1 ;; esac
    case "$policy_oversight" in true|false) ;; *) echo "ERROR: invalid Codex oversight policy" >&2; exit 1 ;; esac
    case "$policy_mcp" in implement|analyze|review) ;; *) echo "ERROR: invalid Codex MCP hint policy" >&2; exit 1 ;; esac
    case "$policy_subcommand" in exec|review) ;; *) echo "ERROR: invalid Codex subcommand policy" >&2; exit 1 ;; esac
    CLI_ARGS="exec --profile ${policy_profile} ${codex_base}"
    [[ "$policy_subcommand" == "review" ]] && CLI_ARGS+=" review"
    CLI_EFFORT="$policy_profile"; DEFAULT_TIMEOUT="$policy_timeout"; RUN_MODE="$policy_mode"; OPUS_OVERSIGHT="$policy_oversight"
    AGENT_MCP_HINT="$policy_mcp"
    return
  fi

  # ── Non-Codex provider settings ──
  case "$agent" in
    # ─── Antigravity CLI lane ───
    # effort 차등: agent 별 GEMINI_PROFILE 을 설정하면 run_antigravity_exec() 가
    # resolve_gemini_profile 로 해석해 `--model "<display name>"`을 agy_args 에
    # 주입한다. 우선순위는 TFX_GEMINI_PROFILE(env) > GEMINI_PROFILE(agent) > flash35.
    # CLI_ARGS 는 read -a 로 word-split 되므로 공백 포함 모델명을 여기 넣지 않는다.
    # #310: upstream callers are normalized through agent-map.json, but this
    # direct route entrypoint intentionally keeps agy as a compatibility alias.
    designer)
      # 디자인 = 시각/UX 추론 → 3.5 Flash (High)
      CLI_ARGS="--print --dangerously-skip-permissions"
      GEMINI_PROFILE="flash35_high"
      CLI_EFFORT="agy_v1"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    writer)
      # 문서 작성 = 균형 → 3.5 Flash (Medium)
      CLI_ARGS="--print --dangerously-skip-permissions"
      GEMINI_PROFILE="flash35"
      CLI_EFFORT="agy_v1"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    gemini|antigravity|agy)
      # 직접 호출 alias — 기본 flash35. TFX_GEMINI_PROFILE 로 override 가능.
      # agy --print + --dangerously-skip-permissions 조합은 positional prompt에서
      # timeout이 재현되므로 wrapper 호출은 stdin pipe로 고정한다.
      CLI_ARGS="--print --dangerously-skip-permissions"
      GEMINI_PROFILE="flash35"
      CLI_EFFORT="agy_v1"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 탐색 (Claude-native: Glob/Grep/Read 직접 접근) ───
    explore|claude)
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=600; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;

    # ─── agent-map.json에만 정의된 신규 에이전트 (CLI_TYPE별 기본값) ───
    *)
      case "$CLI_TYPE" in
        gemini|antigravity)
          CLI_ARGS="--print --dangerously-skip-permissions"
          CLI_EFFORT="agy_v1"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
        claude-native)
          CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=600; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
      esac ;;
  esac
}

# ── CLI 모드 오버라이드 (tfx-codex / tfx-gemini 스킬용) ──
TFX_CLI_MODE="${TFX_CLI_MODE:-auto}"
TFX_NO_CLAUDE_NATIVE="${TFX_NO_CLAUDE_NATIVE:-0}"
TFX_DISABLE_CODEX="${TFX_DISABLE_CODEX:-0}"
TFX_DISABLE_ANTIGRAVITY="${TFX_DISABLE_ANTIGRAVITY:-0}"
TFX_VERIFIER_OVERRIDE="${TFX_VERIFIER_OVERRIDE:-auto}"
TFX_CODEX_TRANSPORT="${TFX_CODEX_TRANSPORT:-auto}"
TFX_CODEX_PROFILE="${TFX_CODEX_PROFILE:-auto}"
# Preflight 캐시 일괄 로드 — CLI/Hub 가용성 + Codex 요금제를 환경변수로 내보냄
# 하위 프로세스(스킬 포함)가 TFX_CODEX_OK, TFX_GEMINI_OK, TFX_ANTIGRAVITY_OK, TFX_HUB_OK로 즉시 참조 가능
if [[ -z "${TFX_PREFLIGHT_LOADED:-}" ]]; then
  # eval 제거 — \x1e (ASCII 30, Record Separator) delimited read로 인젝션 위험 차단
  # F05: `|`에서 `\x1e`로 변경 — 계정 tier/agent 이름 등 값에 `|` 포함 시 필드 분리 오류 방지
  IFS=$'\x1e' read -r _pf_codex _pf_gemini _pf_antigravity _pf_hub _pf_plan _pf_agents _pf_antigravity_status _pf_antigravity_source _pf_antigravity_reason < <(
    "$NODE_BIN" -e '
      try {
        const c = JSON.parse(require("fs").readFileSync(require("path").join(require("os").homedir(),".claude","cache","tfx-preflight.json"),"utf8"));
        const parts = [
          c?.codex?.ok ? "1" : "0",
          c?.gemini?.ok ? "1" : "0",
          c?.antigravity?.ok ? "1" : "0",
          c?.hub?.ok ? "1" : "0",
          (c?.codex_plan?.plan && c.codex_plan.plan !== "unknown" && c.codex_plan.plan !== "api") ? c.codex_plan.plan : "",
          Array.isArray(c?.available_agents) ? c.available_agents.join(",") : "",
          c?.antigravity?.status || "",
          c?.antigravity?.auth_source || "",
          c?.antigravity?.reason || ""
        ];
        process.stdout.write(parts.join("\x1e"));
      } catch { process.stdout.write("0\x1e0\x1e0\x1e0\x1e\x1e\x1e\x1e\x1e"); }
    ' 2>/dev/null
  ) || true
  export TFX_CODEX_OK="${TFX_CODEX_OK:-${_pf_codex:-0}}"
  export TFX_GEMINI_OK="${TFX_GEMINI_OK:-${_pf_gemini:-0}}"
  export TFX_ANTIGRAVITY_OK="${TFX_ANTIGRAVITY_OK:-${_pf_antigravity:-0}}"
  export TFX_HUB_OK="${TFX_HUB_OK:-${_pf_hub:-0}}"
  [[ -n "${_pf_antigravity_status:-}" ]] && export TFX_ANTIGRAVITY_STATUS="$_pf_antigravity_status"
  [[ -n "${_pf_antigravity_source:-}" ]] && export TFX_ANTIGRAVITY_AUTH_SOURCE="$_pf_antigravity_source"
  [[ -n "${_pf_antigravity_reason:-}" ]] && export TFX_ANTIGRAVITY_REASON="$_pf_antigravity_reason"
  [[ -n "${_pf_plan:-}" ]] && export TFX_CODEX_PLAN="$_pf_plan"
  [[ -n "${_pf_agents:-}" ]] && export TFX_AVAILABLE_AGENTS="$_pf_agents"
  export TFX_PREFLIGHT_LOADED=1
  unset _pf_codex _pf_gemini _pf_antigravity _pf_hub _pf_plan _pf_agents _pf_antigravity_status _pf_antigravity_source _pf_antigravity_reason
fi
# TFX_PREFLIGHT_LOADED는 하위 route 호출에도 상속된다. 요금제도 같은 route policy로
# 일관되게 상속해야 preflight가 빈 값을 반환한 자식이 set -u에서 죽지 않는다.
export TFX_CODEX_PLAN="${TFX_CODEX_PLAN:-pro}"
TFX_WORKER_INDEX="${TFX_WORKER_INDEX:-}"
TFX_SEARCH_TOOL="${TFX_SEARCH_TOOL:-}"
case "$TFX_NO_CLAUDE_NATIVE" in
  0|1) ;;
  *)
    echo "ERROR: TFX_NO_CLAUDE_NATIVE 값은 0 또는 1이어야 합니다. (현재: $TFX_NO_CLAUDE_NATIVE)" >&2
    exit 1
    ;;
esac
case "$TFX_DISABLE_CODEX" in
  0|1) ;;
  *)
    echo "ERROR: TFX_DISABLE_CODEX 값은 0 또는 1이어야 합니다. (현재: $TFX_DISABLE_CODEX)" >&2
    exit 1
    ;;
esac
case "$TFX_DISABLE_ANTIGRAVITY" in
  0|1) ;;
  *)
    echo "ERROR: TFX_DISABLE_ANTIGRAVITY 값은 0 또는 1이어야 합니다. (현재: $TFX_DISABLE_ANTIGRAVITY)" >&2
    exit 1
    ;;
esac
case "$TFX_CODEX_PLAN" in
  pro|prolite|plus|free) ;;
  *)
    # 플랜 값은 preflight 가 Codex 인증 JWT 에서 읽어온다. OpenAI 가 요금제를
    # 신설하면(예: prolite) 화이트리스트가 뒤처져 CLI 위임 전체가 죽었다.
    # 미지값은 차단하지 말고 경고 후 pro 로 degrade 한다 (fail-open).
    echo "WARN: 알 수 없는 TFX_CODEX_PLAN 값 '$TFX_CODEX_PLAN' — pro 로 degrade 합니다." >&2
    TFX_CODEX_PLAN=pro
    ;;
esac
case "$TFX_CODEX_TRANSPORT" in
  auto|mcp|exec) ;;
  *)
    echo "ERROR: TFX_CODEX_TRANSPORT 값은 auto, mcp, exec 중 하나여야 합니다. (현재: $TFX_CODEX_TRANSPORT)" >&2
    exit 1
    ;;
esac
case "$TFX_CODEX_PROFILE" in
  auto|max|ultra|gpt56_luna_low|gpt56_terra_med|gpt56_terra_high|gpt56_sol_xhigh|gpt56_sol_max|gpt56_sol_ultra) ;;
  *)
    echo "ERROR: TFX_CODEX_PROFILE 값은 auto, max, ultra 또는 canonical gpt56_* profile이어야 합니다. (현재: $TFX_CODEX_PROFILE)" >&2
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

  if [[ "$CLI_TYPE" == "gemini" && ( "$TFX_CLI_MODE" == "auto" || "$TFX_CLI_MODE" == "gemini" ) ]]; then
    # Gemini CLI is deprecated, but the `gemini` route name remains as a
    # compatibility alias until Phase 5 cleanup. When Antigravity readiness has
    # already been proven by preflight/cache, direct gemini routes must follow
    # the same redirect as TFX_CLI_MODE=gemini remaps.
    if [[ "${TFX_ANTIGRAVITY_OK:-0}" == "1" ]] && command -v "${AGY_BIN:-agy}" &>/dev/null; then
      echo "[tfx-route] [deprecated] gemini route → antigravity (Gemini CLI deprecated, use antigravity/agy)" >&2
      TFX_CLI_MODE="antigravity"
      apply_cli_mode
      return
    fi
  fi

  case "$TFX_CLI_MODE" in
    codex)
      if [[ "$CLI_TYPE" == "gemini" || "$CLI_TYPE" == "antigravity" ]]; then
        CLI_TYPE="codex"; CLI_CMD="codex"
        case "$AGENT_TYPE" in
          designer|antigravity|agy|gemini)
            CLI_ARGS="exec --profile gpt56_sol_xhigh ${codex_base}"; CLI_EFFORT="gpt56_sol_xhigh"; DEFAULT_TIMEOUT=3600 ;;
          writer)
            CLI_ARGS="exec --profile gpt56_luna_low ${codex_base}"; CLI_EFFORT="gpt56_luna_low"; DEFAULT_TIMEOUT=180 ;;
          *)
            CLI_ARGS="exec --profile gpt56_terra_high ${codex_base}"; CLI_EFFORT="gpt56_terra_high"; DEFAULT_TIMEOUT=1080 ;;
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
        # Gemini CLI deprecated — the mode name is retained as a compatibility
        # alias only. Do not enter the legacy gemini binary path.
        if [[ "${TFX_ANTIGRAVITY_OK:-0}" == "1" ]] && agy_supports_headless "${AGY_BIN:-agy}"; then
          echo "[tfx-route] [deprecated] TFX_CLI_MODE=gemini → antigravity (Gemini CLI deprecated, use --cli antigravity)" >&2
          TFX_CLI_MODE="antigravity"; apply_cli_mode; return
        fi
        if codex_is_available; then
          echo "[tfx-route] [deprecated] TFX_CLI_MODE=gemini: agy headless 불가 — codex fallback" >&2
          TFX_CLI_MODE="codex"; apply_cli_mode; return
        fi
        CLI_TYPE="antigravity"; CLI_CMD="agy"
        echo "[tfx-route] [deprecated] TFX_CLI_MODE=gemini: agy/codex 불가 — hard routing 검증으로 전달" >&2
      fi ;;
    antigravity)
      if [[ "$CLI_TYPE" != "claude-native" && "$CLI_TYPE" != "claude" ]]; then
        CLI_TYPE="antigravity"
        CLI_CMD="agy"
        CLI_ARGS="--print --dangerously-skip-permissions"
        # 주 라우팅(route_agent)과 동일하게 designer 만 effort 상향. 나머지는
        # run_antigravity_exec 폴백(flash35) 또는 TFX_GEMINI_PROFILE override.
        case "$AGENT_TYPE" in
          designer) GEMINI_PROFILE="flash35_high" ;;
          *)        GEMINI_PROFILE="flash35" ;;
        esac
        CLI_EFFORT="agy_v1"
        DEFAULT_TIMEOUT=900
        echo "[tfx-route] TFX_CLI_MODE=antigravity: $AGENT_TYPE → antigravity($CLI_EFFORT)로 리매핑" >&2
      fi ;;
    auto)
      # Issue #281: JS layer is the single source of truth for auto router
      # single/multi/swarm dispatch. Shell auto mode only normalizes CLI
      # availability and leaves code-change swarm escalation to JS.
      if [[ "$CLI_TYPE" == "codex" ]] && ! codex_is_available; then
        if [[ "${TFX_ANTIGRAVITY_OK:-0}" == "1" ]] && agy_supports_headless "${AGY_BIN:-agy}"; then
          TFX_CLI_MODE="antigravity"; apply_cli_mode; return
        else
          echo "[tfx-route] codex/antigravity 모두 불가: hard routing 검증으로 전달" >&2
        fi
      elif [[ "$CLI_TYPE" == "gemini" ]]; then
        if [[ "${TFX_ANTIGRAVITY_OK:-0}" == "1" ]] && agy_supports_headless "${AGY_BIN:-agy}"; then
          TFX_CLI_MODE="antigravity"; apply_cli_mode; return
        elif codex_is_available; then
          TFX_CLI_MODE="codex"; apply_cli_mode; return
        else
          CLI_TYPE="antigravity"; CLI_CMD="agy"
          echo "[tfx-route] deprecated gemini alias: agy/codex 불가 — hard routing 검증으로 전달" >&2
        fi
      elif [[ "$CLI_TYPE" == "antigravity" ]] && ! agy_supports_headless "${AGY_BIN:-agy}"; then
        if codex_is_available; then
          TFX_CLI_MODE="codex"; apply_cli_mode; return
        fi
        echo "[tfx-route] antigravity headless 불가: hard routing 검증으로 전달" >&2
      fi ;;
  esac
}

# ── CLI disable 정책 (강제 모드/동적 오버라이드보다 우선) ──
# TFX_CLI_MODE는 선호/강제 선택이고 TFX_*_OK는 preflight 관측값이다. 이 정책은
# 운영자가 명시한 실행 금지이므로, 최종 CLI 선택 후 한 번만 적용한다.
is_cli_disabled() {
  case "$1" in
    codex) [[ "$TFX_DISABLE_CODEX" == "1" ]] ;;
    antigravity) [[ "$TFX_DISABLE_ANTIGRAVITY" == "1" ]] ;;
    *) return 1 ;;
  esac
}

is_cli_available() {
  case "$1" in
    codex)
      codex_is_available
      ;;
    antigravity)
      [[ "${TFX_ANTIGRAVITY_OK:-0}" == "1" ]] \
        && agy_supports_headless "${AGY_BIN:-agy}"
      ;;
    *)
      return 1
      ;;
  esac
}

apply_cli_disable_policy() {
  local selected="$CLI_TYPE"
  [[ "$selected" == "gemini" ]] && selected="antigravity"
  [[ "$selected" == "codex" || "$selected" == "antigravity" ]] || return 0

  local blocked_reason=""
  if is_cli_disabled "$selected"; then
    case "$selected" in
      codex) blocked_reason="TFX_DISABLE_CODEX=1: codex 선택 차단" ;;
      antigravity) blocked_reason="TFX_DISABLE_ANTIGRAVITY=1: antigravity 선택 차단" ;;
    esac
  elif ! is_cli_available "$selected"; then
    blocked_reason="${selected} 미가용: 선택 차단"
  else
    return 0
  fi
  echo "[tfx-route] $blocked_reason" >&2

  local candidate=""
  case "$selected" in
    codex) candidate="antigravity" ;;
    antigravity) candidate="codex" ;;
  esac
  if ! is_cli_disabled "$candidate" && is_cli_available "$candidate"; then
    echo "[tfx-route] ${selected} → ${candidate} 명시적 fallback (금지 CLI 제외)" >&2
    TFX_CLI_MODE="$candidate"
    apply_cli_mode
    if [[ "$CLI_TYPE" == "$candidate" ]] \
      && ! is_cli_disabled "$CLI_TYPE" \
      && is_cli_available "$CLI_TYPE"; then
      return 0
    fi
  fi

  echo "ERROR: 허용되고 사용 가능한 외부 CLI가 없습니다. codex(disabled=${TFX_DISABLE_CODEX}, available=$(is_cli_available codex && echo 1 || echo 0)), antigravity(disabled=${TFX_DISABLE_ANTIGRAVITY}, available=$(is_cli_available antigravity && echo 1 || echo 0)). Claude native로 조용히 강등하지 않습니다." >&2
  return 78
}

# ── Codex legacy 프로필 가드 ──
apply_plan_guard() {
  [[ "$CLI_TYPE" != "codex" ]] && return

  local replacement=""
  case "$CLI_EFFORT" in
    gpt55_low|spark53_low|codex53_low|gpt54_low|mini54_low) replacement="gpt56_luna_low" ;;
    gpt55_med|spark53_med|codex53_med|mini54_med) replacement="gpt56_terra_med" ;;
    gpt55_xhigh|codex53_xhigh|gpt54_xhigh) replacement="gpt56_sol_xhigh" ;;
    gpt55_high|spark53_*|codex53_*|gpt54_*|mini54_*) replacement="gpt56_terra_high" ;;
  esac
  [[ -z "$replacement" ]] && return

  local codex_base
  codex_base="$(build_codex_base)"
  CLI_ARGS="exec --profile ${replacement} ${codex_base}"
  CLI_EFFORT="$replacement"
  echo "[tfx-route] legacy Codex profile remapped to ${replacement}" >&2
}

# ── Claude 네이티브 제거 (Codex 리드 환경에서 선택적 활성화) ──
apply_no_claude_native_mode() {
  local codex_base
  codex_base="$(build_codex_base)"

  [[ "$TFX_NO_CLAUDE_NATIVE" != "1" ]] && return
  [[ "$TFX_CLI_MODE" == "gemini" || "$TFX_CLI_MODE" == "antigravity" ]] && return
  [[ "$CLI_TYPE" != "claude-native" ]] && return

  if ! codex_is_available; then
    echo "[tfx-route] TFX_NO_CLAUDE_NATIVE=1 이지만 codex가 preflight에서 가용하지 않아 claude-native 유지" >&2
    return
  fi

  ORIGINAL_AGENT="${AGENT_TYPE}"
  CLI_TYPE="codex"; CLI_CMD="codex"

  case "$AGENT_TYPE" in
    explore)
      CLI_ARGS="exec --profile gpt56_luna_low ${codex_base}"
      CLI_EFFORT="gpt56_luna_low"
      DEFAULT_TIMEOUT=600
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    verifier)
      CLI_ARGS="exec --profile gpt56_terra_high ${codex_base} review"
      CLI_EFFORT="gpt56_terra_high"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    test-engineer)
      CLI_ARGS="exec --profile gpt56_terra_high ${codex_base}"
      CLI_EFFORT="gpt56_terra_high"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    qa-tester)
      CLI_ARGS="exec --profile gpt56_terra_high ${codex_base} review"
      CLI_EFFORT="gpt56_terra_high"
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

## ── Phase 1 dynamic routing override (opt-in env TRIFLUX_DYNAMIC_ROUTING) ──
## scripts/lib/dynamic-route-cli.mjs 가 routing decision 의 shards[0].cli 만
## stdout 으로 반환. env 미설정 시 helper 가 silent no-op (stdout empty) →
## 현재 CLI_TYPE 유지. conductor (sync) / swarm-hypervisor (plan-time) wire-up
## 과 의도 정합한 sh 경로 wire-up.
## Retry snapshot profile plumbing.
## bridge retry-run/status exposes cliInvocation.argv for escalation-chain
## profile steps. Consume those argv directly instead of duplicating profile
## resolution here.
resolve_safe_retry_codex_profile() {
  local profile="$1"
  case "$profile" in
    ultra|gpt56_sol_ultra|*_ultra)
      echo "gpt56_sol_max"
      return
      ;;
    gpt56_luna_low|gpt56_terra_med|gpt56_terra_high|gpt56_sol_xhigh|gpt56_sol_max)
      echo "$profile"
      return
      ;;
  esac

  local codex_home profile_file effort
  codex_home="${CODEX_HOME:-${TFX_CODEX_HOME:-${HOME:-}/.codex}}"
  profile_file="${codex_home}/${profile}.config.toml"
  if [[ ! -f "$profile_file" ]]; then
    echo "gpt56_terra_high"
    return
  fi
  effort=$(awk -F= '
    /^[[:space:]]*model_reasoning_effort[[:space:]]*=/ {
      value=$2
      sub(/[[:space:]]*#.*/, "", value)
      gsub(/^[[:space:]"'"'']+|[[:space:]"'"'']+$/, "", value)
      print tolower(value)
      exit
    }
  ' "$profile_file" 2>/dev/null || true)
  case "$effort" in
    ultra) echo "gpt56_sol_max" ;;
    "") echo "gpt56_terra_high" ;;
    *) echo "$profile" ;;
  esac
}

read_codex_profile_effort() {
  local profile="$1"
  local codex_home profile_file effort
  codex_home="${CODEX_HOME:-${TFX_CODEX_HOME:-${HOME:-}/.codex}}"
  profile_file="${codex_home}/${profile}.config.toml"
  if [[ -f "$profile_file" ]]; then
    effort=$(awk -F= '
      /^[[:space:]]*model_reasoning_effort[[:space:]]*=/ {
        value=$2
        sub(/[[:space:]]*#.*/, "", value)
        gsub(/^[[:space:]"'"'']+|[[:space:]"'"'']+$/, "", value)
        print tolower(value)
        exit
      }
    ' "$profile_file" 2>/dev/null || true)
    echo "$effort"
    return
  fi
  case "$profile" in
    *_ultra) echo "ultra" ;;
    *_max) echo "max" ;;
    *_xhigh) echo "xhigh" ;;
    *_high) echo "high" ;;
    *_med|*_medium) echo "medium" ;;
    *_low) echo "low" ;;
    *) echo "" ;;
  esac
}

apply_codex_concrete_effort_guard() {
  [[ "${CLI_TYPE:-}" == "codex" ]] || return 0

  local -a args=()
  read -r -a args <<< "$CLI_ARGS"
  local profile="" i
  for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in
      --profile) profile="${args[$((i + 1))]:-}" ;;
      --profile=*) profile="${args[$i]#--profile=}" ;;
    esac
  done
  [[ -n "$profile" ]] || return 0

  local allow_ultra=0
  if [[ "$TFX_CODEX_PROFILE" == "ultra" || "$TFX_CODEX_PROFILE" == "gpt56_sol_ultra" ]]; then
    if ! is_nested_codex_runtime && [[ -z "${TFX_RETRY_SNAPSHOT:-${TFX_RETRY_SNAPSHOT_FILE:-}}" ]]; then
      case "$AGENT_TYPE" in
        deep-executor|scientist-deep) allow_ultra=1 ;;
      esac
    fi
  fi

  local effort target_effort=""
  effort="$(read_codex_profile_effort "$profile")"
  case "$profile" in
    gpt56_sol_max) target_effort="max" ;;
    gpt56_sol_ultra)
      [[ "$allow_ultra" -eq 1 ]] && target_effort="ultra" || target_effort="max"
      ;;
    *)
      if [[ "$effort" == "ultra" ]]; then
        [[ "$allow_ultra" -eq 1 ]] && target_effort="ultra" || target_effort="max"
      fi
      ;;
  esac
  [[ -n "$target_effort" ]] || return 0

  CLI_ARGS+=" -c model=\"gpt-5.6-sol\" -c model_reasoning_effort=\"${target_effort}\""
  CLI_EFFORT="gpt56_sol_${target_effort}"
  CODEX_MODEL_OVERRIDE="gpt-5.6-sol"
  CODEX_REASONING_EFFORT_OVERRIDE="$target_effort"
  echo "[tfx-route] final Codex effort guard: ${profile}/${effort:-unknown} -> ${target_effort}" >&2
}

apply_retry_snapshot_cli_invocation() {
  [[ "${CLI_TYPE:-}" == "codex" ]] || return 0

  local snapshot="${TFX_RETRY_SNAPSHOT:-${TFX_RETRY_SNAPSHOT_FILE:-}}"
  [[ -n "$snapshot" ]] || return 0

  local status_json
  if ! status_json=$(bridge_cli retry-status --snapshot "$snapshot" --json); then
    echo "[tfx-route] WARNING: retry snapshot status unavailable; keeping existing codex args" >&2
    return
  fi

  local invocation_cli
  invocation_cli=$(bridge_json_get "$status_json" "cliInvocation.cli" 2>/dev/null || true)
  [[ "$invocation_cli" == "codex" ]] || return 0

  local argv_json
  argv_json=$(bridge_json_get "$status_json" "cliInvocation.argv" 2>/dev/null || true)
  [[ -n "$argv_json" ]] || return 0

  local retry_argv
  if ! retry_argv=$("$NODE_BIN" -e '
    const argv = JSON.parse(process.argv[1] || "[]");
    if (!Array.isArray(argv)) process.exit(1);
    if (argv.length === 0) process.exit(0);
    for (const arg of argv) {
      if (typeof arg !== "string" || arg.length === 0 || /\s/.test(arg)) {
        process.exit(2);
      }
    }
    process.stdout.write(argv.join(" "));
  ' -- "$argv_json" 2>/dev/null); then
    echo "[tfx-route] WARNING: retry snapshot argv unsupported; keeping existing codex args" >&2
    return
  fi
  [[ -n "$retry_argv" ]] || return 0

  local -a base_args=()
  local -a retry_args=()
  local -a merged_args=()
  read -r -a base_args <<< "$CLI_ARGS"
  read -r -a retry_args <<< "$retry_argv"

  local retry_has_profile=0
  local retry_profile=""
  local i
  for ((i = 0; i < ${#retry_args[@]}; i++)); do
    case "${retry_args[$i]}" in
      --profile)
        retry_has_profile=1
        retry_profile="${retry_args[$((i + 1))]:-}"
        local safe_retry_profile
        safe_retry_profile="$(resolve_safe_retry_codex_profile "$retry_profile")"
        if [[ "$safe_retry_profile" != "$retry_profile" ]]; then
          echo "[tfx-route] retry Codex profile guard: ${retry_profile} -> ${safe_retry_profile}" >&2
          retry_profile="$safe_retry_profile"
          retry_args[$((i + 1))]="$safe_retry_profile"
        fi
        ;;
      --profile=*)
        retry_has_profile=1
        retry_profile="${retry_args[$i]#--profile=}"
        local safe_retry_profile
        safe_retry_profile="$(resolve_safe_retry_codex_profile "$retry_profile")"
        if [[ "$safe_retry_profile" != "$retry_profile" ]]; then
          echo "[tfx-route] retry Codex profile guard: ${retry_profile} -> ${safe_retry_profile}" >&2
          retry_profile="$safe_retry_profile"
          retry_args[$i]="--profile=$safe_retry_profile"
        fi
        ;;
    esac
  done

  if [[ "$retry_has_profile" -eq 1 ]]; then
    local skip_next=0
    for ((i = 0; i < ${#base_args[@]}; i++)); do
      if [[ "$skip_next" -eq 1 ]]; then
        skip_next=0
        continue
      fi
      case "${base_args[$i]}" in
        --profile)
          skip_next=1
          continue
          ;;
        --profile=*)
          continue
          ;;
      esac
      merged_args+=("${base_args[$i]}")
    done
  else
    merged_args=("${base_args[@]}")
  fi

  merged_args+=("${retry_args[@]}")
  CLI_ARGS="${merged_args[*]}"
  [[ -n "$retry_profile" ]] && CLI_EFFORT="$retry_profile"
  echo "[tfx-route] retry snapshot cliInvocation.argv applied" >&2
}

apply_dynamic_routing_override() {
  # set -u 환경 safe — 모든 env 변수 default 값 패턴 적용.
  local flag="${TRIFLUX_DYNAMIC_ROUTING:-}"
  [[ "$flag" != "1" && "$flag" != "true" ]] && return
  [[ -z "${CLI_TYPE:-}" ]] && return
  [[ "${CLI_TYPE}" == "claude-native" ]] && return

  local cli_helper="${REPO_ROOT:-}/scripts/lib/dynamic-route-cli.mjs"
  [[ ! -f "$cli_helper" ]] && return

  local override_cli
  override_cli=$(node "$cli_helper" \
    --task-id "tfx-route-${AGENT_TYPE:-unknown}-$$" \
    --agent-hint "$CLI_TYPE" \
    --team-size 1 2>/dev/null) || return

  [[ -z "$override_cli" ]] && return
  [[ "$override_cli" == "gemini" ]] && override_cli="antigravity"
  [[ "$override_cli" == "$CLI_TYPE" ]] && return

  # 지원하는 CLI 만 적용 — 알 수 없는 값은 무시
  case "$override_cli" in
    codex|antigravity|claude) ;;
    *) return ;;
  esac

  echo "[tfx-route] dynamic_route_override: ${CLI_TYPE} -> ${override_cli} (TRIFLUX_DYNAMIC_ROUTING=${flag})" >&2
  CLI_TYPE="$override_cli"
  case "$override_cli" in
    codex)
      local codex_base
      codex_base="$(build_codex_base)"
      CLI_CMD="codex"
      CLI_ARGS="exec --profile gpt56_terra_high ${codex_base}"
      CLI_EFFORT="gpt56_terra_high"; DEFAULT_TIMEOUT=1080; RUN_MODE="fg"; OPUS_OVERSIGHT="false"
      ;;
    antigravity)
      CLI_CMD="agy"
      CLI_ARGS="--print --dangerously-skip-permissions"
      CLI_EFFORT="agy_v1"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false"
      ;;
    claude)
      CLI_CMD="claude"
      CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=1200; RUN_MODE="fg"; OPUS_OVERSIGHT="false"
      ;;
  esac
}

is_nested_codex_runtime() {
  [[ -n "${TFX_TEAM_NAME:-}" || -n "${TFX_WORKER_INDEX:-}" || -n "${TFX_WORKER_SANDBOX_SCOPE:-}" ]]
}

apply_codex_profile_override() {
  [[ "$CLI_TYPE" != "codex" ]] && return
  [[ "$TFX_CODEX_PROFILE" == "auto" ]] && return

  local requested="$TFX_CODEX_PROFILE"
  local profile="$requested"
  case "$requested" in
    max) profile="gpt56_sol_max" ;;
    ultra) profile="gpt56_sol_ultra" ;;
  esac

  if [[ "$profile" == "gpt56_sol_ultra" ]]; then
    local downgrade_reason=""
    case "$AGENT_TYPE" in
      deep-executor|scientist-deep) ;;
      *) downgrade_reason="agent ${AGENT_TYPE} is not ultra-eligible" ;;
    esac
    if is_nested_codex_runtime; then
      downgrade_reason="nested team/worker runtime"
    fi
    if [[ -n "$downgrade_reason" ]]; then
      echo "[tfx-route] Codex ultra -> max: ${downgrade_reason}" >&2
      profile="gpt56_sol_max"
    fi
  fi

  local codex_base
  codex_base="$(build_codex_base)"
  local review_suffix=""
  [[ "$CLI_ARGS" == *" review" ]] && review_suffix=" review"
  CLI_ARGS="exec --profile ${profile} ${codex_base}${review_suffix}"
  CLI_EFFORT="$profile"
  echo "[tfx-route] Codex profile override: ${requested} -> ${profile}" >&2
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
  [[ -n "$MCP_FILTER_SCRIPT" && -f "$MCP_FILTER_SCRIPT" ]] && { printf '%s\n' "$MCP_FILTER_SCRIPT"; return 0; }
  local sd; sd="$(_get_script_dir)"
  MCP_FILTER_SCRIPT=$(_resolve_script "" \
    ${sd:+"$sd/lib/mcp-filter.mjs"} \
    "$PWD/scripts/lib/mcp-filter.mjs" "$PWD/lib/mcp-filter.mjs") || return 1
  printf '%s\n' "$MCP_FILTER_SCRIPT"
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
  # Codex exec 모드에서도 config.toml의 MCP 서버를 전부 시작하므로,
  # transport 모드와 관계없이 registered servers를 전달하여 불필요한 서버를
  # enabled=false로 비활성화해야 한다.
  # 캐시가 비어있으면 config.toml에서 직접 서버 목록을 추출한다.
  if [[ -z "$available_servers" && "$CLI_TYPE" == "codex" && -f "$_CODEX_CONFIG" ]]; then
    available_servers=$(sed -n 's/^\[mcp_servers\.\([^].]*\)\]$/\1/p' "$_CODEX_CONFIG" 2>/dev/null \
      | sort -u | tr '\n' ',' | sed 's/,$//')
  fi

  local -a cmd=(
    "$NODE_BIN" "$filter_script" delimited
    "--agent" "$AGENT_TYPE"
    "--profile" "$MCP_PROFILE"
    "--available" "$available_servers"
    "--inventory-file" "$MCP_CACHE"
    "--task-text" "$PROMPT"
  )
  [[ -n "$TFX_SEARCH_TOOL" ]] && cmd+=("--search-tool" "$TFX_SEARCH_TOOL")
  [[ -n "$TFX_WORKER_INDEX" ]] && cmd+=("--worker-index" "$TFX_WORKER_INDEX")

  local _raw
  if ! _raw="$("${cmd[@]}" < /dev/null)"; then
    echo "[tfx-route] ERROR: MCP 정책 계산 실패" >&2
    return 1
  fi

  local _gemini_servers _codex_flags _phase
  IFS=$'\x1e' read -r MCP_PROFILE_REQUESTED MCP_RESOLVED_PROFILE MCP_HINT \
    _gemini_servers _codex_flags CODEX_CONFIG_JSON _phase <<< "$_raw"
  IFS=',' read -r -a GEMINI_ALLOWED_SERVERS <<< "$_gemini_servers"
  IFS=',' read -r -a CODEX_CONFIG_FLAGS <<< "$_codex_flags"
  # set -e 환경에서 함수 마지막 명령이 `[[ ... ]] && ...` 이면
  # 조건 불일치(= phase 없음)만으로 함수 전체가 실패 처리되어 route가 즉시 종료된다.
  # implement/default 같은 일반 경로는 phase를 비우는 것이 정상이다.
  if [[ -n "$_phase" ]]; then
    MCP_PIPELINE_PHASE="$_phase"
  fi

  return 0
}

get_claude_model() {
  case "$AGENT_TYPE" in
    explore) echo "haiku" ;;
    *) echo "sonnet" ;;
  esac
}

get_claude_effort() {
  # Claude Code exposes a separate --effort flag. Preserve high-end effort
  # levels instead of collapsing them into "high". `claude --effort` accepts
  # exactly low/medium/high/xhigh/max (an unknown value warns and falls back to
  # the default).
  case "$CLI_EFFORT" in
    low) echo "low" ;;
    medium) echo "medium" ;;
    high) echo "high" ;;
    xhigh) echo "xhigh" ;;
    max) echo "max" ;;
    *max*) echo "max" ;;
    *xhigh*) echo "xhigh" ;;
    *high*) echo "high" ;;
    *med*) echo "medium" ;;
    n/a|agy_v1|"") echo "" ;;
    *low*) echo "low" ;;
    *) echo "" ;;
  esac
}

emit_claude_native_metadata() {
  local model
  model=$(get_claude_model)
  local effort
  effort=$(get_claude_effort)
  echo "ROUTE_TYPE=claude-native"
  echo "AGENT=$AGENT_TYPE"
  echo "MODEL=$model"
  echo "EFFORT=$effort"
  echo "RUN_MODE=$RUN_MODE"
  echo "OPUS_OVERSIGHT=$OPUS_OVERSIGHT"
  echo "TIMEOUT=$TIMEOUT_SEC"
  echo "MCP_PROFILE=$MCP_PROFILE"
  [[ -n "$ORIGINAL_AGENT" ]] && echo "ORIGINAL_AGENT=$ORIGINAL_AGENT"
  echo "PROMPT=$PROMPT"
  echo "--- Claude Task($model) 에이전트로 위임하세요 ---"
}

# _find_fork_pids PID — cross-platform child PID lookup
# pgrep -P (Linux/macOS) → Git Bash ps fallback (PPID/PGID column)
_find_fork_pids() {
  local parent="$1"
  if command -v pgrep &>/dev/null; then
    pgrep -P "$parent" 2>/dev/null || true
    return
  fi
  # Git Bash: PID PPID PGID WINPID ... — match by PPID or PGID
  ps 2>/dev/null | awk -v p="$parent" 'NR>1 && ($2==p || ($3==p && $1!=p)) {print $1}' | sort -un | tr '\n' ' '
}

_codex_rollout_activity_bytes() {
  [[ "${CLI_TYPE:-}" == "codex" ]] || { printf '0\n'; return 0; }
  local codex_home="${CODEX_HOME:-${TFX_CODEX_HOME:-${HOME:-}/.codex}}"
  [[ -n "$codex_home" && "$codex_home" != "/.codex" ]] || { printf '0\n'; return 0; }
  local codex_home_real="$codex_home"
  [[ -d "$codex_home" ]] && codex_home_real=$(cd "$codex_home" 2>/dev/null && pwd -P || printf '%s' "$codex_home")

  local total=0 seen="" proc_pid fd target candidate size
  for proc_pid in "$@"; do
    [[ "$proc_pid" =~ ^[0-9]+$ ]] || continue

    if [[ -d "/proc/$proc_pid/fd" ]]; then
      for fd in "/proc/$proc_pid/fd"/*; do
        [[ -e "$fd" ]] || continue
        target=$(readlink "$fd" 2>/dev/null || true)
        case "$target" in
          "$codex_home"/sessions/*/rollout-*.jsonl|"$codex_home_real"/sessions/*/rollout-*.jsonl)
            seen="${seen}${target}"$'\n'
            ;;
        esac
      done
    fi

    if command -v lsof >/dev/null 2>&1; then
      while IFS= read -r candidate; do
        case "$candidate" in
          n"$codex_home"/sessions/*/rollout-*.jsonl|n"$codex_home_real"/sessions/*/rollout-*.jsonl)
            seen="${seen}${candidate#n}"$'\n'
            ;;
        esac
      done < <(lsof -Fn -p "$proc_pid" 2>/dev/null || true)
    fi
  done

  local raw_paths="$seen"
  seen=$'\n'
  while IFS= read -r candidate; do
    [[ -f "$candidate" ]] || continue
    [[ "$seen" == *$'\n'"$candidate"$'\n'* ]] && continue
    seen="${seen}${candidate}"$'\n'
    size=$(wc -c < "$candidate" 2>/dev/null || printf '0')
    size="${size//[[:space:]]/}"
    [[ "$size" =~ ^[0-9]+$ ]] || size=0
    total=$((total + size))
  done <<< "$raw_paths"
  printf '%s\n' "$total"
}

# heartbeat_monitor PID [INTERVAL] [STALL_THRESHOLD]
# - PID: 감시할 워커 프로세스 PID
# - INTERVAL: heartbeat 출력 간격 (초, 기본 10)
# - STALL_THRESHOLD: stall 경고 임계값 (초, 기본 1200)
# 환경변수: TFX_HEARTBEAT (0이면 비활성화), TFX_HEARTBEAT_INTERVAL, TFX_STALL_THRESHOLD
heartbeat_monitor() {
  [[ "${TFX_HEARTBEAT:-1}" -eq 0 ]] && return 0
  local pid="$1"
  local interval="${2:-${TFX_HEARTBEAT_INTERVAL:-10}}"
  local stall_threshold="${3:-${TFX_STALL_THRESHOLD:-1200}}"
  local expected_duration="${TFX_EXPECTED_DURATION_SEC:-}"
  local last_size=0 stall_count=0
  local pid_gone=false
  local post_exit_checks=0
  local max_post_exit_checks=6  # fallback drain: 6 intervals (fork PID 미발견 시)
  local last_known_forks=""     # direct fork PID tracking

  while true; do
    sleep "$interval"

    # Check if the tracked PID is still alive; snapshot forks while alive
    if ! kill -0 "$pid" 2>/dev/null; then
      if [[ "$pid_gone" == "false" ]]; then
        pid_gone=true
        local _imm; _imm=$(_find_fork_pids "$pid") || true
        [[ -n "$_imm" ]] && last_known_forks="$_imm"
        [[ -n "$last_known_forks" ]] && \
          echo "[tfx-heartbeat] pid=$pid exited, tracking forks: $last_known_forks" >&2
      fi
    else
      local _cf; _cf=$(_find_fork_pids "$pid") || true
      [[ -n "$_cf" ]] && last_known_forks="$_cf"
    fi

    local current_size=0
    [[ -f "$STDOUT_LOG" ]] && current_size=$(wc -c < "$STDOUT_LOG" 2>/dev/null || echo 0)
    # P3: stderr 활동도 포함하여 거짓 STALL 방지
    local stderr_size=0
    [[ -f "$STDERR_LOG" ]] && stderr_size=$(wc -c < "$STDERR_LOG" 2>/dev/null || echo 0)
    local codex_rollout_size=0
    codex_rollout_size=$(_codex_rollout_activity_bytes "$pid" $last_known_forks 2>/dev/null || echo 0)
    [[ "$codex_rollout_size" =~ ^[0-9]+$ ]] || codex_rollout_size=0
    # MCP wrappers buffer final stdout. Its sidecar grows only on an actual
    # in-flight MCP progress notification, so a silent/stuck request remains
    # eligible for the existing stall kill ladder.
    local mcp_activity_size=0
    if [[ -n "${TFX_CODEX_MCP_ACTIVITY_FILE:-}" && -f "$TFX_CODEX_MCP_ACTIVITY_FILE" ]]; then
      mcp_activity_size=$(wc -c < "$TFX_CODEX_MCP_ACTIVITY_FILE" 2>/dev/null || echo 0)
    fi
    mcp_activity_size="${mcp_activity_size//[[:space:]]/}"
    [[ "$mcp_activity_size" =~ ^[0-9]+$ ]] || mcp_activity_size=0
    current_size=$((current_size + stderr_size + codex_rollout_size + mcp_activity_size))
    local elapsed=$(($(date +%s) - TIMESTAMP))
    local expected_suffix=""
    if [[ -n "$expected_duration" && "$expected_duration" =~ ^[0-9]+$ && "$expected_duration" -gt 0 ]]; then
      expected_suffix=" expected=${expected_duration}s"
      if [[ "$elapsed" -gt $((expected_duration * 2)) ]]; then
        expected_suffix="${expected_suffix} anomaly=slow"
      fi
    fi

    if [[ "$current_size" -gt "$last_size" ]]; then
      stall_count=0
      if [[ "$pid_gone" == "true" ]]; then
        local _fi="forked"; [[ -n "$last_known_forks" ]] && _fi="forks:${last_known_forks// /,}"
        echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=active(${_fi})" >&2
        post_exit_checks=0  # reset — still producing output
      else
        echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=active" >&2
      fi
    else
      stall_count=$((stall_count + interval))
      local probe_state=""
      probe_state="$(read_probe_state "$pid" 2>/dev/null || true)"
      if [[ "$pid_gone" == "true" ]]; then
        if [[ -n "$last_known_forks" ]]; then
          # Direct fork tracking — terminate when all forks are dead
          local _alive=false
          for _fp in $last_known_forks; do
            kill -0 "$_fp" 2>/dev/null && _alive=true && break
          done
          if [[ "$_alive" == "false" ]]; then
            echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=terminated(forks-exited)" >&2
            break
          fi
          echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=fork-idle(${last_known_forks// /,})" >&2
        else
          # Fallback: output-based drain (no fork PIDs found)
          post_exit_checks=$((post_exit_checks + 1))
          if [[ "$post_exit_checks" -ge "$max_post_exit_checks" ]]; then
            echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=terminated(drain-done)" >&2
            break
          fi
          echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=draining(${post_exit_checks}/${max_post_exit_checks})" >&2
        fi
      elif [[ "$probe_state" =~ ^(mcp_initializing|input_wait)$ ]]; then
        stall_count=0
        echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=${probe_state}(probe-grace)" >&2
      elif [[ "$stall_count" -ge "$stall_threshold" ]]; then
        # 외곽 timeout이 hard ceiling으로 이동했으므로 기본 stall 방어는 kill이다.
        # intervene는 bridge의 4단 개입 사다리를 실행하고, 실패하면 아래 kill 블록으로 간다.
        local kill_on_stall="${TFX_STALL_KILL:-kill}"
        [[ -z "$kill_on_stall" ]] && kill_on_stall="kill"
        local kill_grace="${TFX_STALL_KILL_GRACE:-30}"
        local _should_kill=0 _should_intervene=0
        case "$kill_on_stall" in
          1|on|kill) _should_kill=1 ;;
          intervene|ladder) _should_intervene=1 ;;
          classify|0|off|disabled) ;;
          *)
            echo "[tfx-heartbeat] pid=$pid warning TFX_STALL_KILL=$kill_on_stall unknown, fallback classify" >&2
            kill_on_stall="classify"
            ;;
        esac
        if [[ "$_should_intervene" -eq 1 ]]; then
          local _bridge_script="" _intervene_payload="" _rollout_file="${TFX_CODEX_ROLLOUT_FILE:-}"
          if declare -f resolve_bridge_script >/dev/null 2>&1; then
            _bridge_script="$(resolve_bridge_script 2>/dev/null || true)"
          fi
          if [[ -n "$_bridge_script" && -f "$_bridge_script" ]] && command -v "${NODE_BIN:-node}" >/dev/null 2>&1; then
            _intervene_payload="$("${NODE_BIN:-node}" -e '
const [pid, stdoutLog, stderrLog, rolloutFile, cli, codexHome] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  channel: "process", pid: Number(pid), stdoutLog, stderrLog,
  rolloutFile: rolloutFile || null, cli: cli || undefined, codexHome: codexHome || undefined,
}));
' "$pid" "$STDOUT_LOG" "$STDERR_LOG" "$_rollout_file" "${CLI_TYPE:-}" "${CODEX_HOME:-${TFX_CODEX_HOME:-}}")" || _intervene_payload=""
            echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=STALL_INTERVENE stall=${stall_count}s" >&2
            if [[ -n "$_intervene_payload" ]] && printf '%s\n' "$_intervene_payload" | "${NODE_BIN:-node}" "$_bridge_script" intervene-run --payload-file -; then
              stall_count=0
              last_size=$current_size
              continue
            fi
          fi
          echo "[tfx-heartbeat] pid=$pid intervention 실패 — SIGTERM→SIGKILL fallback으로 진행" >&2
          _should_kill=1
          # intervene 실패는 바로 기존 kill ladder를 실행한다.
          stall_count=$((stall_threshold + kill_grace))
        fi
        if [[ "$_should_kill" -eq 1 && "$stall_count" -ge $((stall_threshold + kill_grace)) ]]; then
          echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=STALL_KILL stall=${stall_count}s — SIGTERM" >&2
          # Snapshot child PIDs before SIGTERM — wrapper 가 SIGTERM 을 수용해 죽으면
          # 부모 소멸 후 taskkill /T 가 자식 트리를 탐색하지 못해 codex 자식이 orphan 으로 남는다.
          # 사용자 보고(2026-04-22): "tfx-route 래퍼 exit 이후에도 Codex 자식이 살아있음".
          local _stall_children
          _stall_children=$(_find_fork_pids "$pid" 2>/dev/null || echo "")
          kill -TERM "$pid" 2>/dev/null || true
          local _grace_waited=0
          while kill -0 "$pid" 2>/dev/null && [[ "$_grace_waited" -lt 5 ]]; do
            sleep 1
            _grace_waited=$((_grace_waited + 1))
          done
          if kill -0 "$pid" 2>/dev/null; then
            # Windows/MSYS: POSIX SIGKILL 이 Win32 자식 트리까지 닿지 않는다.
            # cleanup_workers 와 동일하게 taskkill /T /F 로 트리 종료.
            case "$(uname -s)" in
              MINGW*|MSYS*)
                echo "[tfx-heartbeat] pid=$pid SIGTERM 무시 — taskkill /T /F" >&2
                MSYS_NO_PATHCONV=1 cmd.exe //c "taskkill /T /F /PID $pid" 2>/dev/null || true ;;
              *)
                echo "[tfx-heartbeat] pid=$pid SIGTERM 무시 — SIGKILL 강제" >&2
                kill -KILL "$pid" 2>/dev/null || true ;;
            esac
          fi
          # Orphan sweep: wrapper 가 SIGTERM 을 수용해도 자식 codex 프로세스는 별도
          # Win32 process 이므로 자동 종료되지 않는다. 스냅샷 PID 중 살아있는 것만 tree kill.
          if [[ -n "$_stall_children" ]]; then
            local _orphan_alive=""
            local _cpid
            for _cpid in $_stall_children; do
              kill -0 "$_cpid" 2>/dev/null && _orphan_alive="$_orphan_alive $_cpid"
            done
            if [[ -n "$_orphan_alive" ]]; then
              echo "[tfx-heartbeat] pid=$pid orphan children detected:$_orphan_alive — tree kill" >&2
              case "$(uname -s)" in
                MINGW*|MSYS*)
                  for _cpid in $_orphan_alive; do
                    MSYS_NO_PATHCONV=1 cmd.exe //c "taskkill /T /F /PID $_cpid" 2>/dev/null || true
                  done ;;
                *)
                  for _cpid in $_orphan_alive; do
                    kill -KILL "$_cpid" 2>/dev/null || true
                  done ;;
              esac
            fi
          fi
          break
        fi
        if [[ "$kill_on_stall" == "classify" && "$stall_count" -ge $((stall_threshold + kill_grace)) ]]; then
          echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=STALL_CLASSIFY stall=${stall_count}s (no-kill — TFX_STALL_KILL=classify)" >&2
        fi
        echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=STALL stall=${stall_count}s" >&2
      else
        echo "[tfx-heartbeat] pid=$pid elapsed=${elapsed}s output=${current_size}B${expected_suffix} status=quiet stall=${stall_count}s" >&2
      fi
    fi
    last_size=$current_size
  done
  echo "[tfx-heartbeat] pid=$pid terminated" >&2
}

# _wait_with_heartbeat PID — track + heartbeat + wait + cleanup
_wait_with_heartbeat() {
  local wpid="$1" hb_pid ec=0
  track_worker_pid "$wpid"
  if [[ -t 2 ]]; then
    heartbeat_monitor "$wpid" &
  else
    # < /dev/null 은 git bash sleep 자식의 caller pipe 점유를 막는 핵심 (1b31a63).
    # stderr redirect 는 의도치 않게 caller heartbeat 를 STDERR_LOG 로 흡수했으므로 제거.
    heartbeat_monitor "$wpid" < /dev/null &
  fi
  hb_pid=$!
  wait "$wpid" || ec=$?
  kill "$hb_pid" 2>/dev/null; wait "$hb_pid" 2>/dev/null
  return "$ec"
}

# Inert self-test surface for unit tests. Bypasses CLI dispatch.
if [[ "${1:-}" == "--inert-self-test" ]]; then
  shift
  case "${1:-}" in
    heartbeat-3s)
      sleep 3 &
      _wait_with_heartbeat $! 1
      exit 0
      ;;
    *)
      echo "[tfx-route] unknown self-test target: ${1:-<empty>}" >&2
      exit 2
      ;;
  esac
fi

resolve_worker_runner_script() {
  _resolve_script "${TFX_ROUTE_WORKER_RUNNER:-}" "$(_get_script_dir)/tfx-route-worker.mjs"
}

run_stream_worker() {
  local worker_type="$1"
  local prompt="$2"
  local use_tee_flag="$3"
  shift 3
  local exit_code_local=0
  local worker_pid

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
    "--timeout-ms" "$((HARD_CEILING_SEC * 1000))"
    "--stall-ms" "$((STALL_THRESHOLD_SEC * 1000))"
    "--cwd" "$PWD"
    "$@"
  )

  if [[ "$use_tee_flag" == "true" ]]; then
    printf '%s' "$prompt" | "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "${worker_cmd[@]}" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    printf '%s' "$prompt" | "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "${worker_cmd[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  worker_pid=$!
  _wait_with_heartbeat "$worker_pid" || exit_code_local=$?
  return "$exit_code_local"
}

run_antigravity_exec() {
  local prompt="$1"
  local use_tee_flag="$2"
  local exit_code_local=0
  local worker_pid
  local -a agy_args=()
  read -r -a agy_args <<< "$CLI_ARGS"

  # ── 프로필 기반 모델 주입 ──
  # display name 에 공백/괄호가 있으므로(예: "Gemini 3.5 Flash (Medium)") CLI_ARGS
  # 문자열이 아니라 agy_args 배열에 두 원소(--model, <display name>)로 append 해야
  # "${agy_args[@]}" expand 시 단일 인자로 보존된다. 모델 SSOT 는 프로필 설정이다.
  if [[ -z "${TFX_GEMINI_NO_MODEL:-}" ]]; then
    local _agy_model
    _agy_model="$(resolve_gemini_profile "${TFX_GEMINI_PROFILE:-${GEMINI_PROFILE:-flash35}}")"
    if [[ -n "$_agy_model" ]]; then
      agy_args+=("--model" "$_agy_model")
    fi
  fi

  if ! agy_supports_headless "$CLI_CMD"; then
    echo "[tfx-route] Antigravity CLI headless flags unsupported or missing: $CLI_CMD" >"$STDERR_LOG"
    return 127
  fi

  if [[ "$use_tee_flag" == "true" ]]; then
    printf '%s' "$prompt" | "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$CLI_CMD" "${agy_args[@]}" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    printf '%s' "$prompt" | "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$CLI_CMD" "${agy_args[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  worker_pid=$!
  if [[ -n "${JOB_DIR:-}" && -w "${JOB_DIR}" ]]; then
    echo "$worker_pid" >> "$JOB_DIR/child_pids"
  fi
  _wait_with_heartbeat "$worker_pid" || exit_code_local=$?
  return "$exit_code_local"
}

resolve_codex_mcp_script() {
  local sd; sd="$(_get_script_dir)"
  _resolve_script "${TFX_CODEX_MCP_SCRIPT:-}" \
    ${TFX_PKG_ROOT:+"$TFX_PKG_ROOT/hub/workers/codex-mcp.mjs"} \
    "$sd/hub/workers/codex-mcp.mjs" "$sd/../hub/workers/codex-mcp.mjs"
}

## ── MCP Preflight: dead 서버 감지 후 CODEX_CONFIG_FLAGS 에서 제거 ──
# Session 18 체크포인트 P3 root-cause fix. dead MCP 가 allowed_pat 에 포함되면
# _codex_config_swap 이 section 을 유지 → Codex 가 init 시도 → -32000 으로 죽는다.
# Preflight 가 각 서버를 probe (initialize 요청) 한 뒤 응답 없는 서버의
# enabled=true 플래그를 제거해서 swap 이 그 section 을 자동으로 drop 하게 만든다.
# Opt-out: TFX_MCP_HEALTH_CHECK=0
_mcp_preflight_filter_dead() {
  local opt="${TFX_MCP_HEALTH_CHECK:-1}"
  if [[ "$opt" == "0" || "$opt" == "false" || "$opt" == "off" ]]; then
    return 0
  fi
  if [[ "${#CODEX_CONFIG_FLAGS[@]}" -eq 0 ]]; then
    return 0
  fi

  local sd; sd="$(_get_script_dir)"
  local health_script
  health_script="$(_resolve_script "${TFX_MCP_HEALTH_SCRIPT:-}" \
    ${TFX_PKG_ROOT:+"$TFX_PKG_ROOT/scripts/lib/mcp-health.mjs"} \
    "$sd/lib/mcp-health.mjs" "$sd/../scripts/lib/mcp-health.mjs")" || return 0
  [[ -n "$health_script" && -f "$health_script" ]] || return 0
  command -v "$NODE_BIN" &>/dev/null || return 0

  # CODEX_CONFIG_FLAGS 에서 enabled=true 항목으로부터 후보 서버 이름 수집.
  # #153: parseMcpServersFromToml 은 section 이름에 dot 을 허용 (`[a-zA-Z0-9_.-]+`).
  # `[mcp_servers.foo.bar]` 같은 dotted 서버가 `mcp_servers.foo.bar.enabled=true`
  # 플래그로 전달될 때 과거 `[^.]+` 정규식은 `foo` 만 captur 해 suffix 매치 실패
  # → dotted 서버가 preflight candidate 에서 통째로 누락됐다. `\.enabled=true$`
  # 로 끝 anchor 가 고정돼 있어 `(.+)` greedy 가 반복 보장한다.
  local names=""
  local i=0
  local n="${#CODEX_CONFIG_FLAGS[@]}"
  while (( i < n )); do
    local flag="${CODEX_CONFIG_FLAGS[$i]}"
    if [[ "$flag" == "-c" ]] && (( i + 1 < n )); then
      local value="${CODEX_CONFIG_FLAGS[$((i+1))]}"
      if [[ "$value" =~ ^mcp_servers\.(.+)\.enabled=true$ ]]; then
        [[ -n "$names" ]] && names="${names},"
        names="${names}${BASH_REMATCH[1]}"
      fi
      i=$((i+2))
    else
      i=$((i+1))
    fi
  done
  [[ -z "$names" ]] && return 0

  # Probe — TTL cache 로 재호출 부하 억제
  local probe_output
  if ! probe_output=$("$NODE_BIN" "$health_script" probe \
      --names "$names" --format shell < /dev/null 2>/dev/null); then
    echo "[tfx-route] MCP preflight probe 실패 — 스킵" >&2
    return 0
  fi

  local dead_list=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^MCP_DEAD=\"(.*)\"$ ]]; then
      dead_list="${BASH_REMATCH[1]}"
    fi
  done <<< "$probe_output"
  [[ -z "$dead_list" ]] && return 0

  # dead 서버의 모든 mcp_servers.<dead>.* override 를 CODEX_CONFIG_FLAGS 에서 제거
  local -a dead_names=()
  IFS=',' read -ra dead_names <<< "$dead_list"
  local -a new_flags=()
  i=0
  while (( i < n )); do
    local flag="${CODEX_CONFIG_FLAGS[$i]}"
    if [[ "$flag" == "-c" ]] && (( i + 1 < n )); then
      local value="${CODEX_CONFIG_FLAGS[$((i+1))]}"
      local drop=false
      local dead
      for dead in "${dead_names[@]}"; do
        [[ -z "$dead" ]] && continue
        if [[ "$value" == "mcp_servers.${dead}."* ]]; then
          drop=true
          break
        fi
      done
      if [[ "$drop" == "false" ]]; then
        new_flags+=("-c" "$value")
      fi
      i=$((i+2))
    else
      new_flags+=("$flag")
      i=$((i+1))
    fi
  done

  CODEX_CONFIG_FLAGS=("${new_flags[@]}")
  echo "[tfx-route] MCP preflight: ${#dead_names[@]}개 dead MCP 제외 (${dead_list})" >&2

  # #170 graceful degradation (회귀 fix):
  # all-dead 시 default 는 exec mode 자동 fallback. TFX_MCP_FAIL_ON_ALL_DEAD=1 로
  # 명시 opt-in 시만 #148 기존 동작 (early fail). TFX_MCP_ALLOW_ALL_DEAD=1 은 호환성
  # 유지 (alias for graceful default). 단 transport 가 auto 인 채로 run_codex_mcp 를
  # 호출하면 dead MCP 와 connect 시도 → stall → 본 fix 의 _TFX_MCP_DEGRADED=1 marker
  # 가 호출자 에서 transport=exec 강제 + MCP_HINT 자동 주입 skip 을 유발한다.
  local remaining_alive=0
  local rflag
  for rflag in "${CODEX_CONFIG_FLAGS[@]}"; do
    # #153 + #170 P1: candidate 추출 정규식 (line 1607) 과 일관 — dotted server 이름
    # (e.g. mcp_servers.foo.bar.enabled=true) 도 alive 로 카운트한다. `[^.]+` 는 첫 dot
    # 에서 끊겨 dotted alive 만 남은 경우 false all-dead 판정 → 불필요 degraded.
    if [[ "$rflag" =~ ^mcp_servers\..+\.enabled=true$ ]]; then
      remaining_alive=$((remaining_alive + 1))
    fi
  done

  if [[ "$remaining_alive" -eq 0 ]]; then
    if [[ "${TFX_MCP_FAIL_ON_ALL_DEAD:-0}" == "1" ]]; then
      echo "[tfx-route] 조기 실패: TFX_MCP_FAIL_ON_ALL_DEAD=1 + MCP 전부 dead — Codex 호출 중단" >&2
      echo "  복구: (1) dead MCP 복구 (2) TFX_MCP_HEALTH_CHECK=0 preflight 비활성 (3) TFX_MCP_FAIL_ON_ALL_DEAD=0 graceful degradation" >&2
      return 78
    fi
    export _TFX_MCP_DEGRADED=1
    echo "[tfx-route] graceful degradation: MCP 전부 dead → exec mode 자동 전환 (set TFX_MCP_FAIL_ON_ALL_DEAD=1 to revert to early-fail)" >&2
    return 0
  fi
}

## ── Config Swap: 프로필별 MCP 서버 필터링 ──
# codex exec는 -c flag로 MCP enabled/disabled를 제어할 수 없다.
# config.toml을 원자적으로 교체하여 불필요한 서버 시작을 방지한다.
_codex_config_swap() {
  local action="$1"  # "filter" or "restore"
  local config="$_CODEX_CONFIG"
  local backup="${config}.pre-exec"

  if [[ "$action" == "filter" && -f "$config" ]]; then
    # MCP 프로필에서 허용된 서버 목록 추출
    local allowed_pat=""
    for flag in "${CODEX_CONFIG_FLAGS[@]}"; do
      if [[ "$flag" =~ mcp_servers\.([^.]+)\.enabled=true ]]; then
        [[ -n "$allowed_pat" ]] && allowed_pat="${allowed_pat}|"
        allowed_pat="${allowed_pat}${BASH_REMATCH[1]}"
      fi
    done

    # BUG-H (#132) fail-safe: allowed_pat 이 비면 swap 스킵.
    # 과거에는 awk 가 keep="" 에서 모든 [mcp_servers.*] 섹션을 제거하고
    # restore 시 Windows mv 실패 → config.toml 영구 손상이 재발했다.
    # 비허용 서버 비활성화는 mcp-filter.mjs 의 enabled=false override 가 담당한다.
    if [[ -z "$allowed_pat" ]]; then
      echo "[tfx-route] config.toml swap 스킵: 허용 서버 패턴 없음 (fail-safe)" >&2
      return 0
    fi

    # Pre-validation: config.toml이 500 bytes 미만이면 이미 손상된 상태일 수 있음 — 스킵
    local config_size
    config_size=$(wc -c < "$config" 2>/dev/null | tr -d ' ') || config_size=0
    if [[ "$config_size" -lt 500 && "${TFX_ALLOW_SMALL_CODEX_CONFIG:-0}" != "1" ]]; then
      echo "[tfx-route] 경고: config.toml 크기 ${config_size} bytes — 손상 의심, swap 스킵 (수동 확인 필요)" >&2
      return 0
    fi

    # 백업 생성 (이미 있으면 다른 워커가 swap 중 — 단, owner-dead + 백업 안전 복원 시 이어받기)
    if [[ -f "$backup" ]]; then
      # Owner PID marker (P1 fix): mtime 만으로 stale 을 판정하면 장시간 정상 실행 워커도 오탐.
      # $backup.owner 에 생성 워커 PID 기록 → kill -0 로 alive 확인. PID 파일 없거나 죽었으면 stale.
      # mtime 은 신뢰성 낮아 soft 보조 지표로만 사용 (owner 파일 유실 대비 fallback).
      local owner_file="${backup}.owner"
      local owner_alive=false
      local owner_pid=""
      if [[ -f "$owner_file" ]]; then
        owner_pid=$(cat "$owner_file" 2>/dev/null | tr -d '[:space:]')
        if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null; then
          owner_alive=true
        fi
      fi

      if [[ "$owner_alive" == "true" ]]; then
        echo "[tfx-route] config.toml swap 스킵: 소유 워커 살아있음 (pid=$owner_pid, $backup)" >&2
        return 0
      fi

      # Owner dead or unknown — stale 후보. 다만 backup-loss 방지를 위해 원본 복원 먼저.
      # P2 fix: `rm -f $backup` 후 현재 config 를 새 backup 으로 cp 하면, 이전 워커가 이미
      # filter 한 상태에서 crash 했을 때 원본이 영구 소실. 여기서 먼저 restore 를 시도해
      # backup 이 원본을 담고 있는 한 그것을 살린다.
      local backup_restore_guard_size
      backup_restore_guard_size=$(wc -c < "$backup" 2>/dev/null | tr -d ' ') || backup_restore_guard_size=0
      if [[ "$backup_restore_guard_size" -lt 500 && "${TFX_ALLOW_SMALL_CODEX_CONFIG:-0}" != "1" ]]; then
        # 작은 backup 은 이미 손상된 state. 현재 config 도 필터된 상태일 수 있으므로
        # 추가 swap 은 상황을 악화시킬 위험. 전체 스킵하고 수동 확인 유도.
        echo "[tfx-route] stale backup 작음 (size=${backup_restore_guard_size}B, pid=${owner_pid:-?} dead) — swap 스킵, 수동 확인: $backup" >&2
        return 0
      fi
      local stale_tmp="${config}.stale-restore.$$"
      if cp "$backup" "$stale_tmp" && mv "$stale_tmp" "$config"; then
        echo "[tfx-route] stale backup 감지 (pid=${owner_pid:-?} dead) — 원본 복원 후 swap 재진행" >&2
        if declare -f _sanitize_codex_legacy_profiles >/dev/null 2>&1; then
          _sanitize_codex_legacy_profiles "$config"
        fi
      else
        echo "[tfx-route] 경고: stale backup 복원 실패, swap 스킵 (수동 확인: $backup)" >&2
        rm -f "$stale_tmp" 2>/dev/null
        return 0
      fi
      rm -f "$backup" "$owner_file" 2>/dev/null || true
    fi
    cp "$config" "$backup"
    # Owner marker: 이 워커가 backup 소유자임을 기록. 다음 워커의 stale detection 기준.
    echo "$$" > "${backup}.owner" 2>/dev/null || true

    # awk로 필터링: 비허용 MCP 서버 섹션 제거, 나머지 그대로 유지.
    # keep="" 은 진입 가드에서 return 됐지만 defense-in-depth 유지.
    local tmp_filtered="${config}.filter.$$"
    awk -v keep="$allowed_pat" '
      BEGIN { skip=0 }
      /^\[mcp_servers\./ {
        if (keep == "") { skip=0; print; next }
        name=$0; gsub(/^\[mcp_servers\./, "", name); gsub(/[\].].*/, "", name)
        if (name !~ "^(" keep ")$") { skip=1; next }
        else { skip=0 }
      }
      /^\[/ && !/^\[mcp_servers\./ { skip=0 }
      !skip { print }
    ' "$backup" > "$tmp_filtered"

    # Output sanity check: 필터 결과가 비었거나 백업의 30% 미만이면 적용 거부
    local filtered_size backup_size threshold
    filtered_size=$(wc -c < "$tmp_filtered" 2>/dev/null | tr -d ' ') || filtered_size=0
    backup_size=$(wc -c < "$backup" 2>/dev/null | tr -d ' ') || backup_size=1
    threshold=$(( backup_size * 30 / 100 ))
    if [[ ( "$filtered_size" -eq 0 || "$filtered_size" -lt "$threshold" ) && "${TFX_ALLOW_SMALL_CODEX_CONFIG:-0}" != "1" ]]; then
      echo "[tfx-route] 경고: 필터 결과 크기 ${filtered_size} bytes (백업 ${backup_size} bytes의 30% 미만) — 적용 거부, 백업에서 복원" >&2
      rm -f "$tmp_filtered" 2>/dev/null
      rm -f "$backup" 2>/dev/null
      return 1
    fi

    # 검증 통과 — atomic rename으로 적용
    if ! mv "$tmp_filtered" "$config"; then
      echo "[tfx-route] 경고: 필터 결과 적용 실패 (atomic rename), 백업 보존: $backup" >&2
      rm -f "$tmp_filtered" 2>/dev/null
      return 1
    fi

    local kept
    kept=$(echo "$allowed_pat" | tr '|' '\n' | wc -l | tr -d ' ')
    echo "[tfx-route] config.toml swap: ${kept}개 MCP 서버만 활성" >&2

  elif [[ "$action" == "restore" && -f "$backup" ]]; then
    # BUG-H (#132) atomic rename: cp→tmp→mv 로 중간 실패 시 config 손상 방지.
    # `cat > $config` 는 cat 실행 전에 dest 가 truncate 되어 mid-stream 실패 시
    # 빈/부분 파일이 남는다. 같은 디렉토리 내 mv 는 POSIX 상 atomic 이므로
    # 실패해도 기존 config 와 backup 모두 보존된다.

    # Restore sanity check: 백업 자체가 비었거나 500 bytes 미만이면 복원 중단
    local backup_restore_size
    backup_restore_size=$(wc -c < "$backup" 2>/dev/null | tr -d ' ') || backup_restore_size=0
    if [[ "$backup_restore_size" -lt 500 && "${TFX_ALLOW_SMALL_CODEX_CONFIG:-0}" != "1" ]]; then
      echo "[tfx-route] 경고: backup 크기 ${backup_restore_size} bytes — 손상 의심, 복원 중단. 수동 확인 필요: $backup" >&2
      return 1
    fi

    local tmp="${config}.restore.$$"
    if ! cp "$backup" "$tmp"; then
      echo "[tfx-route] 경고: config.toml 복원 실패 (temp copy). backup 보존: $backup" >&2
      rm -f "$tmp" 2>/dev/null
      return 1
    fi
    if ! mv "$tmp" "$config"; then
      echo "[tfx-route] 경고: config.toml 복원 실패 (atomic rename). backup 보존: $backup" >&2
      rm -f "$tmp" 2>/dev/null
      return 1
    fi
    if ! rm -f "$backup"; then
      echo "[tfx-route] 경고: backup 삭제 실패: $backup (수동 정리 필요)" >&2
    fi
    rm -f "${backup}.owner" 2>/dev/null || true
    if declare -f _sanitize_codex_legacy_profiles >/dev/null 2>&1; then
      _sanitize_codex_legacy_profiles "$config"
    fi
    echo "[tfx-route] config.toml 복원 완료" >&2
  fi
}

# codex-recovery.sh 의 recover_codex_stdout 헬퍼 사용. STDOUT_LOG/STDERR_LOG env.
_TFX_ROUTE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$_TFX_ROUTE_DIR/lib/codex-recovery.sh" ]]; then
  # shellcheck source=lib/codex-recovery.sh
  source "$_TFX_ROUTE_DIR/lib/codex-recovery.sh"
else
  echo "[tfx-route] WARNING: optional helper missing: $_TFX_ROUTE_DIR/lib/codex-recovery.sh (run: tfx doctor --fix)" >&2
fi

run_codex_exec() {
  local prompt="$1"
  local use_tee_flag="$2"
  local exit_code_local=0
  local worker_pid
  local -a codex_args=()
  read -r -a codex_args <<< "$CLI_ARGS"
  # -c flags는 codex exec에서 MCP enabled 제어 불가 — config swap으로 대체
  # config swap은 codex 블록 최상단(_codex_config_swap "filter")에서 실행됨

  _attempt_codex_run() {
    exit_code_local=0
    # `--` end-of-options: prompt가 '--'/'---' (front-matter 등)로 시작하면
    # clap이 flag로 파싱하는 것을 방지. fallback path에서 특히 중요.
    if [[ "$use_tee_flag" == "true" ]]; then
      if [[ "$CLI_TYPE" == "antigravity" ]]; then
        # agy --print + skip-permissions positional prompt는 timeout이 재현되어 stdin pipe로 고정한다.
        printf '%s' "$prompt" | "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$CLI_CMD" "${codex_args[@]}" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
      else
        "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$CLI_CMD" "${codex_args[@]}" -- "$prompt" < /dev/null 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
      fi
    else
      if [[ "$CLI_TYPE" == "antigravity" ]]; then
        printf '%s' "$prompt" | "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$CLI_CMD" "${codex_args[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
      else
        "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$CLI_CMD" "${codex_args[@]}" -- "$prompt" < /dev/null >"$STDOUT_LOG" 2>"$STDERR_LOG" &
      fi
    fi
    worker_pid=$!
    # Track codex child PID so --job-status can detect orphan-running when wrapper dies (Issue #176).
    if [[ -n "${JOB_DIR:-}" && -w "${JOB_DIR}" ]]; then
      echo "$worker_pid" >> "$JOB_DIR/child_pids"
    fi
    _wait_with_heartbeat "$worker_pid" || exit_code_local=$?
  }

  _attempt_codex_run

  # Tier-fallback: ChatGPT account가 높은 reasoning profile을 거부하면
  # GPT-5.6 family low로만 1회 재시도한다. 구형 gpt-5.4 계열로는 더 이상 다운그레이드하지 않는다.
  # 출처: Issue #211 — codex CLI tier-aware fallback.
  if [[ "$exit_code_local" -ne 0 ]] && grep -qE "is not supported when using Codex with a ChatGPT account" "$STDERR_LOG" 2>/dev/null; then
    local fallback_profile=""
    case "$CLI_EFFORT" in
      gpt56_sol_ultra|gpt56_sol_max|gpt56_sol_xhigh|gpt56_terra_high|gpt56_terra_med) fallback_profile="gpt56_luna_low" ;;
    esac
    if [[ -n "$fallback_profile" ]]; then
      echo "[tfx-route] tier fallback: $CLI_EFFORT not supported on ChatGPT account → retry with $fallback_profile" >&2
      local -a new_args=()
      local i arg next_arg
      for ((i = 0; i < ${#codex_args[@]}; i++)); do
        arg="${codex_args[$i]}"
        next_arg="${codex_args[$((i + 1))]:-}"
        if [[ "$arg" == "--profile" ]]; then
          new_args+=("$arg" "$fallback_profile")
          i=$((i + 1))
        elif [[ "$arg" == --profile=* ]]; then
          new_args+=("--profile=$fallback_profile")
        elif [[ "$arg" == "-c" && ( "$next_arg" == model=* || "$next_arg" == model_reasoning_effort=* ) ]]; then
          i=$((i + 1))
        else
          new_args+=("$arg")
        fi
      done
      codex_args=("${new_args[@]}")
      CLI_EFFORT="$fallback_profile"
      _attempt_codex_run
    fi
  fi

  recover_codex_stdout

  return "$exit_code_local"
}

run_codex_mcp() {
  local prompt="$1"
  local use_tee_flag="$2"
  local mcp_script
  local exit_code_local=0
  local worker_pid
  local mcp_activity_file="${TFX_TMP}/tfx-route-${AGENT_TYPE}-${RUN_ID}-mcp-activity.log"

  if ! mcp_script=$(resolve_codex_mcp_script); then
    echo "[tfx-route] 경고: Codex MCP 래퍼를 찾지 못했습니다." >&2
    return "$CODEX_MCP_TRANSPORT_EXIT_CODE"
  fi

  if ! command -v "$NODE_BIN" &>/dev/null; then
    echo "[tfx-route] 경고: node를 찾지 못해 Codex MCP 경로를 사용할 수 없습니다." >&2
    return "$CODEX_MCP_TRANSPORT_EXIT_CODE"
  fi

  : > "$mcp_activity_file"
  export TFX_CODEX_MCP_ACTIVITY_FILE="$mcp_activity_file"

  local -a mcp_args=(
    "$mcp_script"
    "--prompt" "$prompt"
    "--cwd" "$PWD"
    "--profile" "$CLI_EFFORT"
    "--approval-policy" "never"
    "--sandbox" "danger-full-access"
    "--timeout-ms" "$((HARD_CEILING_SEC * 1000))"
    "--codex-command" "$CODEX_BIN"
  )

  if [[ -n "${CODEX_MODEL_OVERRIDE:-}" ]]; then
    mcp_args+=("--model" "$CODEX_MODEL_OVERRIDE")
  fi
  if [[ -n "${CODEX_REASONING_EFFORT_OVERRIDE:-}" ]]; then
    mcp_args+=("--reasoning-effort" "$CODEX_REASONING_EFFORT_OVERRIDE")
  fi

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
    "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$NODE_BIN" "${mcp_args[@]}" < /dev/null 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    "${TIMEOUT_CMD[@]}" "$HARD_CEILING_SEC" "$NODE_BIN" "${mcp_args[@]}" < /dev/null >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  worker_pid=$!
  # Track codex MCP child PID so --job-status can detect orphan-running when wrapper dies (Issue #176).
  if [[ -n "${JOB_DIR:-}" && -w "${JOB_DIR}" ]]; then
    echo "$worker_pid" >> "$JOB_DIR/child_pids"
  fi
  _wait_with_heartbeat "$worker_pid" || exit_code_local=$?
  unset TFX_CODEX_MCP_ACTIVITY_FILE

  # 모듈 로드 실패(의존성 누락) → MCP transport exit code로 변환하여 fallback 트리거
  if [[ "$exit_code_local" -ne 0 && "$exit_code_local" -ne 124 ]] && grep -q 'ERR_MODULE_NOT_FOUND' "$STDERR_LOG" 2>/dev/null; then
    echo "[tfx-route] Codex MCP 모듈 로드 실패 — fallback 가능 exit code로 변환" >&2
    return "$CODEX_MCP_TRANSPORT_EXIT_CODE"
  fi

  # MCP 연결 실패(서버 미응답, 연결 종료) → transport exit code로 변환
  if [[ "$exit_code_local" -ne 0 && "$exit_code_local" -ne 124 ]] && grep -qE 'MCP error|Connection closed|연결 실패' "$STDOUT_LOG" 2>/dev/null; then
    echo "[tfx-route] Codex MCP 연결 실패 — fallback 가능 exit code로 변환" >&2
    return "$CODEX_MCP_TRANSPORT_EXIT_CODE"
  fi

  return "$exit_code_local"
}

# ── 메인 실행 ──
main() {
  # 종료 시 per-process 에이전트 파일 + 워커 프로세스 정리
  trap 'cleanup_workers' EXIT

  route_agent "$AGENT_TYPE"
  apply_cli_mode
  apply_no_claude_native_mode
  apply_plan_guard
  apply_verifier_override
  apply_dynamic_routing_override
  apply_codex_profile_override
  apply_retry_snapshot_cli_invocation
  apply_codex_concrete_effort_guard
  apply_cli_disable_policy

  # CLI 경로 해석
  case "$CLI_CMD" in
    codex) CLI_CMD="$CODEX_BIN" ;;
    gemini) CLI_CMD="$GEMINI_BIN" ;;
    agy) CLI_CMD="$AGY_BIN" ;;
    claude) CLI_CMD="$CLAUDE_BIN" ;;
  esac

  # 타임아웃 결정 (에이전트별 최소값 보장)
  local MIN_TIMEOUT
  case "$AGENT_TYPE" in
    deep-executor|architect|planner|critic|analyst) MIN_TIMEOUT=900 ;;
    document-specialist|scientist|scientist-deep) MIN_TIMEOUT=900 ;;
    code-reviewer|security-reviewer|quality-reviewer) MIN_TIMEOUT=600 ;;
    executor|debugger) MIN_TIMEOUT=300 ;;  # 기본값 300s
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

  # TIMEOUT_SEC/DEFAULT_TIMEOUT은 예상 소요 시간(advisory)만 나타낸다.
  # 실제 wall-clock 종료는 아래 hard ceiling만 수행한다.
  HARD_CEILING_SEC="${TFX_HARD_CEILING_SEC:-21600}"
  if ! [[ "$HARD_CEILING_SEC" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "[tfx-route] 경고: TFX_HARD_CEILING_SEC='$HARD_CEILING_SEC' 무효 — 21600 사용" >&2
    HARD_CEILING_SEC=21600
  fi
  if [[ "${TFX_TIMEOUT_MODE:-activity}" == "wallclock" ]]; then
    HARD_CEILING_SEC="$TIMEOUT_SEC"
  elif [[ "$HARD_CEILING_SEC" -gt 0 && "$HARD_CEILING_SEC" -lt "$TIMEOUT_SEC" ]]; then
    echo "[tfx-route] 경고: hard ceiling(${HARD_CEILING_SEC}s) < expected(${TIMEOUT_SEC}s) — expected로 승격" >&2
    HARD_CEILING_SEC="$TIMEOUT_SEC"
  fi
  if [[ "$HARD_CEILING_SEC" -eq 0 ]]; then
    TIMEOUT_CMD=("_no_timeout")
  fi
  STALL_THRESHOLD_SEC="${TFX_STALL_THRESHOLD:-1200}"
  if ! [[ "$STALL_THRESHOLD_SEC" =~ ^[1-9][0-9]*$ ]]; then
    echo "[tfx-route] 경고: TFX_STALL_THRESHOLD='$STALL_THRESHOLD_SEC' 무효 — 1200 사용" >&2
    STALL_THRESHOLD_SEC=1200
  fi

  local _est_dur
  _est_dur=$(estimate_expected_duration_sec "$AGENT_TYPE" "$MCP_PROFILE" "$PROMPT")
  [[ "$TIMEOUT_SEC" -gt "$_est_dur" ]] && _est_dur="$TIMEOUT_SEC"
  TFX_EXPECTED_DURATION_SEC="${TFX_EXPECTED_DURATION_SEC:-$_est_dur}"
  export TFX_EXPECTED_DURATION_SEC

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
      local native_model native_adapter
      native_adapter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cli-claude.mjs"
      [[ -f "$native_adapter" ]] || native_adapter="${TFX_PKG_ROOT:-}/scripts/lib/cli-claude.mjs"
      native_model=$("$NODE_BIN" -e 'import(process.argv[1]).then(({plan}) => process.stdout.write(plan({agent: process.argv[2]}).model || ""))' "$native_adapter" "$AGENT_TYPE" 2>/dev/null)
      if [[ -z "$native_model" ]]; then
        echo "ERROR: Claude native handoff model 해석 실패: $AGENT_TYPE" >&2
        exit 1
      fi
      # 팀 모드: Hub에 fallback 필요 시그널 전송 후 구조화된 출력
      echo "[tfx-route] claude-native 역할($AGENT_TYPE)은 tfx-route.sh로 실행 불가 — Claude Agent fallback 필요" >&2
      team_complete_task "fallback" "claude-native 역할 실행 불가: ${AGENT_TYPE}. Claude Task(sonnet) 에이전트로 위임하세요."
      cat <<FALLBACK_EOF
=== TFX_NEEDS_FALLBACK ===
agent_type: ${AGENT_TYPE}
reason: claude-native roles require Claude Agent tools (Read/Edit/Grep). tfx-route.sh cannot provide these.
action: Lead should spawn Agent(subagent_type="${AGENT_TYPE}", model="${native_model}") for this task.
task_id: ${TFX_TEAM_TASK_ID:-none}
FALLBACK_EOF
      exit 0
    fi
    emit_claude_native_metadata
    exit 0
  fi

  # Issue #156: hub-ensure 무조건 호출 — codex/gemini 가 tfx-hub MCP 를 쓸 수
  # 있도록 사전 보장. Claude 세션 SessionStart 훅 외부에서 (Windows 재부팅 후
  # codex 단독 실행, hub crash 후 Claude 미오픈, WSL/SSH 등) 도 hub 가 자동
  # 기동된다. hub 가 이미 alive 면 /health 1회 호출로 no-op (저비용).
  # best-effort: 실패해도 tfx-route 진행 차단하지 않음.
  if command -v "$NODE_BIN" &>/dev/null; then
    local _sd_he; _sd_he="$(_get_script_dir)"
    local _hub_ensure_script
    _hub_ensure_script="$(_resolve_script "${TFX_HUB_ENSURE_SCRIPT:-}" \
      ${TFX_PKG_ROOT:+"$TFX_PKG_ROOT/scripts/hub-ensure.mjs"} \
      "$_sd_he/hub-ensure.mjs" "$_sd_he/../scripts/hub-ensure.mjs" 2>/dev/null)" || _hub_ensure_script=""
    if [[ -n "$_hub_ensure_script" && -f "$_hub_ensure_script" ]]; then
      "$NODE_BIN" "$_hub_ensure_script" >/dev/null 2>&1 || true
    fi
  fi

  local FULL_PROMPT="$PROMPT"
  if [[ -n "$MCP_HINT" ]]; then
    FULL_PROMPT="${PROMPT}"$'\n\n'"[도구 안내] ${MCP_HINT}"
  fi
  local codex_transport_effective="n/a"

  # 메타정보 (stderr)
  echo "[tfx-route] v${VERSION} type=$CLI_TYPE agent=$AGENT_TYPE effort=$CLI_EFFORT mode=$RUN_MODE expected=${TIMEOUT_SEC}s stall=${STALL_THRESHOLD_SEC}s ceiling=${HARD_CEILING_SEC}s" >&2
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
  # recover_codex_stdout 이 복구 진입 시 1로 세운다(dynamic scope로 이 local 이 갱신됨).
  # 매 실행 초기화로 스테일 방지. 진짜 산출물 부재 판정(아래 no-op 가드)에 쓰인다.
  local CODEX_STDOUT_WAS_RECOVERED=0

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
    # Degraded is a per-invocation result, not an inherited process contract.
    # Test and wrapper environments can carry stale exported values from prior
    # route calls; clear it before the current MCP preflight decides.
    unset _TFX_MCP_DEGRADED
    # Preflight: dead MCP 감지 후 CODEX_CONFIG_FLAGS 에서 제거.
    # swap 이 allowed_pat 을 이 배열에서 계산하므로, 여기서 제거하면
    # dead section 이 config.toml 에서 자동으로 drop 된다.
    # #148: preflight 가 78 반환 시 all-dead → Codex 호출 중단 (early fail).
    local _preflight_rc=0
    _mcp_preflight_filter_dead || _preflight_rc=$?
    if [[ "$_preflight_rc" -eq 78 ]]; then
      exit 78
    fi
    # Config swap: 프로필에 맞는 MCP 서버만 남긴 임시 config 적용
    # run_codex_mcp / run_codex_exec 어느 경로든 적용되도록 최상단에서 실행
    _codex_config_swap "filter"
    # swap 후 config override 플래그 클리어 — 제거된 서버에 override 보내면 "invalid transport" 에러
    CODEX_CONFIG_FLAGS=()
    CODEX_CONFIG_JSON="{}"
    # #170 graceful degradation: MCP 전부 dead 면 transport 무관 exec 강제.
    # _mcp_preflight_filter_dead 가 _TFX_MCP_DEGRADED=1 를 export 했으면 이미 stall 보장 안 됨.
    # 사용자가 TFX_CODEX_TRANSPORT=mcp 명시했더라도 dead MCP 와 connect 시도 = stall →
    # warning + exec 강제 (transport 명시는 사용자 의도지만 stall 회피가 우선).
    # MCP_HINT (e.g. "context7으로 조회하세요") 도 prompt 에서 제거 — degraded 환경에서
    # 모델이 사용 불가 도구를 시도하면 stall/실패 trigger.
    if [[ "${_TFX_MCP_DEGRADED:-0}" == "1" ]]; then
      if [[ "$TFX_CODEX_TRANSPORT" == "mcp" ]]; then
        echo "[tfx-route] WARNING: TFX_CODEX_TRANSPORT=mcp + all-MCP-dead → exec 강제 (stall 회피)" >&2
      fi
      TFX_CODEX_TRANSPORT="exec"
      FULL_PROMPT="$PROMPT"
    fi
    local _codex_north_star_file="${WORKDIR:-$PWD}/.triflux/lake/current.md"
    if [[ -r "$_codex_north_star_file" ]]; then
      local _codex_prompt_sentinel="__TFX_CODEX_PROMPT_END_${$}_${RANDOM}__"
      local _codex_full_prompt_with_sentinel
      _codex_full_prompt_with_sentinel="$(prepend_codex_north_star "$FULL_PROMPT"; printf '%s' "$_codex_prompt_sentinel")"
      FULL_PROMPT="${_codex_full_prompt_with_sentinel%"$_codex_prompt_sentinel"}"
    fi
    # Opt-in 스킬 주입 (TFX_INJECT_SKILL). north-star 와 동일한 sentinel 패턴으로
    # trailing newline 을 보존한다. 미설정이면 prepend_skill 이 no-op.
    if [[ -n "${TFX_INJECT_SKILL:-}" ]]; then
      local _codex_skill_sentinel="__TFX_CODEX_SKILL_END_${$}_${RANDOM}__"
      local _codex_skill_prompt
      _codex_skill_prompt="$(prepend_skill "$FULL_PROMPT"; printf '%s' "$_codex_skill_sentinel")"
      FULL_PROMPT="${_codex_skill_prompt%"$_codex_skill_sentinel"}"
    fi
    codex_transport_effective="exec"
    if [[ "$TFX_CODEX_TRANSPORT" != "exec" ]]; then
      run_codex_mcp "$FULL_PROMPT" "$use_tee" || exit_code=$?
      if [[ "$exit_code" -eq 0 ]]; then
        codex_transport_effective="mcp"
      elif [[ "$exit_code" -eq "$CODEX_MCP_TRANSPORT_EXIT_CODE" && "$TFX_CODEX_TRANSPORT" == "auto" ]]; then
        # MCP bootstrap/transport failure only: retain auto's legacy exec fallback.
        echo "[tfx-route] Codex MCP 실패(exit=${exit_code}). legacy exec 경로로 fallback 시도." >&2
        local _sd
        _sd="$(_get_script_dir)"
        if [[ -f "$_sd/hub-ensure.mjs" ]]; then
          "$NODE_BIN" "$_sd/hub-ensure.mjs" >/dev/null 2>&1 || true
        fi
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
    # Config swap 복원 (성공/실패 관계없이)
    _codex_config_swap "restore"

  elif [[ "$CLI_TYPE" == "gemini" ]]; then
    # Codex degraded branch strips MCP_HINT; keep gemini parity when the marker is inherited.
    if [[ "${_TFX_MCP_DEGRADED:-0}" == "1" ]]; then
      FULL_PROMPT="$PROMPT"
    fi
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

    # ── Gemini extensions (-e) 주입 (issue #64) ──
    if [[ -n "$TFX_GEMINI_EXTENSIONS" ]]; then
      local ext
      IFS="," read -ra _gemini_exts <<< "$TFX_GEMINI_EXTENSIONS"
      for ext in "${_gemini_exts[@]}"; do
        ext=$(echo "$ext" | xargs)  # trim whitespace
        [[ -n "$ext" ]] && gemini_worker_args+=("--extra-arg" "-e" "--extra-arg" "$ext")
      done
      echo "[tfx-route] Gemini extensions: ${TFX_GEMINI_EXTENSIONS}" >&2
    fi

    # ── Gemini 추가 플래그 주입 (issue #64) ──
    if [[ -n "$TFX_GEMINI_FLAGS" ]]; then
      local flag
      read -ra _gemini_flags <<< "$TFX_GEMINI_FLAGS"
      for flag in "${_gemini_flags[@]}"; do
        [[ -n "$flag" ]] && gemini_worker_args+=("--extra-arg" "$flag")
      done
      echo "[tfx-route] Gemini extra flags: ${TFX_GEMINI_FLAGS}" >&2
    fi

    run_stream_worker "gemini" "$FULL_PROMPT" "$use_tee" "${gemini_worker_args[@]}" || exit_code=$?
    if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
      # stderr 내용을 fallback 전에 보존하여 디버깅 가능하게 함
      local gemini_stderr_bytes=0
      [[ -f "$STDERR_LOG" ]] && gemini_stderr_bytes=$(wc -c < "$STDERR_LOG" 2>/dev/null | tr -d ' ')
      echo "[tfx-route] Gemini stream wrapper 실패(exit=${exit_code}, stderr=${gemini_stderr_bytes}B). claude-native fallback." >&2
      if [[ "$gemini_stderr_bytes" -gt 0 ]]; then
        echo "[tfx-route] Gemini stderr 보존:" >&2
        tail -c 2048 "$STDERR_LOG" >&2
      fi
      cat > "$STDOUT_LOG" <<EOF
$(emit_claude_native_metadata)
EOF
      : > "$STDERR_LOG"
      exit_code=0
      CLI_TYPE="claude-native"
    fi

  elif [[ "$CLI_TYPE" == "antigravity" ]]; then
    # Codex degraded branch strips MCP_HINT; keep agy parity when the marker is inherited.
    if [[ "${_TFX_MCP_DEGRADED:-0}" == "1" ]]; then
      FULL_PROMPT="$PROMPT"
    fi
    # CTO north-star: codex lane(line ~2670)과 동일하게 brief 를 prompt 앞에 주입.
    # prepend_codex_north_star 는 CLI-agnostic (TFX_CTO_NORTH_STAR opt-out +
    # .triflux/lake/current.md 만 참조) 하므로 agy 워커에서도 그대로 재사용한다.
    # sentinel 은 command-substitution 이 trailing newline 을 삼키는 것을 막는다.
    local _agy_north_star_file="${WORKDIR:-$PWD}/.triflux/lake/current.md"
    if [[ -r "$_agy_north_star_file" ]]; then
      local _agy_prompt_sentinel="__TFX_AGY_PROMPT_END_${$}_${RANDOM}__"
      local _agy_full_prompt_with_sentinel
      _agy_full_prompt_with_sentinel="$(prepend_codex_north_star "$FULL_PROMPT"; printf '%s' "$_agy_prompt_sentinel")"
      FULL_PROMPT="${_agy_full_prompt_with_sentinel%"$_agy_prompt_sentinel"}"
    fi
    # Opt-in 스킬 주입 (TFX_INJECT_SKILL) — codex 레인과 동일.
    if [[ -n "${TFX_INJECT_SKILL:-}" ]]; then
      local _agy_skill_sentinel="__TFX_AGY_SKILL_END_${$}_${RANDOM}__"
      local _agy_skill_prompt
      _agy_skill_prompt="$(prepend_skill "$FULL_PROMPT"; printf '%s' "$_agy_skill_sentinel")"
      FULL_PROMPT="${_agy_skill_prompt%"$_agy_skill_sentinel"}"
    fi
    # agy(Gemini 3.x) anti-overclaim 규율 블록을 프롬프트 END 에 append. opt-out: TFX_AGY_ANTI_OVERCLAIM=0.
    local _agy_aoc_sentinel="__TFX_AGY_AOC_END_${$}_${RANDOM}__"
    local _agy_aoc_prompt
    _agy_aoc_prompt="$(append_agy_anti_overclaim "$FULL_PROMPT" "${WORKDIR:-$PWD}"; printf '%s' "$_agy_aoc_sentinel")"
    FULL_PROMPT="${_agy_aoc_prompt%"$_agy_aoc_sentinel"}"
    run_antigravity_exec "$FULL_PROMPT" "$use_tee" || exit_code=$?
    if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
      local agy_stderr_bytes=0
      [[ -f "$STDERR_LOG" ]] && agy_stderr_bytes=$(wc -c < "$STDERR_LOG" 2>/dev/null | tr -d ' ')
      echo "[tfx-route] Antigravity CLI 실패(exit=${exit_code}, stderr=${agy_stderr_bytes}B)." >&2
      if [[ "$agy_stderr_bytes" -gt 0 ]]; then
        echo "[tfx-route] Antigravity stderr 보존:" >&2
        tail -c 2048 "$STDERR_LOG" >&2
      fi
    fi

  elif [[ "$CLI_TYPE" == "claude" ]]; then
    local claude_model claude_effort
    claude_model=$(get_claude_model)
    claude_effort=$(get_claude_effort)
    local -a claude_worker_args=(
      "--command" "$CLI_CMD"
      "--command-args-json" "$CLAUDE_BIN_ARGS_JSON"
      "--model" "$claude_model"
      "--permission-mode" "bypassPermissions"
      "--allow-dangerously-skip-permissions"
    )
    [ -n "$claude_effort" ] && claude_worker_args+=("--effort" "$claude_effort")

    run_stream_worker "claude" "$FULL_PROMPT" "$use_tee" "${claude_worker_args[@]}" || exit_code=$?
    if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
      local claude_stderr_bytes=0
      [[ -f "$STDERR_LOG" ]] && claude_stderr_bytes=$(wc -c < "$STDERR_LOG" 2>/dev/null | tr -d ' ')
      echo "[tfx-route] Claude stream wrapper 실패(exit=${exit_code}, stderr=${claude_stderr_bytes}B). native metadata로 fallback합니다." >&2
      if [[ "$claude_stderr_bytes" -gt 0 ]]; then
        echo "[tfx-route] Claude stderr 보존:" >&2
        tail -c 2048 "$STDERR_LOG" >&2
      fi
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

    # 진짜 산출물 부재 판정 — 빈 stdout 이거나, recover_codex_stdout 이 stderr
    # 노이즈로 backfill 한 경우(복구 플래그)면 진짜 워커 출력이 아니다. 복구가
    # `! -s STDOUT_LOG` 를 무력화해 빈손 실행을 success 로 오보고하던 갭을 막는다.
    local no_genuine_output="no"
    if [[ ! -s "$STDOUT_LOG" || "${CODEX_STDOUT_WAS_RECOVERED:-0}" == "1" ]]; then
      no_genuine_output="yes"
    fi

    # MCP transport 채널이 실행 중 죽었는지(exit 0 이어도) stderr 서명으로 판정.
    local mcp_transport_crashed="no"
    if declare -F codex_stdout_transport_crashed >/dev/null 2>&1 \
       && codex_stdout_transport_crashed "$STDERR_LOG"; then
      mcp_transport_crashed="yes"
    fi

    # 승격 조건: 진짜 출력이 없고(무근거 성공) + (워크스페이스 무변화 = 완전 no-op
    # 이거나 transport 채널 사망 = 결과 신뢰 불가). antigravity 는 stdout 계약이
    # 달라 제외. 진짜 출력이 있는 성공은 no_genuine_output=no 라 절대 승격되지 않는다.
    # ★의도된 보수적 트레이드오프: codex 가 stdout 없이 stderr 로만 답을 쓰고 recover
    # 가 salvage 한 경우(no_genuine_output=yes)라도 transport 채널이 죽었으면 결과를
    # 신뢰 불가로 보고 실패로 승격한다. 채널 사망 후 salvage 는 완결 보장이 없기
    # 때문이며, 극히 드문 stdout-없는 정상완료보다 false-success 방지를 우선한다.
    if [[ "$CLI_TYPE" != "antigravity" && "$no_genuine_output" == "yes" ]] \
       && { [[ "$workspace_changed" == "no" ]] || [[ "$mcp_transport_crashed" == "yes" ]]; }; then
      printf '%s\n' "[tfx-route] exit 0 이지만 진짜 산출물이 없습니다 (recovered=${CODEX_STDOUT_WAS_RECOVERED:-0}, workspace_changed=${workspace_changed}, mcp_transport_crash=${mcp_transport_crashed}). no-op/실패 실행을 실패로 승격합니다." >> "$STDERR_LOG"
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
      team_complete_task "timeout" "하드실링/무활동 종료 (ceiling=${HARD_CEILING_SEC}s, expected=${TIMEOUT_SEC}s)"
    elif [[ "$exit_code" -eq 143 ]]; then
      team_complete_task "timeout" "외부 시그널로 종료 (SIGTERM, ceiling=${HARD_CEILING_SEC}s, expected=${TIMEOUT_SEC}s)"
    elif [[ "$exit_code" -eq 137 ]]; then
      team_complete_task "timeout" "외부 시그널로 종료 (SIGKILL, ceiling=${HARD_CEILING_SEC}s, expected=${TIMEOUT_SEC}s)"
    elif [[ "$exit_code" -eq 130 ]]; then
      team_complete_task "failed" "사용자 인터럽트 (SIGINT)"
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

  # 백그라운드 서브쉘: main 실행 → 반환 코드로 마커 기록
  # H1' 수정 (Track 3 v2): POSIX 2017 wait spec 은 subshell 환경에서
  # wait 가 즉시 리턴하도록 강제하므로 기존 데몬 블록 (wait $bg_pid; touch done)
  # 은 main 시작 전에 done 마커를 찍는 dead code 였다. main() 이 자체 EXIT
  # trap 을 설치하므로 정상 종료는 straight-line write 로 기록하고, 시그널만 trap 한다.
  echo "starting" > "$JOB_DIR/pid"
  ( set +e
    trap 'rc=$?; echo "$rc" > "$JOB_DIR/exit_code"; touch "$JOB_DIR/done"; exit "$rc"' INT TERM HUP
    exec > "$JOB_DIR/result.log" 2>"$JOB_DIR/stderr.log"
    main
    _ec=$?
    echo "$_ec" > "$JOB_DIR/exit_code"
    touch "$JOB_DIR/done"
    exit "$_ec"
  ) &
  bg_pid=$!
  echo "$bg_pid" > "$JOB_DIR/pid"
  disown "$bg_pid"          # explicit PID — H1' fix (was missing arg, disowning daemon only)

  # 즉시 리턴: 1초 이내에 Claude Code Bash 도구 완료
  echo "$JOB_ID"
  exit 0
fi

main
