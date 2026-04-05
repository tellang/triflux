#!/usr/bin/env bash
# headless-guard-fast.sh — bash pre-filter for headless-guard.mjs
# psmux 미설치(캐시 ok=false) 시 Node.js 기동을 생략하여 89ms→~2ms로 단축
CACHE="${TMPDIR:-${TEMP:-/tmp}}/tfx-psmux-check.json"
GUARD_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -f "$CACHE" ]]; then
  # jq 없이 순수 bash로 파싱
  ok_val=$(grep -o '"ok":[[:space:]]*\(true\|false\)' "$CACHE" | grep -o 'true\|false')
  ts_val=$(grep -o '"ts":[[:space:]]*[0-9]*' "$CACHE" | grep -o '[0-9]*')
  now_ms=$(($(date +%s) * 1000))
  age_ms=$((now_ms - ${ts_val:-0}))

  # 캐시 유효(5분 이내) + psmux 미설치 → 즉시 통과
  if [[ "$ok_val" == "false" && $age_ms -lt 300000 ]]; then
    exit 0
  fi
fi

# 캐시 미스 또는 psmux 설치됨 → Node.js 실행
exec node "$GUARD_DIR/headless-guard.mjs"
