#!/usr/bin/env bash
# codex-recovery.sh — codex exec stdout 4계단 recovery helper.
# 사용: STDOUT_LOG / STDERR_LOG env 설정 후 `source` + `recover_codex_stdout`.
#
# 1차 codex marker  → stderr 의 마지막 "codex" 라인 이후 본문 회수
# 2차 node parser   → MCP/header/sandbox 로그 제외, 응답 부분만 추출
# 3차 stderr tail   → "tokens used" 직전까지 tail buffer 회수
# 4차 FALLBACK_FAILED → 모두 실패 시 marker + stderr_log 경로 출력

recover_codex_stdout() {
  if [[ -s "$STDOUT_LOG" || ! -s "$STDERR_LOG" ]]; then
    return 0
  fi

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
