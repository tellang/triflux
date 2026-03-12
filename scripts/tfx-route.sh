#!/usr/bin/env bash
# tfx-route.sh v2.2 — CLI 라우팅 래퍼 (triflux)
#
# v1.x: cli-route.sh (jq+python3+node 혼재, 동기 후처리 ~1s)
# v2.0: tfx-route.sh 리네임
#   - 후처리 전부 tfx-route-post.mjs로 이관 (node 단일 ~100ms)
#   - per-process 에이전트 등록 (race condition 구조적 제거)
#   - get_mcp_hint 통합 (캐시/비캐시 단일 코드경로)
#   - Gemini health check 지수 백오프 (30×1s → 5×exp)
#   - 컨텍스트 파일 5번째 인자 지원
#
VERSION="2.2"
#
# 사용법:
#   tfx-route.sh <agent_type> <prompt> [mcp_profile] [timeout_sec] [context_file]
#
# 예시:
#   tfx-route.sh executor "코드 구현" implement
#   tfx-route.sh architect "아키텍처 분석" analyze '' context.md

set -euo pipefail

# ── 인자 파싱 ──
AGENT_TYPE="${1:?에이전트 타입 필수 (executor, debugger, designer 등)}"
PROMPT="${2:?프롬프트 필수}"
MCP_PROFILE="${3:-auto}"
USER_TIMEOUT="${4:-}"
CONTEXT_FILE="${5:-}"

# ── CLI 경로 해석 (Windows npm global 대응) ──
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || echo codex)}"
GEMINI_BIN="${GEMINI_BIN:-$(command -v gemini 2>/dev/null || echo gemini)}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo claude)}"
GEMINI_BIN_ARGS_JSON="${GEMINI_BIN_ARGS_JSON:-[]}"
CLAUDE_BIN_ARGS_JSON="${CLAUDE_BIN_ARGS_JSON:-[]}"

# ── 상수 ──
MAX_STDOUT_BYTES=51200  # 50KB — Claude 컨텍스트 절약
TIMESTAMP=$(date +%s)
RUN_ID="${TIMESTAMP}-$$-${RANDOM}"
STDERR_LOG="/tmp/tfx-route-${AGENT_TYPE}-${RUN_ID}-stderr.log"
STDOUT_LOG="/tmp/tfx-route-${AGENT_TYPE}-${RUN_ID}-stdout.log"
TFX_TMP="${TMPDIR:-/tmp}"

# ── 팀 환경변수 ──
TFX_TEAM_NAME="${TFX_TEAM_NAME:-}"
TFX_TEAM_TASK_ID="${TFX_TEAM_TASK_ID:-}"
TFX_TEAM_AGENT_NAME="${TFX_TEAM_AGENT_NAME:-${AGENT_TYPE}-worker-$$}"
TFX_TEAM_LEAD_NAME="${TFX_TEAM_LEAD_NAME:-team-lead}"
TFX_HUB_URL="${TFX_HUB_URL:-http://127.0.0.1:27888}"

# fallback 시 원래 에이전트 정보 보존
ORIGINAL_AGENT=""
ORIGINAL_CLI_ARGS=""

# ── Per-process 에이전트 등록 (원자적, 락 불필요) ──
register_agent() {
  local agent_file="${TFX_TMP}/tfx-agent-$$.json"
  echo "{\"pid\":$$,\"cli\":\"$CLI_TYPE\",\"agent\":\"$AGENT_TYPE\",\"started\":$(date +%s)}" \
    > "$agent_file" 2>/dev/null || true
}

deregister_agent() {
  rm -f "${TFX_TMP}/tfx-agent-$$.json" 2>/dev/null || true
}

# ── 팀 Hub Bridge 통신 ──
# JSON 문자열 이스케이프 (큰따옴표, 백슬래시, 개행, 탭, CR)
json_escape() {
  local s="${1:-}"
  # node로 완전한 JSON 이스케이프 (NUL, 멀티바이트 UTF-8, 제어문자 안전)
  if command -v node &>/dev/null; then
    node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))' -- "$s"
    return
  fi
  # node 미설치 fallback: 기본 Bash 치환
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

team_claim_task() {
  [[ -z "$TFX_TEAM_NAME" || -z "$TFX_TEAM_TASK_ID" ]] && return 0
  local http_code safe_team_name safe_task_id safe_agent_name
  safe_team_name=$(json_escape "$TFX_TEAM_NAME")
  safe_task_id=$(json_escape "$TFX_TEAM_TASK_ID")
  safe_agent_name=$(json_escape "$TFX_TEAM_AGENT_NAME")

  http_code=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "${TFX_HUB_URL}/bridge/team/task-update" \
    -H "Content-Type: application/json" \
    -d "{\"team_name\":\"${safe_team_name}\",\"task_id\":\"${safe_task_id}\",\"claim\":true,\"owner\":\"${safe_agent_name}\",\"status\":\"in_progress\"}" \
    2>/dev/null) || http_code="000"

  case "$http_code" in
    200) ;; # 성공
    409)
      echo "[tfx-route] CLAIM_CONFLICT: task ${TFX_TEAM_TASK_ID}가 이미 claim됨. 실행 중단." >&2
      exit 0 ;;
    000)
      echo "[tfx-route] 경고: Hub 연결 실패 (미실행?). claim 없이 계속 실행." >&2 ;;
    *)
      echo "[tfx-route] 경고: Hub claim 응답 HTTP ${http_code}. claim 없이 계속 실행." >&2 ;;
  esac
}

team_complete_task() {
  local result="${1:-success}"            # success/failed/timeout
  local result_summary="${2:-작업 완료}"
  [[ -z "$TFX_TEAM_NAME" || -z "$TFX_TEAM_TASK_ID" ]] && return 0

  local safe_team_name safe_task_id safe_agent_name safe_result safe_summary safe_lead_name
  safe_team_name=$(json_escape "$TFX_TEAM_NAME")
  safe_task_id=$(json_escape "$TFX_TEAM_TASK_ID")
  safe_agent_name=$(json_escape "$TFX_TEAM_AGENT_NAME")
  safe_result=$(json_escape "$result")
  safe_summary=$(json_escape "$(echo "$result_summary" | head -c 4096)")
  safe_lead_name=$(json_escape "$TFX_TEAM_LEAD_NAME")

  # task 상태: 항상 "completed" (Claude Code API는 "failed" 미지원)
  # 실제 결과는 metadata.result로 전달
  curl -sf -X POST "${TFX_HUB_URL}/bridge/team/task-update" \
    -H "Content-Type: application/json" \
    -d "{\"team_name\":\"${safe_team_name}\",\"task_id\":\"${safe_task_id}\",\"status\":\"completed\",\"owner\":\"${safe_agent_name}\",\"metadata_patch\":{\"result\":\"${safe_result}\",\"summary\":\"${safe_summary}\"}}" \
    >/dev/null 2>&1 || true

  # 리드에게 메시지 전송
  curl -sf -X POST "${TFX_HUB_URL}/bridge/team/send-message" \
    -H "Content-Type: application/json" \
    -d "{\"team_name\":\"${safe_team_name}\",\"from\":\"${safe_agent_name}\",\"to\":\"${safe_lead_name}\",\"text\":\"${safe_summary}\",\"summary\":\"task ${safe_task_id} ${safe_result}\"}" \
    >/dev/null 2>&1 || true

  # Hub result 발행 (poll_messages 채널 활성화)
  curl -sf -X POST "${TFX_HUB_URL}/bridge/result" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"${safe_agent_name}\",\"topic\":\"task.result\",\"payload\":{\"task_id\":\"${safe_task_id}\",\"result\":\"${safe_result}\"},\"trace_id\":\"${safe_team_name}\"}" \
    >/dev/null 2>&1 || true
}

# ── 라우팅 테이블 ──
# 반환: CLI_CMD, CLI_ARGS, CLI_TYPE, CLI_EFFORT, DEFAULT_TIMEOUT, RUN_MODE, OPUS_OVERSIGHT
route_agent() {
  local agent="$1"
  local codex_base="--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"

  case "$agent" in
    # ─── 구현 레인 ───
    executor)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"; DEFAULT_TIMEOUT=1080; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    build-fixer)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile fast ${codex_base}"
      CLI_EFFORT="fast"; DEFAULT_TIMEOUT=540; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    debugger)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    deep-executor)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile xhigh ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;

    # ─── 설계/분석 레인 ───
    architect)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile xhigh ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    planner)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile xhigh ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="fg"; OPUS_OVERSIGHT="true" ;;
    critic)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile xhigh ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    analyst)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile xhigh ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="fg"; OPUS_OVERSIGHT="true" ;;

    # ─── 리뷰 레인 ───
    code-reviewer)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile thorough ${codex_base} review"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    security-reviewer)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile thorough ${codex_base} review"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    quality-reviewer)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile thorough ${codex_base} review"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 리서치 레인 ───
    scientist)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"; DEFAULT_TIMEOUT=1440; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    scientist-deep)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile thorough ${codex_base}"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    document-specialist)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"; DEFAULT_TIMEOUT=1440; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── UI/문서 레인 ───
    designer)
      CLI_TYPE="gemini"; CLI_CMD="gemini"
      CLI_ARGS="-m gemini-3.1-pro-preview -y --prompt"
      CLI_EFFORT="pro"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    writer)
      CLI_TYPE="gemini"; CLI_CMD="gemini"
      CLI_ARGS="-m gemini-3-flash-preview -y --prompt"
      CLI_EFFORT="flash"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── Claude 네이티브 ───
    explore)
      CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=300; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    verifier)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile thorough ${codex_base} review"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=1200; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    test-engineer)
      CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=300; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    qa-tester)
      CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=300; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 경량 ───
    spark)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec --profile spark_fast ${codex_base}"
      CLI_EFFORT="spark_fast"; DEFAULT_TIMEOUT=180; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    *)
      echo "ERROR: 알 수 없는 에이전트 타입: $agent" >&2
      echo "사용 가능: executor, build-fixer, debugger, deep-executor, architect, planner, critic, analyst," >&2
      echo "          code-reviewer, security-reviewer, quality-reviewer, scientist, document-specialist," >&2
      echo "          designer, writer, explore, verifier, test-engineer, qa-tester, spark" >&2
      exit 1 ;;
  esac
}

# ── CLI 모드 오버라이드 (tfx-codex / tfx-gemini 스킬용) ──
TFX_CLI_MODE="${TFX_CLI_MODE:-auto}"
TFX_NO_CLAUDE_NATIVE="${TFX_NO_CLAUDE_NATIVE:-0}"
TFX_CODEX_TRANSPORT="${TFX_CODEX_TRANSPORT:-auto}"
case "$TFX_NO_CLAUDE_NATIVE" in
  0|1) ;;
  *)
    echo "ERROR: TFX_NO_CLAUDE_NATIVE 값은 0 또는 1이어야 합니다. (현재: $TFX_NO_CLAUDE_NATIVE)" >&2
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
CODEX_MCP_TRANSPORT_EXIT_CODE=70

apply_cli_mode() {
  local codex_base="--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"

  case "$TFX_CLI_MODE" in
    codex)
      if [[ "$CLI_TYPE" == "gemini" ]]; then
        CLI_TYPE="codex"; CLI_CMD="codex"
        case "$AGENT_TYPE" in
          designer)
            CLI_ARGS="exec ${codex_base}"; CLI_EFFORT="high"; DEFAULT_TIMEOUT=600 ;;
          writer)
            CLI_ARGS="exec --profile spark_fast ${codex_base}"; CLI_EFFORT="spark_fast"; DEFAULT_TIMEOUT=180 ;;
        esac
        echo "[tfx-route] TFX_CLI_MODE=codex: $AGENT_TYPE → codex($CLI_EFFORT)로 리매핑" >&2
      fi ;;
    gemini)
      if [[ "$CLI_TYPE" == "codex" ]]; then
        CLI_TYPE="gemini"; CLI_CMD="gemini"
        case "$AGENT_TYPE" in
          executor|debugger|deep-executor|architect|planner|critic|analyst|\
          code-reviewer|security-reviewer|quality-reviewer|scientist-deep)
            CLI_ARGS="-m gemini-3.1-pro-preview -y --prompt"; CLI_EFFORT="pro" ;;
          build-fixer|spark)
            CLI_ARGS="-m gemini-3-flash-preview -y --prompt"; CLI_EFFORT="flash"; DEFAULT_TIMEOUT=180 ;;
          *)
            CLI_ARGS="-m gemini-3-flash-preview -y --prompt"; CLI_EFFORT="flash" ;;
        esac
        echo "[tfx-route] TFX_CLI_MODE=gemini: $AGENT_TYPE → gemini($CLI_EFFORT)로 리매핑" >&2
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

# ── Claude 네이티브 제거 (Codex 리드 환경에서 선택적 활성화) ──
apply_no_claude_native_mode() {
  local codex_base="--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"

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
      CLI_ARGS="exec --profile fast ${codex_base}"
      CLI_EFFORT="fast"
      DEFAULT_TIMEOUT=600
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    verifier)
      CLI_ARGS="exec --profile thorough ${codex_base} review"
      CLI_EFFORT="thorough"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    test-engineer)
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    qa-tester)
      CLI_ARGS="exec --profile thorough ${codex_base} review"
      CLI_EFFORT="thorough"
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

# ── MCP 인벤토리 캐시 ──
MCP_CACHE="${HOME}/.claude/cache/mcp-inventory.json"

get_cached_servers() {
  local cli_type="$1"
  if [[ -f "$MCP_CACHE" ]]; then
    node -e 'const[,f,t]=process.argv;const inv=JSON.parse(require("fs").readFileSync(f,"utf8"));const s=(inv[t]||{}).servers||[];console.log(s.filter(x=>x.status==="enabled"||x.status==="configured").map(x=>x.name).join(","))' -- "$MCP_CACHE" "$cli_type" 2>/dev/null
  fi
}

# ── MCP 프로필 → 프롬프트 힌트 (통합: 캐시 유무 단일 코드경로) ──
get_mcp_hint() {
  local profile="$1"
  local agent="$2"

  # auto → 구체 프로필 해석
  if [[ "$profile" == "auto" ]]; then
    case "$agent" in
      executor|build-fixer|debugger|deep-executor) profile="implement" ;;
      architect|planner|critic|analyst) profile="analyze" ;;
      code-reviewer|security-reviewer|quality-reviewer) profile="review" ;;
      scientist|document-specialist) profile="analyze" ;;
      designer|writer) profile="docs" ;;
      *) profile="minimal" ;;
    esac
  fi

  # 서버 목록: 캐시 있으면 실제, 없으면 전부 가용 가정 (기존 비캐시 동작과 동일)
  local servers
  servers=$(get_cached_servers "$CLI_TYPE")
  [[ -z "$servers" ]] && servers="context7,brave-search,exa,tavily,playwright,sequential-thinking"

  has_server() { echo ",$servers," | grep -q ",$1,"; }

  local hint=""
  case "$profile" in
    implement)
      has_server "context7" && hint+="context7으로 라이브러리 문서를 조회하세요. "
      if has_server "brave-search"; then hint+="웹 검색은 brave-search를 사용하세요. "
      elif has_server "exa"; then hint+="웹 검색은 exa를 사용하세요. "
      elif has_server "tavily"; then hint+="웹 검색은 tavily를 사용하세요. "
      fi
      hint+="검색 도구 실패 시 재시도하지 말고 다음 도구로 전환하세요."
      ;;
    analyze)
      has_server "context7" && hint+="context7으로 관련 문서를 조회하세요. "
      local search_tools=""
      has_server "brave-search" && search_tools+="brave-search, "
      has_server "tavily" && search_tools+="tavily, "
      has_server "exa" && search_tools+="exa, "
      [[ -n "$search_tools" ]] && hint+="웹 검색 우선순위: ${search_tools%, }. 402 에러 시 즉시 다음 도구로 전환. "
      has_server "playwright" && hint+="모든 검색 실패 시 playwright로 직접 방문 (최대 3 URL). "
      hint+="검색 깊이를 제한하고 결과를 빠르게 요약하세요."
      ;;
    review)
      has_server "sequential-thinking" && hint="sequential-thinking으로 체계적으로 분석하세요."
      ;;
    docs)
      has_server "context7" && hint+="context7으로 공식 문서를 참조하세요. "
      has_server "brave-search" && hint+="추가 검색은 brave-search를 사용하세요. "
      hint+="검색 결과의 출처 URL을 함께 제시하세요."
      ;;
    minimal|none) ;;
  esac
  echo "$hint"
}

# ── Gemini MCP 서버 선택적 로드 ──
get_gemini_mcp_servers() {
  local profile="$1"
  case "$profile" in
    implement)  echo "context7 brave-search" ;;
    analyze)    echo "context7 brave-search exa" ;;
    review)     echo "sequential-thinking" ;;
    docs)       echo "context7 brave-search" ;;
    *)          echo "" ;;
  esac
}

get_gemini_mcp_filter() {
  local servers
  servers=$(get_gemini_mcp_servers "$1")
  [[ -z "$servers" ]] && return 0
  echo "--allowed-mcp-server-names ${servers// /,}"
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

resolve_worker_runner_script() {
  if [[ -n "${TFX_ROUTE_WORKER_RUNNER:-}" && -f "$TFX_ROUTE_WORKER_RUNNER" ]]; then
    printf '%s\n' "$TFX_ROUTE_WORKER_RUNNER"
    return 0
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local candidate="$script_dir/tfx-route-worker.mjs"
  [[ -f "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

run_stream_worker() {
  local worker_type="$1"
  local prompt="$2"
  local use_tee_flag="$3"
  shift 3

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
    printf '%s' "$prompt" | timeout "$TIMEOUT_SEC" "${worker_cmd[@]}" 2>"$STDERR_LOG" | tee "$STDOUT_LOG"
  else
    printf '%s' "$prompt" | timeout "$TIMEOUT_SEC" "${worker_cmd[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG"
  fi
}

run_legacy_gemini() {
  local prompt="$1"
  local use_tee_flag="$2"
  local gemini_mcp_filter
  gemini_mcp_filter=$(get_gemini_mcp_filter "$MCP_PROFILE")
  local gemini_args="$CLI_ARGS"

  if [[ -n "$gemini_mcp_filter" ]]; then
    gemini_args="${CLI_ARGS/--prompt/$gemini_mcp_filter --prompt}"
    echo "[tfx-route] Gemini MCP 필터: $gemini_mcp_filter" >&2
  fi

  if [[ "$use_tee_flag" == "true" ]]; then
    timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$prompt" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
  else
    timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$prompt" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  fi
  local pid=$!

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

  local exit_code_local=0
  if [[ "$health_ok" == "false" ]]; then
    wait "$pid" 2>/dev/null
    echo "[tfx-route] Gemini crash 감지, 재시도 중..." >&2
    if [[ "$use_tee_flag" == "true" ]]; then
      timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$prompt" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" &
    else
      timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$prompt" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
    fi
    pid=$!
  fi

  wait "$pid" || exit_code_local=$?
  return "$exit_code_local"
}

resolve_codex_mcp_script() {
  if [[ -n "${TFX_CODEX_MCP_SCRIPT:-}" && -f "$TFX_CODEX_MCP_SCRIPT" ]]; then
    printf '%s\n' "$TFX_CODEX_MCP_SCRIPT"
    return 0
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local candidates=(
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

  if [[ "$use_tee_flag" == "true" ]]; then
    timeout "$TIMEOUT_SEC" $CLI_CMD $CLI_ARGS "$prompt" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" || exit_code_local=$?
  else
    timeout "$TIMEOUT_SEC" $CLI_CMD $CLI_ARGS "$prompt" >"$STDOUT_LOG" 2>"$STDERR_LOG" || exit_code_local=$?
  fi

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
      echo "[tfx-route] 경고: codex stdout 비어있음, stderr에서 응답 복구 ($(wc -c < "$STDOUT_LOG") bytes)" >&2
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
    timeout "$TIMEOUT_SEC" "$node_bin" "${mcp_args[@]}" 2>"$STDERR_LOG" | tee "$STDOUT_LOG" || exit_code_local=$?
  else
    timeout "$TIMEOUT_SEC" "$node_bin" "${mcp_args[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG" || exit_code_local=$?
  fi

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

  # Claude 네이티브 에이전트는 이 스크립트로 처리 불가 → 메타데이터만 출력
  if [[ "$CLI_TYPE" == "claude-native" ]]; then
    emit_claude_native_metadata
    exit 0
  fi

  # MCP 힌트 주입
  local mcp_hint
  mcp_hint=$(get_mcp_hint "$MCP_PROFILE" "$AGENT_TYPE")
  local FULL_PROMPT="$PROMPT"
  [[ -n "$mcp_hint" ]] && FULL_PROMPT="${PROMPT}. ${mcp_hint}"
  local codex_transport_effective="n/a"

  # 메타정보 (stderr)
  echo "[tfx-route] v${VERSION} type=$CLI_TYPE agent=$AGENT_TYPE effort=$CLI_EFFORT mode=$RUN_MODE timeout=${TIMEOUT_SEC}s" >&2
  echo "[tfx-route] opus_oversight=$OPUS_OVERSIGHT mcp_profile=$MCP_PROFILE" >&2
  if [[ "$CLI_TYPE" == "codex" ]]; then
    echo "[tfx-route] codex_transport_request=$TFX_CODEX_TRANSPORT" >&2
  fi
  [[ -n "$TFX_TEAM_NAME" ]] && echo "[tfx-route] team=$TFX_TEAM_NAME task=$TFX_TEAM_TASK_ID agent=$TFX_TEAM_AGENT_NAME" >&2

  # Per-process 에이전트 등록
  register_agent

  # 팀 모드: task claim
  team_claim_task

  # CLI 실행 (stderr 분리 + 타임아웃 + 소요시간 측정)
  local exit_code=0
  local start_time
  start_time=$(date +%s)

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
    local gemini_servers
    gemini_servers=$(get_gemini_mcp_servers "$MCP_PROFILE")
    local -a gemini_worker_args=(
      "--command" "$CLI_CMD"
      "--command-args-json" "$GEMINI_BIN_ARGS_JSON"
      "--model" "$gemini_model"
      "--approval-mode" "yolo"
    )

    if [[ -n "$gemini_servers" ]]; then
      echo "[tfx-route] Gemini MCP 서버: ${gemini_servers}" >&2
      local server_name
      for server_name in $gemini_servers; do
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
      --max-bytes "$MAX_STDOUT_BYTES" \
      --tee-active "$use_tee"
  else
    # post.mjs 없으면 기본 출력 (fallback)
    echo "=== TFX-ROUTE RESULT ==="
    echo "agent: $AGENT_TYPE"
    echo "cli: $CLI_TYPE"
    echo "exit_code: $exit_code"
    echo "elapsed: ${elapsed}s"
    echo "status: $([ $exit_code -eq 0 ] && echo success || echo failed)"
    echo "=== OUTPUT ==="
    cat "$STDOUT_LOG" 2>/dev/null | head -c "$MAX_STDOUT_BYTES"
  fi
}

main
