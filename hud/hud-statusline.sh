#!/bin/sh
# statusLine 진입점. triflux mods band 가 HUD 를 입력창 위에 그리는 세션이면 node 를 띄우지 않고 끝낸다.
# band 는 1분마다 표식에 "all:<시각>" 을 다시 쓰므로, 3분 넘게 멈췄거나 표식이 없으면 HUD 를 그대로 돌린다.
# 인자 1: node 실행 파일(없으면 PATH 의 node).
# Claude Code 는 입력을 닫아 주지만, 닫히지 않아도 1초 뒤에는 읽기를 끝낸다.
# 백그라운드 명령은 stdin 이 /dev/null 로 바뀌므로 fd 3 으로 넘긴다.
exec 3<&0
input=$({ cat <&3 & cat_pid=$!; (sleep 1; kill "$cat_pid" 2>/dev/null) >/dev/null 2>&1 & wait "$cat_pid"; })
exec 3<&-
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)
marker="$HOME/.claude/cache/triflux/claude-band/$sid"
if [ -n "$sid" ] && [ -f "$marker" ] && [ -n "$(find "$marker" -mmin -3 2>/dev/null)" ]; then
  case "$(head -c 4 "$marker")" in all:) exit 0 ;; esac
fi
printf '%s' "$input" | "${1:-node}" "$(dirname "$0")/hud-qos-status.mjs"
