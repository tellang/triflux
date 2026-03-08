#!/usr/bin/env bash
# cli-route.sh v1.7 — CLI 라우팅 래퍼 (ai-scaffold 템플릿)
# v1.0: 기본 라우팅 (Codex/Gemini/Claude 분기)
# v1.1: stderr 분리, 출력 필터링, 타임아웃, MCP 프로필 지원
# v1.2: effort 동적 라우팅, bg/fg 모드, Opus 직접 수행, Gemini 모델 분기, 실행 로그
# v1.3: architect/critic Codex 이관, 리뷰어 exec review 전환, multi_agent 활성화
# v1.4: TFX_CLI_MODE 지원 (codex-only/gemini-only), CLI 미설치 자동 fallback
# v1.5: MCP 인벤토리 캐싱 — 실제 서버 가용성 기반 동적 힌트 생성
# v1.6: 토큰 사용량 추출 + sv-accumulator.json 누적
# v1.7: 배치 AIMD 전략 — 성공 시 +1, 실패/타임아웃 시 ×0.5, 수렴 감지
VERSION="1.7"
#
# 설치: cp scripts/cli-route.sh ~/.claude/scripts/cli-route.sh
#
# 사용법:
#   cli-route.sh <agent_type> <prompt> [mcp_profile] [timeout_sec]
#
# 예시:
#   cli-route.sh executor "코드 구현" implement 300
#   cli-route.sh architect "아키텍처 분석" analyze 600
#   cli-route.sh designer "UI 리뷰"
#   cli-route.sh debugger "버그 분석" analyze

set -euo pipefail

# ── 인자 파싱 ──
AGENT_TYPE="${1:?에이전트 타입 필수 (executor, debugger, designer 등)}"
PROMPT="${2:?프롬프트 필수}"
MCP_PROFILE="${3:-auto}"
USER_TIMEOUT="${4:-}"

# ── CLI 경로 해석 (Windows npm global 대응) ──
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || echo codex)}"
GEMINI_BIN="${GEMINI_BIN:-$(command -v gemini 2>/dev/null || echo gemini)}"

# ── 상수 ──
MAX_STDOUT_BYTES=51200  # 50KB — Claude 컨텍스트 절약
TIMESTAMP=$(date +%s)
STDERR_LOG="/tmp/tfx-route-${AGENT_TYPE}-${TIMESTAMP}-stderr.log"
STDOUT_LOG="/tmp/tfx-route-${AGENT_TYPE}-${TIMESTAMP}-stdout.log"

# fallback 시 원래 에이전트/CLI 인자 보존용 (수정 3: review fallback 프로필 유실 방지)
ORIGINAL_AGENT=""
ORIGINAL_CLI_ARGS=""

# ── 크로스 세션 활성 에이전트 추적 ──
# 활성 에이전트 레지스트리 경로
ACTIVE_AGENTS_FILE="${HOME}/.claude/cache/active-agents.json"

# 죽은 PID 및 좀비 정리
cleanup_stale_agents() {
  [[ ! -f "$ACTIVE_AGENTS_FILE" ]] && return
  local now
  now=$(date +%s)
  local tmp="${ACTIVE_AGENTS_FILE}.tmp"
  # jq가 있으면 사용, 없으면 건너뜀
  if command -v jq &>/dev/null; then
    jq --argjson now "$now" '
      .agents |= map(select(
        # PID 생존 확인은 셸에서 하므로 여기선 타임아웃만 체크
        (.started + 1200) > $now
      ))
    ' "$ACTIVE_AGENTS_FILE" > "$tmp" 2>/dev/null && mv "$tmp" "$ACTIVE_AGENTS_FILE"
    # 추가로 kill -0으로 죽은 PID 제거
    local pids
    pids=$(jq -r '.agents[].pid' "$ACTIVE_AGENTS_FILE" 2>/dev/null)
    local pid
    for pid in $pids; do
      if ! kill -0 "$pid" 2>/dev/null; then
        jq --argjson pid "$pid" '.agents |= map(select(.pid != $pid))' "$ACTIVE_AGENTS_FILE" > "$tmp" 2>/dev/null && mv "$tmp" "$ACTIVE_AGENTS_FILE"
      fi
    done
  fi
}

# 에이전트 등록
register_agent() {
  local pid="$1" cli="$2" agent="$3"
  local now
  now=$(date +%s)
  cleanup_stale_agents
  if command -v jq &>/dev/null; then
    # 캐시 디렉토리가 없으면 생성
    mkdir -p "$(dirname "$ACTIVE_AGENTS_FILE")"
    if [[ -f "$ACTIVE_AGENTS_FILE" ]]; then
      jq --argjson pid "$pid" --arg cli "$cli" --arg agent "$agent" --argjson started "$now" \
        '.agents += [{"pid": $pid, "cli": $cli, "agent": $agent, "started": $started}]' \
        "$ACTIVE_AGENTS_FILE" > "${ACTIVE_AGENTS_FILE}.tmp" && mv "${ACTIVE_AGENTS_FILE}.tmp" "$ACTIVE_AGENTS_FILE"
    else
      echo "{\"agents\":[{\"pid\":$pid,\"cli\":\"$cli\",\"agent\":\"$agent\",\"started\":$now}]}" > "$ACTIVE_AGENTS_FILE"
    fi
  fi
}

# 에이전트 등록 해제
deregister_agent() {
  local pid="$1"
  if command -v jq &>/dev/null && [[ -f "$ACTIVE_AGENTS_FILE" ]]; then
    jq --argjson pid "$pid" '.agents |= map(select(.pid != $pid))' \
      "$ACTIVE_AGENTS_FILE" > "${ACTIVE_AGENTS_FILE}.tmp" && mv "${ACTIVE_AGENTS_FILE}.tmp" "$ACTIVE_AGENTS_FILE"
  fi
}

# ── 배치 AIMD 전략 ──
# 배치 설정 파일: ~/.claude/cache/batch-config.json
# 초기 batch_size=2, 성공→+1 (AI), 실패/타임아웃→×0.5 (MD), 상한=8, 수렴=3연속 동일
BATCH_CONFIG_FILE="${HOME}/.claude/cache/batch-config.json"

# 현재 batch_size 반환 (파일 없으면 기본값 2)
get_batch_size() {
  if ! command -v jq &>/dev/null; then
    echo "2"
    return
  fi
  if [[ -f "$BATCH_CONFIG_FILE" ]]; then
    local size
    size=$(jq -r '.batch_size // 2' "$BATCH_CONFIG_FILE" 2>/dev/null)
    # 숫자가 아니거나 비어 있으면 기본값
    if [[ "$size" =~ ^[0-9]+$ ]]; then
      echo "$size"
    else
      echo "2"
    fi
  else
    echo "2"
  fi
}

# 현재 활성 에이전트 수 반환 (active-agents.json 기반)
get_active_agent_count() {
  if ! command -v jq &>/dev/null; then
    echo "0"
    return
  fi
  if [[ -f "$ACTIVE_AGENTS_FILE" ]]; then
    local count
    count=$(jq '.agents | length' "$ACTIVE_AGENTS_FILE" 2>/dev/null)
    echo "${count:-0}"
  else
    echo "0"
  fi
}

# AIMD 결과 기록 및 batch_size 업데이트
# 인자: result (success/failed/timeout), agent
update_batch_result() {
  local result="$1"
  local agent="${2:-unknown}"

  if ! command -v jq &>/dev/null; then
    return
  fi

  mkdir -p "$(dirname "$BATCH_CONFIG_FILE")"

  # 현재 설정 읽기 (없으면 초기값)
  local current_size consecutive_same converged
  if [[ -f "$BATCH_CONFIG_FILE" ]]; then
    current_size=$(jq -r '.batch_size // 2' "$BATCH_CONFIG_FILE" 2>/dev/null)
    consecutive_same=$(jq -r '.consecutive_same // 0' "$BATCH_CONFIG_FILE" 2>/dev/null)
    converged=$(jq -r '.converged // false' "$BATCH_CONFIG_FILE" 2>/dev/null)
  else
    current_size=2
    consecutive_same=0
    converged="false"
  fi

  # 숫자 검증
  [[ "$current_size" =~ ^[0-9]+$ ]] || current_size=2
  [[ "$consecutive_same" =~ ^[0-9]+$ ]] || consecutive_same=0

  # 수렴 상태면 batch_size 고정 (업데이트만 기록)
  local new_size="$current_size"
  if [[ "$converged" != "true" ]]; then
    case "$result" in
      success)
        # Additive Increase: +1, 상한 8
        new_size=$((current_size + 1))
        if [[ $new_size -gt 8 ]]; then new_size=8; fi
        ;;
      failed|timeout)
        # Multiplicative Decrease: ×0.5, 하한 1
        new_size=$((current_size / 2))
        if [[ $new_size -lt 1 ]]; then new_size=1; fi
        ;;
    esac
  fi

  # 수렴 판단: 3연속 동일하면 converged=true
  if [[ $new_size -eq $current_size ]]; then
    consecutive_same=$((consecutive_same + 1))
  else
    consecutive_same=0
  fi

  local new_converged="false"
  if [[ $consecutive_same -ge 3 ]]; then
    new_converged="true"
  fi

  local now
  now=$(date +%s)

  # history에 추가 (최대 50건 유지) 후 batch_size 업데이트
  local tmp="${BATCH_CONFIG_FILE}.tmp"
  if [[ -f "$BATCH_CONFIG_FILE" ]]; then
    jq --argjson now "$now" \
       --arg agent "$agent" \
       --arg result "$result" \
       --argjson batch_at_time "$current_size" \
       --argjson new_size "$new_size" \
       --argjson consecutive_same "$consecutive_same" \
       --argjson converged "$new_converged" \
       '
      .history += [{"timestamp": $now, "agent": $agent, "result": $result, "batch_at_time": $batch_at_time}] |
      .history = (.history | if length > 50 then .[-50:] else . end) |
      .batch_size = $new_size |
      .consecutive_same = $consecutive_same |
      .converged = $converged
    ' "$BATCH_CONFIG_FILE" > "$tmp" 2>/dev/null && mv "$tmp" "$BATCH_CONFIG_FILE"
  else
    # 파일 신규 생성
    jq -n \
      --argjson now "$now" \
      --arg agent "$agent" \
      --arg result "$result" \
      --argjson new_size "$new_size" \
      --argjson consecutive_same "$consecutive_same" \
      --argjson converged "$new_converged" \
      '{
        batch_size: $new_size,
        history: [{"timestamp": $now, "agent": $agent, "result": $result, "batch_at_time": 2}],
        consecutive_same: $consecutive_same,
        converged: $converged
      }' > "$BATCH_CONFIG_FILE" 2>/dev/null || true
  fi

  echo "[cli-route] AIMD: $result → batch_size $current_size→$new_size (consecutive_same=$consecutive_same, converged=$new_converged)" >&2
}

# ── 라우팅 테이블 ──
# 반환: CLI_CMD, CLI_ARGS, CLI_TYPE, CLI_EFFORT, DEFAULT_TIMEOUT, RUN_MODE, OPUS_OVERSIGHT
#
# RUN_MODE: bg (백그라운드 — 독립 실행, 결과 나중에 수집)
#           fg (포어그라운드 — 결과가 다음 단계를 블로킹)
#
# OPUS_OVERSIGHT: true  — Codex 결과를 Claude Opus가 검증/보완해야 함
#                 false — Codex/Gemini 결과를 그대로 사용
#
route_agent() {
  local agent="$1"
  local codex_base="--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"

  case "$agent" in
    # ─── 구현 레인 ───

    # Codex — 코드 구현 (effort: high, 720s, fg — 후속 태스크가 의존)
    executor)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"
      DEFAULT_TIMEOUT=720
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    # Codex — 빌드 수정 (effort: fast, 360s, fg — 빌드 통과 확인 필요)
    build-fixer)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile fast exec ${codex_base}"
      CLI_EFFORT="fast"
      DEFAULT_TIMEOUT=360
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    # Codex — 디버깅 (effort: high, 600s, bg — 분석 결과 나중에 수집)
    debugger)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"
      DEFAULT_TIMEOUT=600
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    # Codex — 자율 실행 (effort: xhigh, 2400s, bg — 장시간 독립 수행)
    deep-executor)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"
      DEFAULT_TIMEOUT=2400
      RUN_MODE="bg"
      OPUS_OVERSIGHT="true"
      ;;

    # ─── 설계/분석 레인 ───

    # Codex — 아키텍처 (effort: xhigh, 2400s, bg — Opus가 설계 품질 검증)
    architect)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"
      DEFAULT_TIMEOUT=2400
      RUN_MODE="bg"
      OPUS_OVERSIGHT="true"
      ;;
    # Codex — 태스크 분해 (effort: xhigh, 2400s, fg — Opus가 검증)
    planner)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"
      DEFAULT_TIMEOUT=2400
      RUN_MODE="fg"
      OPUS_OVERSIGHT="true"
      ;;
    # Codex — 비판적 검토 (effort: xhigh, 2400s, bg — Opus가 비판 품질 검증)
    critic)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"
      DEFAULT_TIMEOUT=2400
      RUN_MODE="bg"
      OPUS_OVERSIGHT="true"
      ;;
    # Codex — 요구사항 분석 (effort: xhigh, 2400s, fg — Opus가 검증)
    analyst)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile xhigh exec ${codex_base}"
      CLI_EFFORT="xhigh"
      DEFAULT_TIMEOUT=2400
      RUN_MODE="fg"
      OPUS_OVERSIGHT="true"
      ;;

    # ─── 리뷰 레인 ───

    # Codex — 코드 리뷰 (exec review, effort: thorough, 1200s, bg — 전용 리뷰 커맨드)
    code-reviewer)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base} review"
      CLI_EFFORT="thorough"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    # Codex — 보안 리뷰 (exec review, effort: thorough, 1200s, bg — Opus 검증 권장)
    security-reviewer)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base} review"
      CLI_EFFORT="thorough"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="bg"
      OPUS_OVERSIGHT="true"
      ;;
    # Codex — 품질 리뷰 (exec review, effort: thorough, 1200s, bg — 전용 리뷰 커맨드)
    quality-reviewer)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base} review"
      CLI_EFFORT="thorough"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;

    # ─── 리서치 레인 ───

    # Codex — 일반 리서치 (effort: high, 960s, bg — 빠른 검색+요약)
    scientist)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"
      DEFAULT_TIMEOUT=960
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    # Codex — 심층 리서치 (effort: thorough, 2400s, bg — 논문 심층 분석)
    scientist-deep)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile thorough exec ${codex_base}"
      CLI_EFFORT="thorough"
      DEFAULT_TIMEOUT=2400
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    # Codex — 문서 조사 (effort: high, 960s, bg — 웹 검색 폴백 체인)
    document-specialist)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="exec ${codex_base}"
      CLI_EFFORT="high"
      DEFAULT_TIMEOUT=960
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;

    # ─── UI/문서 레인 ───

    # Gemini Pro 3.1 — UI/디자인 (높은 품질, 시각적 추론)
    designer)
      CLI_TYPE="gemini"
      CLI_CMD="gemini"
      CLI_ARGS="-m gemini-3.1-pro-preview -y --prompt"
      CLI_EFFORT="pro"
      DEFAULT_TIMEOUT=600
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    # Gemini Flash 3 — 문서/가이드 작성 (빠른 생성)
    writer)
      CLI_TYPE="gemini"
      CLI_CMD="gemini"
      CLI_ARGS="-m gemini-3-flash-preview -y --prompt"
      CLI_EFFORT="flash"
      DEFAULT_TIMEOUT=600
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;

    # ─── Claude 네이티브 ───

    # Claude Haiku — 코드베이스 탐색 (fg — 탐색 결과가 분해에 필요)
    explore)
      CLI_TYPE="claude-native"
      CLI_CMD=""
      CLI_ARGS=""
      CLI_EFFORT="n/a"
      DEFAULT_TIMEOUT=300
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    # Claude Sonnet — 검증 (fg — 검증 결과가 다음 단계 결정)
    verifier)
      CLI_TYPE="claude-native"
      CLI_CMD=""
      CLI_ARGS=""
      CLI_EFFORT="n/a"
      DEFAULT_TIMEOUT=300
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    # Claude Sonnet — 테스트 (bg — 테스트 독립 실행 가능)
    test-engineer)
      CLI_TYPE="claude-native"
      CLI_CMD=""
      CLI_ARGS=""
      CLI_EFFORT="n/a"
      DEFAULT_TIMEOUT=300
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;
    # Claude Sonnet — QA (bg — QA 독립 실행 가능)
    qa-tester)
      CLI_TYPE="claude-native"
      CLI_CMD=""
      CLI_ARGS=""
      CLI_EFFORT="n/a"
      DEFAULT_TIMEOUT=300
      RUN_MODE="bg"
      OPUS_OVERSIGHT="false"
      ;;

    # ─── 경량 ───

    # Spark — 린트/보일러플레이트 (120s, fg — 즉시 완료 기대)
    spark)
      CLI_TYPE="codex"
      CLI_CMD="codex"
      CLI_ARGS="--profile spark_fast exec ${codex_base}"
      CLI_EFFORT="spark_fast"
      DEFAULT_TIMEOUT=120
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      ;;
    *)
      echo "ERROR: 알 수 없는 에이전트 타입: $agent" >&2
      echo "사용 가능: executor, build-fixer, debugger, deep-executor, architect, planner, critic, analyst," >&2
      echo "          code-reviewer, security-reviewer, quality-reviewer, scientist, document-specialist," >&2
      echo "          designer, writer, explore, verifier, test-engineer, qa-tester, spark" >&2
      exit 1
      ;;
  esac
}

# ── CLI 모드 오버라이드 (tfx-codex / tfx-gemini 스킬용) ──
# TFX_CLI_MODE: auto (기본), codex (Codex-only), gemini (Gemini-only)
TFX_CLI_MODE="${TFX_CLI_MODE:-auto}"

apply_cli_mode() {
  local codex_base="--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"

  case "$TFX_CLI_MODE" in
    codex)
      # Gemini 에이전트를 Codex로 리매핑
      if [[ "$CLI_TYPE" == "gemini" ]]; then
        CLI_TYPE="codex"
        CLI_CMD="codex"
        case "$AGENT_TYPE" in
          designer)
            # UI/디자인은 코드 생성이 필요 → high effort
            CLI_ARGS="exec ${codex_base}"
            CLI_EFFORT="high"
            DEFAULT_TIMEOUT=600
            ;;
          writer)
            # 문서/가이드 작성은 경량 → spark
            CLI_ARGS="--profile spark_fast exec ${codex_base}"
            CLI_EFFORT="spark_fast"
            DEFAULT_TIMEOUT=180
            ;;
        esac
        echo "[cli-route] TFX_CLI_MODE=codex: $AGENT_TYPE → codex($CLI_EFFORT)로 리매핑" >&2
      fi
      ;;
    gemini)
      # Codex 에이전트를 Gemini로 리매핑
      if [[ "$CLI_TYPE" == "codex" ]]; then
        CLI_TYPE="gemini"
        CLI_CMD="gemini"
        # 복잡한 작업(구현/설계/리뷰/심층분석) → Pro 3.1
        # 경량 작업(빌드/린트/검색/문서) → Flash 3
        case "$AGENT_TYPE" in
          # Pro 3.1 — 깊이 필요한 작업
          executor|debugger|deep-executor)
            CLI_ARGS="-m gemini-3.1-pro-preview -y --prompt"
            CLI_EFFORT="pro"
            ;;
          architect|planner|critic|analyst)
            CLI_ARGS="-m gemini-3.1-pro-preview -y --prompt"
            CLI_EFFORT="pro"
            ;;
          code-reviewer|security-reviewer|quality-reviewer)
            CLI_ARGS="-m gemini-3.1-pro-preview -y --prompt"
            CLI_EFFORT="pro"
            ;;
          scientist-deep)
            CLI_ARGS="-m gemini-3.1-pro-preview -y --prompt"
            CLI_EFFORT="pro"
            ;;
          # Flash 3 — 경량/빠른 작업
          build-fixer|spark)
            CLI_ARGS="-m gemini-3-flash-preview -y --prompt"
            CLI_EFFORT="flash"
            DEFAULT_TIMEOUT=180
            ;;
          scientist|document-specialist)
            CLI_ARGS="-m gemini-3-flash-preview -y --prompt"
            CLI_EFFORT="flash"
            ;;
          *)
            CLI_ARGS="-m gemini-3-flash-preview -y --prompt"
            CLI_EFFORT="flash"
            ;;
        esac
        echo "[cli-route] TFX_CLI_MODE=gemini: $AGENT_TYPE → gemini($CLI_EFFORT)로 리매핑" >&2
      fi
      ;;
    auto)
      # 자동 감지: CLI 미설치 시 대체
      if [[ "$CLI_TYPE" == "codex" ]] && ! command -v "$CODEX_BIN" &>/dev/null; then
        if command -v "$GEMINI_BIN" &>/dev/null; then
          TFX_CLI_MODE="gemini"
          apply_cli_mode
          return
        else
          # 원래 에이전트 및 MCP 프로필 정보 보존
          ORIGINAL_AGENT="${AGENT_TYPE}"
          ORIGINAL_CLI_ARGS="$CLI_ARGS"
          CLI_TYPE="claude-native"
          CLI_CMD=""
          CLI_ARGS=""
          echo "[cli-route] codex/gemini 모두 미설치: $AGENT_TYPE → claude-native fallback (원래 프로필: $MCP_PROFILE)" >&2
        fi
      elif [[ "$CLI_TYPE" == "gemini" ]] && ! command -v "$GEMINI_BIN" &>/dev/null; then
        if command -v "$CODEX_BIN" &>/dev/null; then
          TFX_CLI_MODE="codex"
          apply_cli_mode
          return
        else
          # 원래 에이전트 및 MCP 프로필 정보 보존
          ORIGINAL_AGENT="${AGENT_TYPE}"
          ORIGINAL_CLI_ARGS="$CLI_ARGS"
          CLI_TYPE="claude-native"
          CLI_CMD=""
          CLI_ARGS=""
          echo "[cli-route] codex/gemini 모두 미설치: $AGENT_TYPE → claude-native fallback (원래 프로필: $MCP_PROFILE)" >&2
        fi
      fi
      ;;
  esac
}

# ── MCP 인벤토리 캐시 읽기 ──
MCP_CACHE="${HOME}/.claude/cache/mcp-inventory.json"

# 캐시에서 특정 CLI의 서버 목록 추출 (캐시 없으면 빈 문자열)
get_cached_servers() {
  local cli_type="$1"
  if [[ -f "$MCP_CACHE" ]]; then
    # node로 JSON 파싱 — 인자 전달 방식 (Windows 호환)
    node -e 'const[,f,t]=process.argv;const inv=JSON.parse(require("fs").readFileSync(f,"utf8"));const s=(inv[t]||{}).servers||[];console.log(s.filter(x=>x.status==="enabled"||x.status==="configured").map(x=>x.name).join(","))' -- "$MCP_CACHE" "$cli_type" 2>/dev/null
  fi
}

# ── MCP 프로필 → 프롬프트 접미사 ──
get_mcp_hint() {
  local profile="$1"
  local agent="$2"

  # auto 모드: 에이전트에 따라 자동 결정
  if [[ "$profile" == "auto" ]]; then
    case "$agent" in
      executor|build-fixer|debugger)
        profile="implement"
        ;;
      architect|planner|critic|analyst)
        profile="analyze"
        ;;
      code-reviewer|security-reviewer|quality-reviewer)
        profile="review"
        ;;
      scientist|document-specialist)
        profile="analyze"
        ;;
      deep-executor)
        profile="implement"
        ;;
      designer|writer)
        profile="docs"
        ;;
      *)
        profile="minimal"
        ;;
    esac
  fi

  # 동적 힌트: 캐시가 있으면 실제 서버 목록 기반으로 생성
  local cached_servers=""
  cached_servers=$(get_cached_servers "$CLI_TYPE")

  # 서버 존재 여부 헬퍼
  has_server() { echo ",$cached_servers," | grep -q ",$1,"; }

  # 캐시가 있으면 동적 힌트, 없으면 기본 힌트
  if [[ -n "$cached_servers" ]]; then
    local hint=""
    case "$profile" in
      implement)
        has_server "context7" && hint="${hint}context7으로 라이브러리 문서를 조회하세요. "
        if has_server "brave-search"; then
          hint="${hint}웹 검색은 brave-search를 사용하세요. "
        elif has_server "exa"; then
          hint="${hint}웹 검색은 exa를 사용하세요. "
        elif has_server "tavily"; then
          hint="${hint}웹 검색은 tavily를 사용하세요. "
        fi
        hint="${hint}검색 도구 실패 시 재시도하지 말고 다음 도구로 전환하세요."
        echo "$hint"
        ;;
      analyze)
        has_server "context7" && hint="${hint}context7으로 관련 문서를 조회하세요. "
        # 검색 도구 우선순위 동적 구성
        local search_tools=""
        has_server "brave-search" && search_tools="${search_tools}brave-search, "
        has_server "tavily" && search_tools="${search_tools}tavily, "
        has_server "exa" && search_tools="${search_tools}exa, "
        if [[ -n "$search_tools" ]]; then
          hint="${hint}웹 검색 우선순위: ${search_tools%%, }. 402 에러 시 즉시 다음 도구로 전환. "
        fi
        has_server "playwright" && hint="${hint}모든 검색 실패 시 playwright로 직접 방문 (최대 3 URL). "
        hint="${hint}검색 깊이를 제한하고 결과를 빠르게 요약하세요."
        echo "$hint"
        ;;
      review)
        has_server "sequential-thinking" && echo "sequential-thinking으로 체계적으로 분석하세요." || echo ""
        ;;
      docs)
        has_server "context7" && hint="${hint}context7으로 공식 문서를 참조하세요. "
        has_server "brave-search" && hint="${hint}추가 검색은 brave-search를 사용하세요. "
        hint="${hint}검색 결과의 출처 URL을 함께 제시하세요."
        echo "$hint"
        ;;
      minimal|none) echo "" ;;
      *) echo "" ;;
    esac
  else
    # 캐시 없음 → 기본 힌트 (기존 동작 유지)
    case "$profile" in
      implement)
        echo "context7으로 라이브러리 문서를 조회하세요. 웹 검색이 필요하면 brave-search를 우선 사용하고, 실패 시 exa를 시도하세요. exa/tavily가 402 에러를 반환하면 즉시 brave-search로 전환하세요."
        ;;
      analyze)
        echo "context7으로 관련 문서를 조회하세요. 웹 검색은 다음 우선순위로 사용: 1) brave-search (무료, 우선), 2) tavily (실패 시), 3) exa (최후 수단). 402 에러 발생 시 해당 도구를 재시도하지 말고 즉시 다음 도구로 전환하세요. 모든 검색 도구가 실패하면 playwright로 직접 웹페이지를 방문하여 정보를 수집하세요. 주의: URL 크롤링은 최대 3개까지만. 논문 전문 대신 제목/초록/핵심 수치만 정리하세요. 검색 깊이를 제한하고 결과를 빠르게 요약하세요."
        ;;
      review)
        echo "sequential-thinking으로 체계적으로 분석하세요."
        ;;
      docs)
        echo "context7으로 공식 문서를 참조하세요. 추가 검색이 필요하면 brave-search를 사용하세요. 사실 확인이 필요한 내용은 반드시 Google Search를 활용하여 검증하세요 (google_search 도구 사용). 검색 결과의 출처 URL을 함께 제시하세요."
        ;;
      minimal|none) echo "" ;;
      *) echo "" ;;
    esac
  fi
}

# ── Gemini MCP 서버 선택적 로드 (병렬 경합 감소) ──
# MCP 프로필별 필요한 서버만 로드하여 초기화 시간 단축
get_gemini_mcp_filter() {
  local profile="$1"
  case "$profile" in
    implement)  echo "--allowed-mcp-server-names context7,brave-search" ;;
    analyze)    echo "--allowed-mcp-server-names context7,brave-search,exa" ;;
    review)     echo "--allowed-mcp-server-names sequential-thinking" ;;
    docs)       echo "--allowed-mcp-server-names context7,brave-search" ;;
    *)          echo "" ;;  # 필터 없음 — 모든 서버 로드
  esac
}

# ── 토큰 사용량 추출 ──
# Codex JSON-line에서 usage 필드를 파싱하여 "input output" 반환
# Gemini는 세션 파일에서 추출하므로 여기선 0 반환
extract_tokens() {
  local raw="$1"
  local cli_type="$2"
  local stderr_file="$3"

  if [[ "$cli_type" == "codex" ]]; then
    # Codex CLI: stderr에 "tokens used\n76,239" 형식으로 토큰 출력
    if [[ -f "$stderr_file" ]]; then
      local total
      total=$(grep -A1 "tokens used" "$stderr_file" 2>/dev/null | tail -1 | tr -d ',' | tr -d ' ')
      if [[ -n "$total" && "$total" =~ ^[0-9]+$ && "$total" -gt 0 ]]; then
        echo "$total 0"
        return
      fi
    fi
    echo "0 0"
    return
  fi

  if [[ "$cli_type" == "gemini" ]]; then
    # Gemini CLI: ~/.gemini/tmp/*/chats/session-*.json에서 최신 세션 토큰 추출
    local gemini_tmp="${HOME}/.gemini/tmp"
    if [[ -d "$gemini_tmp" ]]; then
      local latest
      latest=$(find "$gemini_tmp" -name "session-*.json" -path "*/chats/*" -newer "$stderr_file" 2>/dev/null \
        | head -1)
      # stderr보다 새 파일 없으면 가장 최근 파일 사용
      if [[ -z "$latest" ]]; then
        latest=$(find "$gemini_tmp" -name "session-*.json" -path "*/chats/*" -printf '%T@ %p\n' 2>/dev/null \
          | sort -rn | head -1 | cut -d' ' -f2-)
        # Windows Git Bash: -printf 미지원 시 ls fallback
        if [[ -z "$latest" ]]; then
          latest=$(find "$gemini_tmp" -name "session-*.json" -path "*/chats/*" 2>/dev/null \
            | xargs ls -t 2>/dev/null | head -1)
        fi
      fi
      if [[ -n "$latest" && -f "$latest" ]]; then
        local result
        result=$(python3 -c "
import json, sys
data = json.load(open(sys.argv[1]))
inp = sum(m.get('tokens',{}).get('input',0) for m in data.get('messages',[]))
out = sum(m.get('tokens',{}).get('output',0) for m in data.get('messages',[]))
print(f'{inp} {out}')
" "$latest" 2>/dev/null) || result="0 0"
        local inp out
        inp=$(echo "$result" | awk '{print $1}')
        out=$(echo "$result" | awk '{print $2}')
        if [[ $((inp + out)) -gt 0 ]]; then
          echo "$inp $out"
          return
        fi
      fi
    fi
    echo "0 0"
    return
  fi

  echo "0 0"
}

# ── Codex JSON-line 출력 파서 ──
filter_codex_output() {
  local raw="$1"

  # JSON-line 형식이면 파싱, 아니면 그대로 반환
  if echo "$raw" | head -1 | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    echo "$raw" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        if obj.get('type') in ('message', 'completed', 'output_text'):
            text = obj.get('text', obj.get('content', obj.get('output', '')))
            if text:
                print(text)
    except json.JSONDecodeError:
        print(line)
" 2>/dev/null || echo "$raw"
  else
    echo "$raw"
  fi
}

# ── 실행 로그 기록 ──
# 각 실행의 에이전트, effort, 소요시간, 상태를 로컬에 누적 기록
LOG_DIR="${HOME}/.claude/logs"
LOG_FILE="${LOG_DIR}/cli-route-stats.jsonl"

log_execution() {
  local agent="$1"
  local cli_type="$2"
  local effort="$3"
  local run_mode="$4"
  local opus="$5"
  local exit_code="$6"
  local elapsed="$7"
  local timeout="$8"
  local mcp_profile="$9"
  local input_tokens="${10:-0}"
  local output_tokens="${11:-0}"
  local total_tokens="${12:-0}"

  mkdir -p "$LOG_DIR"

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%S")
  local status="success"
  if [[ $exit_code -eq 124 ]]; then
    status="timeout"
  elif [[ $exit_code -ne 0 ]]; then
    status="failed"
  fi

  # JSONL 한 줄 추가 (jq 없이 수동 구성)
  printf '{"ts":"%s","agent":"%s","cli":"%s","effort":"%s","run_mode":"%s","opus_oversight":"%s","status":"%s","exit_code":%d,"elapsed_sec":%d,"timeout_sec":%d,"mcp_profile":"%s","input_tokens":%d,"output_tokens":%d,"total_tokens":%d}\n' \
    "$ts" "$agent" "$cli_type" "$effort" "$run_mode" "$opus" "$status" "$exit_code" "$elapsed" "$timeout" "$mcp_profile" \
    "$input_tokens" "$output_tokens" "$total_tokens" \
    >> "$LOG_FILE" 2>/dev/null || true
}

# ── 토큰 누적 (sv-accumulator.json) ──
# 실행 성공 시 추출된 토큰을 ~/.claude/cache/sv-accumulator.json에 누적
accumulate_tokens() {
  local cli_type="$1"
  local input_tokens="$2"
  local output_tokens="$3"
  local total=$((input_tokens + output_tokens))

  # 토큰 0이면 건너뜀
  if [[ $total -eq 0 ]]; then return; fi

  local acc_file="${HOME}/.claude/cache/sv-accumulator.json"
  mkdir -p "$(dirname "$acc_file")"

  # node로 JSON 읽기/수정/쓰기 (jq 의존성 없이)
  node -e '
const fs = require("fs");
const [, file, cliType, inp, out] = process.argv;
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { data = {}; }
if (!data.codex) data.codex = { tokens: 0, calls: 0 };
if (!data.gemini) data.gemini = { tokens: 0, calls: 0 };
const key = cliType === "gemini" ? "gemini" : "codex";
data[key].tokens += Number(inp) + Number(out);
data[key].calls += 1;
data.lastUpdated = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(data, null, 2));
' -- "$acc_file" "$cli_type" "$input_tokens" "$output_tokens" 2>/dev/null || true
}

# ── CLI 이슈 자동 수집 ──
# stderr에서 알려진 에러 패턴을 감지하여 ~/.claude/cache/cli-issues.jsonl에 기록
track_cli_issue() {
  local cli_type="$1" agent="$2" stderr_text="$3" exit_code="$4"
  [[ -z "$stderr_text" && "$exit_code" -eq 0 ]] && return

  local issues_file="${HOME}/.claude/cache/cli-issues.jsonl"
  mkdir -p "$(dirname "$issues_file")"

  local pattern="" msg="" severity="warn"

  # 패턴 매칭 (가장 구체적인 것 우선)
  if echo "$stderr_text" | grep -qi "sandbox image.*missing"; then
    pattern="sandbox_missing"; msg="Docker sandbox image not found"; severity="warn"
  elif echo "$stderr_text" | grep -qi "rate.limit\|429\|too many requests"; then
    pattern="rate_limit"; msg="API rate limit exceeded"; severity="warn"
  elif echo "$stderr_text" | grep -qi "ECONNREFUSED\|ENOTFOUND\|network"; then
    pattern="network_error"; msg="Network connection failed"; severity="error"
  elif echo "$stderr_text" | grep -qi "deprecated"; then
    pattern="deprecated_flag"; msg="Deprecated flag/feature detected"; severity="warn"
  elif echo "$stderr_text" | grep -qi "API_KEY.*not.set\|auth.*fail\|unauthorized\|401"; then
    pattern="auth_error"; msg="Authentication failed"; severity="error"
  elif echo "$stderr_text" | grep -qi "ENOMEM\|out of memory\|heap"; then
    pattern="oom"; msg="Out of memory"; severity="error"
  elif [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
    pattern="unknown_error"; msg="Exit code $exit_code"; severity="warn"
  fi

  [[ -z "$pattern" ]] && return

  # 중복 방지: 같은 패턴+cli가 최근 5분 내 기록됐으면 건너뜀
  if [[ -f "$issues_file" ]]; then
    local now_ms=$(($(date +%s) * 1000))
    local dedup
    dedup=$(tail -5 "$issues_file" 2>/dev/null | grep "\"$pattern\"" | grep "\"$cli_type\"" | tail -1)
    if [[ -n "$dedup" ]]; then
      local last_ts
      last_ts=$(echo "$dedup" | sed 's/.*"ts":\([0-9]*\).*/\1/' 2>/dev/null)
      if [[ -n "$last_ts" ]] && (( now_ms - last_ts < 300000 )); then
        return  # 5분 이내 동일 이슈 → 건너뜀
      fi
    fi
  fi

  # stderr 첫 200자만 기록 (개인정보 최소화)
  local snippet
  snippet=$(echo "$stderr_text" | head -3 | cut -c1-200 | tr '\n' ' ')

  # CLI 버전 추출
  local cli_ver=""
  cli_ver=$($cli_type --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

  node -e '
const fs = require("fs");
const [,, file, cli, agent, pattern, msg, severity, snippet, ver] = process.argv;
const entry = JSON.stringify({
  ts: Date.now(), cli, agent, pattern, msg, severity,
  snippet: snippet.substring(0, 200), ver: ver || null, resolved: false
});
fs.appendFileSync(file, entry + "\n");
// 자동 회전: 200줄 초과 시 최근 100줄만 유지
const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
if (lines.length > 200) {
  fs.writeFileSync(file, lines.slice(-100).join("\n") + "\n");
}
' -- "$issues_file" "$cli_type" "$agent" "$pattern" "$msg" "$severity" "$snippet" "$cli_ver" 2>/dev/null || true
}

# ── 출력 크기 제한 ──
truncate_output() {
  local input="$1"
  local max_bytes="$2"
  local byte_count
  byte_count=$(echo "$input" | wc -c)

  if [[ $byte_count -gt $max_bytes ]]; then
    echo "$input" | head -c "$max_bytes"
    echo ""
    echo "--- [출력 ${byte_count}B → ${max_bytes}B로 절삭됨] ---"
  else
    echo "$input"
  fi
}

# ── 메인 실행 ──
main() {
  # 종료 시 활성 에이전트 레지스트리에서 자동 제거
  trap 'deregister_agent $$' EXIT

  route_agent "$AGENT_TYPE"

  # CLI 모드 오버라이드 적용 (tfx-codex/tfx-gemini 또는 auto-fallback)
  apply_cli_mode

  # CLI 경로 해석 (bare command → 절대경로)
  case "$CLI_CMD" in
    codex) CLI_CMD="$CODEX_BIN" ;;
    gemini) CLI_CMD="$GEMINI_BIN" ;;
  esac

  # 사용자 지정 타임아웃이 없으면 에이전트별 기본값 사용
  if [[ -n "$USER_TIMEOUT" ]]; then
    TIMEOUT_SEC="$USER_TIMEOUT"
  else
    TIMEOUT_SEC="$DEFAULT_TIMEOUT"
  fi

  # kteam 안정화: Gemini 에이전트 기본 타임아웃 하한 적용 (사용자 미지정 시만)
  if [[ -z "$USER_TIMEOUT" ]]; then
    case "$AGENT_TYPE" in
      designer|writer)
        if [[ "$DEFAULT_TIMEOUT" -gt 300 ]]; then
          TIMEOUT_SEC=300
        fi
        ;;
    esac
  fi

  # Claude 네이티브 에이전트는 이 스크립트로 처리 불가
  if [[ "$CLI_TYPE" == "claude-native" ]]; then
    # 에이전트별 모델 결정
    local model="sonnet"
    case "$AGENT_TYPE" in
      explore) model="haiku" ;;
      verifier|test-engineer|qa-tester) model="sonnet" ;;
    esac

    echo "ROUTE_TYPE=claude-native"
    echo "AGENT=$AGENT_TYPE"
    echo "MODEL=$model"
    echo "RUN_MODE=$RUN_MODE"
    echo "OPUS_OVERSIGHT=$OPUS_OVERSIGHT"
    echo "TIMEOUT=$TIMEOUT_SEC"
    echo "MCP_PROFILE=$MCP_PROFILE"
    # fallback 시 원래 에이전트/MCP 프로필 정보를 함께 출력 (수정 3)
    if [[ -n "$ORIGINAL_AGENT" ]]; then
      echo "ORIGINAL_AGENT=$ORIGINAL_AGENT"
      echo "ORIGINAL_CLI_ARGS=$ORIGINAL_CLI_ARGS"
    fi
    echo "PROMPT=$PROMPT"
    echo "--- Claude Task($model) 에이전트로 위임하세요 ---"
    exit 0
  fi

  # MCP 힌트를 프롬프트에 주입
  MCP_HINT=$(get_mcp_hint "$MCP_PROFILE" "$AGENT_TYPE")
  if [[ -n "$MCP_HINT" ]]; then
    FULL_PROMPT="${PROMPT}. ${MCP_HINT}"
  else
    FULL_PROMPT="$PROMPT"
  fi

  # 메타정보 출력 (stderr로)
  echo "[cli-route] type=$CLI_TYPE agent=$AGENT_TYPE effort=$CLI_EFFORT mode=$RUN_MODE timeout=${TIMEOUT_SEC}s" >&2
  echo "[cli-route] opus_oversight=$OPUS_OVERSIGHT mcp_profile=$MCP_PROFILE stderr_log=$STDERR_LOG" >&2

  # 크로스 세션 활성 에이전트 레지스트리에 등록 (수정 4)
  register_agent $$ "$CLI_TYPE" "$AGENT_TYPE"

  # CLI 실행 (stderr 분리 + 타임아웃 + 소요시간 측정)
  local exit_code=0
  local raw_output=""
  local start_time
  start_time=$(date +%s)

  if [[ "$CLI_TYPE" == "codex" ]]; then
    raw_output=$(timeout "$TIMEOUT_SEC" $CLI_CMD $CLI_ARGS "$FULL_PROMPT" 2>"$STDERR_LOG") || exit_code=$?
  elif [[ "$CLI_TYPE" == "gemini" ]]; then
    # Gemini 안정화 v2: 프로세스 생존 기반 health check + MCP 선택적 로드
    # - 프로세스 살아있음 → 정상 (MCP 초기화 중일 수 있음)
    # - 프로세스 죽음 + 출력 없음 → crash → 재시도
    # - 메인 timeout이 진짜 hang을 처리

    # Fix 4: MCP 프로필별 필요한 서버만 로드 (병렬 경합 감소)
    local gemini_mcp_filter
    gemini_mcp_filter=$(get_gemini_mcp_filter "$MCP_PROFILE")
    local gemini_args="$CLI_ARGS"
    if [[ -n "$gemini_mcp_filter" ]]; then
      gemini_args="${CLI_ARGS/--prompt/$gemini_mcp_filter --prompt}"
      echo "[cli-route] Gemini MCP 필터: $gemini_mcp_filter" >&2
    fi

    timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$FULL_PROMPT" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
    local pid=$!

    # Fix 2+3: 프로세스 생존 기반 health check (30초)
    local health_ok=true
    local HEALTH_TIMEOUT=30
    for i in $(seq 1 $HEALTH_TIMEOUT); do
      sleep 1
      # 출력 있으면 확실히 정상 → 조기 탈출
      if [[ -s "$STDOUT_LOG" ]] || [[ -s "$STDERR_LOG" ]]; then
        break
      fi
      # 프로세스 사망 + 출력 없음 → crash
      if ! kill -0 "$pid" 2>/dev/null; then
        health_ok=false
        echo "[cli-route] Gemini: 출력 없이 프로세스 종료 (${i}초)" >&2
        break
      fi
      # 프로세스 살아있고 출력 없음 → MCP 초기화 중, 계속 대기
    done

    if [[ "$health_ok" == "false" ]]; then
      # crash 감지 → 1회 재시도
      wait "$pid" 2>/dev/null
      echo "[cli-route] Gemini crash 감지, 재시도 중..." >&2
      timeout "$TIMEOUT_SEC" $CLI_CMD $gemini_args "$FULL_PROMPT" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
      pid=$!
      wait "$pid"
      exit_code=$?
    else
      wait "$pid"
      exit_code=$?
    fi

    raw_output=$(cat "$STDOUT_LOG" 2>/dev/null)
  fi

  local end_time
  end_time=$(date +%s)
  local elapsed=$((end_time - start_time))

  # 토큰 추출
  local token_info input_tokens output_tokens total_tokens
  token_info=$(extract_tokens "$raw_output" "$CLI_TYPE" "$STDERR_LOG") || token_info="0 0"
  input_tokens=$(echo "$token_info" | awk '{print $1}')
  output_tokens=$(echo "$token_info" | awk '{print $2}')
  total_tokens=$((input_tokens + output_tokens))

  # 실행 로그 기록 (토큰 포함)
  log_execution "$AGENT_TYPE" "$CLI_TYPE" "$CLI_EFFORT" "$RUN_MODE" "$OPUS_OVERSIGHT" \
    "$exit_code" "$elapsed" "$TIMEOUT_SEC" "$MCP_PROFILE" \
    "$input_tokens" "$output_tokens" "$total_tokens"

  # 성공 시 토큰 누적
  if [[ $exit_code -eq 0 ]]; then
    accumulate_tokens "$CLI_TYPE" "$input_tokens" "$output_tokens" || true
  fi

  # AIMD 배치 크기 업데이트 (exit code 기반)
  if [[ $exit_code -eq 0 ]]; then
    update_batch_result "success" "$AGENT_TYPE" || true
  elif [[ $exit_code -eq 124 ]]; then
    update_batch_result "timeout" "$AGENT_TYPE" || true
  else
    update_batch_result "failed" "$AGENT_TYPE" || true
  fi

  # CLI 이슈 자동 수집
  local _stderr_for_track=""
  [[ -f "$STDERR_LOG" ]] && _stderr_for_track=$(cat "$STDERR_LOG" 2>/dev/null || echo "")
  track_cli_issue "$CLI_TYPE" "$AGENT_TYPE" "$_stderr_for_track" "$exit_code" || true

  # 결과 처리
  local stderr_content=""
  if [[ -f "$STDERR_LOG" ]]; then
    stderr_content=$(cat "$STDERR_LOG" 2>/dev/null || echo "")
  fi

  # 헤더 (구조화된 메타데이터)
  echo "=== CLI-ROUTE RESULT ==="
  echo "agent: $AGENT_TYPE"
  echo "cli: $CLI_TYPE ($CLI_CMD)"
  echo "effort: $CLI_EFFORT"
  echo "run_mode: $RUN_MODE"
  echo "opus_oversight: $OPUS_OVERSIGHT"
  echo "exit_code: $exit_code"
  echo "timeout: ${TIMEOUT_SEC}s"
  echo "elapsed: ${elapsed}s"
  echo "mcp_profile: $MCP_PROFILE"
  echo "stderr_log: $STDERR_LOG"

  # exit code 분석
  if [[ $exit_code -eq 0 ]]; then
    if [[ -n "$stderr_content" ]]; then
      echo "status: success_with_warnings"
      echo "warnings: $(echo "$stderr_content" | head -3)"
    else
      echo "status: success"
    fi
    echo "=== OUTPUT ==="

    if [[ "$CLI_TYPE" == "codex" ]]; then
      filtered=$(filter_codex_output "$raw_output")
      truncate_output "$filtered" "$MAX_STDOUT_BYTES"
    else
      truncate_output "$raw_output" "$MAX_STDOUT_BYTES"
    fi

  elif [[ $exit_code -eq 124 ]]; then
    echo "status: timeout (${TIMEOUT_SEC}s 초과)"
    echo "=== PARTIAL OUTPUT ==="
    truncate_output "$raw_output" "$MAX_STDOUT_BYTES"
    echo "=== STDERR ==="
    echo "$stderr_content" | tail -10

  else
    echo "status: failed (exit_code=$exit_code)"
    echo "=== STDERR ==="
    echo "$stderr_content" | tail -20
    if [[ -n "$raw_output" ]]; then
      echo "=== PARTIAL OUTPUT ==="
      truncate_output "$raw_output" "$MAX_STDOUT_BYTES"
    fi
  fi
}

main
