#!/usr/bin/env bash
# tfx-route.sh v2.0 — CLI 라우팅 래퍼 (triflux)
#
# v1.x: cli-route.sh (jq+python3+node 혼재, 동기 후처리 ~1s)
# v2.0: tfx-route.sh 리네임
#   - 후처리 전부 tfx-route-post.mjs로 이관 (node 단일 ~100ms)
#   - per-process 에이전트 등록 (race condition 구조적 제거)
#   - get_mcp_hint 통합 (캐시/비캐시 단일 코드경로)
#   - Gemini health check 지수 백오프 (30×1s → 5×exp)
#   - 컨텍스트 파일 5번째 인자 지원
#
VERSION="2.0"
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
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || echo codex)}"
GEMINI_BIN="${GEMINI_BIN:-$(command -v gemini 2>/dev/null || echo gemini)}"

# ── 상수 ──
MAX_STDOUT_BYTES=51200  # 50KB — Claude 컨텍스트 절약
TIMESTAMP=$(date +%s)
STDERR_LOG="/tmp/tfx-route-${AGENT_TYPE}-${TIMESTAMP}-stderr.log"
STDOUT_LOG="/tmp/tfx-route-${AGENT_TYPE}-${TIMESTAMP}-stdout.log"
TFX_TMP="${TMPDIR:-/tmp}"

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
      CLI_ARGS="--profile fast exec ${codex_base}"
      CLI_EFFORT="fast"; DEFAULT_TIMEOUT=540; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    debugger)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"; DEFAULT_TIMEOUT=900; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    deep-executor)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;

    # ─── 설계/분석 레인 ───
    architect)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    planner)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="fg"; OPUS_OVERSIGHT="true" ;;
    critic)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    analyst)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"; DEFAULT_TIMEOUT=3600; RUN_MODE="fg"; OPUS_OVERSIGHT="true" ;;

    # ─── 리뷰 레인 ───
    code-reviewer)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base} review"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    security-reviewer)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base} review"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="true" ;;
    quality-reviewer)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base} review"
      CLI_EFFORT="thorough"; DEFAULT_TIMEOUT=1800; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 리서치 레인 ───
    scientist)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"; DEFAULT_TIMEOUT=1440; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    scientist-deep)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base}"
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
      CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=300; RUN_MODE="fg"; OPUS_OVERSIGHT="false" ;;
    test-engineer)
      CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=300; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;
    qa-tester)
      CLI_TYPE="claude-native"; CLI_CMD=""; CLI_ARGS=""
      CLI_EFFORT="n/a"; DEFAULT_TIMEOUT=300; RUN_MODE="bg"; OPUS_OVERSIGHT="false" ;;

    # ─── 경량 ───
    spark)
      CLI_TYPE="codex"; CLI_CMD="codex"
      CLI_ARGS="--profile spark_fast exec ${codex_base}"
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
            CLI_ARGS="--profile spark_fast exec ${codex_base}"; CLI_EFFORT="spark_fast"; DEFAULT_TIMEOUT=180 ;;
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
get_gemini_mcp_filter() {
  local profile="$1"
  case "$profile" in
    implement)  echo "--allowed-mcp-server-names context7,brave-search" ;;
    analyze)    echo "--allowed-mcp-server-names context7,brave-search,exa" ;;
    review)     echo "--allowed-mcp-server-names sequential-thinking" ;;
    docs)       echo "--allowed-mcp-server-names context7,brave-search" ;;
    *)          echo "" ;;
  esac
}

# ── 메인 실행 ──
main() {
  # 종료 시 per-process 에이전트 파일 자동 삭제
  trap 'deregister_agent' EXIT

  route_agent "$AGENT_TYPE"
  apply_cli_mode

  # CLI 경로 해석
  case "$CLI_CMD" in
    codex) CLI_CMD="$CODEX_BIN" ;;
    gemini) CLI_CMD="$GEMINI_BIN" ;;
  esac

  # 타임아웃 결정
  if [[ -n "$USER_TIMEOUT" ]]; then
    TIMEOUT_SEC="$USER_TIMEOUT"
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

  # Claude 네이티브 에이전트는 이 스크립트로 처리 불가 → 메타데이터만 출력
  if [[ "$CLI_TYPE" == "claude-native" ]]; then
    local model="sonnet"
    case "$AGENT_TYPE" in
      explore) model="haiku" ;;
    esac
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
    exit 0
  fi

  # MCP 힌트 주입
  local mcp_hint
  mcp_hint=$(get_mcp_hint "$MCP_PROFILE" "$AGENT_TYPE")
  local FULL_PROMPT="$PROMPT"
  [[ -n "$mcp_hint" ]] && FULL_PROMPT="${PROMPT}. ${mcp_hint}"

  # 메타정보 (stderr)
  echo "[tfx-route] v${VERSION} type=$CLI_TYPE agent=$AGENT_TYPE effort=$CLI_EFFORT mode=$RUN_MODE timeout=${TIMEOUT_SEC}s" >&2
  echo "[tfx-route] opus_oversight=$OPUS_OVERSIGHT mcp_profile=$MCP_PROFILE" >&2

  # Per-process 에이전트 등록
  register_agent

  # CLI 실행 (stderr 분리 + 타임아웃 + 소요시간 측정)
  local exit_code=0
  local start_time
  start_time=$(date +%s)

  if [[ "$CLI_TYPE" == "codex" ]]; then
    # Codex: stdout/stderr 모두 파일로 캡처 (post.mjs가 읽음)
    timeout "$TIMEOUT_SEC" $CLI_CMD $CLI_ARGS "$FULL_PROMPT" >"$STDOUT_LOG" 2>"$STDERR_LOG" || exit_code=$?

  elif [[ "$CLI_TYPE" == "gemini" ]]; then
    # Gemini: MCP 프로필별 서버 필터
    local gemini_mcp_filter
    gemini_mcp_filter=$(get_gemini_mcp_filter "$MCP_PROFILE")
    local gemini_args="$CLI_ARGS"
    if [[ -n "$gemini_mcp_filter" ]]; then
      gemini_args="${CLI_ARGS/--prompt/$gemini_mcp_filter --prompt}"
      echo "[tfx-route] Gemini MCP 필터: $gemini_mcp_filter" >&2
    fi

    timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$FULL_PROMPT" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
    local pid=$!

    # 지수 백오프 health check (v1.x: 30×1s → v2.0: 5×exp, 총 19초)
    local health_ok=true
    local intervals=(1 2 3 5 8)
    for wait_sec in "${intervals[@]}"; do
      sleep "$wait_sec"
      # 출력 있으면 정상 → 조기 탈출
      if [[ -s "$STDOUT_LOG" ]] || [[ -s "$STDERR_LOG" ]]; then
        break
      fi
      # 프로세스 사망 + 출력 없음 → crash
      if ! kill -0 "$pid" 2>/dev/null; then
        health_ok=false
        echo "[tfx-route] Gemini: 출력 없이 프로세스 종료 (${wait_sec}초 체크)" >&2
        break
      fi
    done

    if [[ "$health_ok" == "false" ]]; then
      wait "$pid" 2>/dev/null
      echo "[tfx-route] Gemini crash 감지, 재시도 중..." >&2
      timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$FULL_PROMPT" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
      pid=$!
      wait "$pid"
      exit_code=$?
    else
      wait "$pid"
      exit_code=$?
    fi
  fi

  local end_time
  end_time=$(date +%s)
  local elapsed=$((end_time - start_time))

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
      --max-bytes "$MAX_STDOUT_BYTES"
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
