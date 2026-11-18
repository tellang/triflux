#!/usr/bin/env bash
# codex exec stdout 4단계 복구 (codex marker, node parser, stderr tail, FALLBACK_FAILED).

recover_codex_stdout() {
  # 아우터 no-op 가드가 읽는 전역 복구 플래그 (0: 원본 stdout 존재, 1: stderr 복구).
  CODEX_STDOUT_WAS_RECOVERED=0
  if [[ -s "$STDOUT_LOG" || ! -s "$STDERR_LOG" ]]; then
    return 0
  fi
  # 여기 도달 = stdout 이 애초에 비어있었다. 아래에서 STDOUT_LOG 에 채워지는 내용은
  # 전부 stderr 에서 복구된 것이지 워커의 진짜 산출물이 아니다. 이 플래그로 아우터
  # 가드가 "복구된 stderr 노이즈"를 성공 출력으로 오인하지 않게 한다(#result-verification).
  CODEX_STDOUT_WAS_RECOVERED=1

  sed 's/\r$//' "$STDERR_LOG" \
    | awk '/^codex$/{found=NR;content=""} found && NR>found{content=content RS $0} END{if(content) print substr(content,2)}' \
    > "$STDOUT_LOG"

  if [[ ! -s "$STDOUT_LOG" ]]; then
    node -e '
      const fs=require("fs"),lines=fs.readFileSync(process.argv[1],"utf-8").split(/\r?\n/);
      const skip=/^(mcp[: ]|OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|user$|tokens used|EXIT:|exec$|"[A-Z]:|succeeded in |\s*$)/;
      const out=lines.filter(l=>!skip.test(l));
      if(out.length) fs.writeFileSync(process.argv[2],out.join("\n"));
    ' -- "$STDERR_LOG" "$STDOUT_LOG" 2>/dev/null || true
  fi

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
    echo "[tfx-route] FALLBACK_FAILED stderr_log=$STDERR_LOG" >&2
    echo "[tfx-route] 경고: codex stdout 비어있음, stderr 복구도 실패. 위 stderr_log 경로에서 raw codex 출력 확인 가능." >&2
  fi
}

# exit 0 이더라도 stderr 의 MCP transport 크래시 서명이 있으면 실패로 승격한다.
codex_stdout_transport_crashed() {
  local stderr_log="${1:-${STDERR_LOG:-}}"
  [[ -n "$stderr_log" && -f "$stderr_log" ]] || return 1
  grep -qE 'Transport channel closed|rmcp::transport worker quit with fatal' "$stderr_log" 2>/dev/null
}
