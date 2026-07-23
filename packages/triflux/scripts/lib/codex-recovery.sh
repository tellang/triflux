#!/usr/bin/env bash
# codex-recovery.sh — codex exec stdout 4계단 recovery helper.
# 사용: STDOUT_LOG / STDERR_LOG env 설정 후 `source` + `recover_codex_stdout`.
#
# 1차 codex marker  → stderr 의 마지막 "codex" 라인 이후 본문 회수
# 2차 node parser   → MCP/header/sandbox 로그 제외, 응답 부분만 추출
# 3차 stderr tail   → "tokens used" 직전까지 tail buffer 회수
# 4차 FALLBACK_FAILED → 모두 실패 시 marker + stderr_log 경로 출력

recover_codex_stdout() {
  # 복구 진입 여부 플래그(전역, local 아님) — 아우터 no-op 가드가 읽는다.
  # 0 = 진짜 stdout 존재(복구 미진입), 1 = stdout 이 애초에 비어 복구 진입함.
  CODEX_STDOUT_WAS_RECOVERED=0
  if [[ -s "$STDOUT_LOG" || ! -s "$STDERR_LOG" ]]; then
    return 0
  fi
  # 여기 도달 = stdout 이 애초에 비어있었다. 아래에서 STDOUT_LOG 에 채워지는 내용은
  # 전부 stderr 에서 복구된 것이지 워커의 진짜 산출물이 아니다. 이 플래그로 아우터
  # 가드가 "복구된 stderr 노이즈"를 성공 출력으로 오인하지 않게 한다(#result-verification).
  CODEX_STDOUT_WAS_RECOVERED=1

  # 1차: codex marker
  sed 's/\r$//' "$STDERR_LOG" \
    | awk '/^codex$/{found=NR;content=""} found && NR>found{content=content RS $0} END{if(content) print substr(content,2)}' \
    > "$STDOUT_LOG"

  # 2차: node parser (MCP/header/sandbox 로그 제외)
  if [[ ! -s "$STDOUT_LOG" ]]; then
    node -e '
      const fs=require("fs"),lines=fs.readFileSync(process.argv[1],"utf-8").split(/\r?\n/);
      const skip=/^(mcp[: ]|OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|user$|tokens used|EXIT:|exec$|"[A-Z]:|succeeded in |\s*$)/;
      const out=lines.filter(l=>!skip.test(l));
      if(out.length) fs.writeFileSync(process.argv[2],out.join("\n"));
    ' -- "$STDERR_LOG" "$STDOUT_LOG" 2>/dev/null || true
  fi

  # 3차: stderr tail before "tokens used"
  if [[ ! -s "$STDOUT_LOG" ]]; then
    sed 's/\r$//' "$STDERR_LOG" \
      | awk '
          /^tokens used/ { exit }
          { buf[NR]=$0 }
          END {
            start=NR-200; if (start<1) start=1
            for (i=start; i<=NR; i++) if (i in buf) print buf[i]
          }' \
      > "$STDOUT_LOG"
  fi

  if [[ -s "$STDOUT_LOG" ]]; then
    echo "[tfx-route] 경고: codex stdout 비어있음, stderr에서 응답 복구 ($(wc -c < "$STDOUT_LOG" | tr -d ' ') bytes)" >&2
  else
    # 4차: FALLBACK_FAILED
    echo "[tfx-route] FALLBACK_FAILED stderr_log=$STDERR_LOG" >&2
    echo "[tfx-route] 경고: codex stdout 비어있음, stderr 복구도 실패. 위 stderr_log 경로에서 raw codex 출력 확인 가능." >&2
  fi
}

# ── MCP transport 채널 사망 판정 ──
# Codex MCP transport 채널이 실행 중 죽으면 codex exec 가 exit 0 + 빈 stdout 으로
# 끝나는 변형이 있다(래퍼 부재로 인한 pre-flight CODEX_MCP_TRANSPORT_EXIT_CODE=70
# 과 구분됨 — 이건 런타임 채널 사망). stderr 의 하드 크래시 서명으로 이 사망을
# 검출한다. 아우터 가드가 exit 0 이어도 결과를 실패로 승격하는 근거로 쓴다.
# 인자: [stderr_log] (미지정 시 $STDERR_LOG). 반환: 0=크래시 서명 있음, 1=없음.
codex_stdout_transport_crashed() {
  local stderr_log="${1:-${STDERR_LOG:-}}"
  [[ -n "$stderr_log" && -f "$stderr_log" ]] || return 1
  grep -qE 'Transport channel closed|rmcp::transport worker quit with fatal' "$stderr_log" 2>/dev/null
}
