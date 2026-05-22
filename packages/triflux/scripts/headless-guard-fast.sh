#!/usr/bin/env bash
# headless-guard-fast.sh — bash pre-filter for headless-guard.mjs
# primary multiplexer 미설치(캐시 ok=false) 시 Node.js 기동을 생략하여 89ms→~2ms로 단축
CACHE="${TMPDIR:-${TEMP:-/tmp}}/tfx-psmux-check.json"
GUARD_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -f "$CACHE" ]]; then
  # jq 없이 순수 bash로 파싱
  ok_val=$(grep -o '"ok":[[:space:]]*\(true\|false\)' "$CACHE" | grep -o 'true\|false')
  ts_val=$(grep -o '"ts":[[:space:]]*[0-9]*' "$CACHE" | grep -o '[0-9]*')
  now_ms=$(($(date +%s) * 1000))
  age_ms=$((now_ms - ${ts_val:-0}))

  # 캐시 유효(5분 이내) + primary multiplexer 미설치 → 즉시 통과.
  # 과거 캐시는 psmux만 기록했기 때문에 macOS/Linux에서 tmux가 있으면 Node guard로 재검사한다.
  if [[ "$ok_val" == "false" && $age_ms -lt 300000 ]]; then
    case "$(uname -s 2>/dev/null)" in
      Darwin|Linux)
        if command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1; then
          exec node "$GUARD_DIR/headless-guard.mjs"
        fi
        ;;
    esac
    exit 0
  fi
fi

# 캐시 미스 또는 primary multiplexer 설치됨 → Node.js 실행
exec node "$GUARD_DIR/headless-guard.mjs"
