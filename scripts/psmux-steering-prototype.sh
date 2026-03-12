#!/usr/bin/env bash
# psmux-steering-prototype.sh
# Windows psmux 환경에서 lead/codex-worker/gemini-worker pane을 만들고
# send-keys + pipe-pane 기반으로 실시간 CLI 스티어링을 실험하는 프로토타입.

set -euo pipefail

PSMUX_BIN="${PSMUX_BIN:-psmux}"
SESSION_NAME="${PSMUX_SESSION_NAME:-triflux-steering}"
WINDOW_NAME="${PSMUX_WINDOW_NAME:-control}"
PANE_LEAD="lead"
PANE_CODEX="codex-worker"
PANE_GEMINI="gemini-worker"
SHELL_COMMAND="${PSMUX_SHELL_COMMAND:-powershell.exe -NoLogo}"
CAPTURE_ROOT="${PSMUX_CAPTURE_ROOT:-${TMPDIR:-/tmp}/psmux-steering}"
CAPTURE_DIR="${CAPTURE_ROOT}/${SESSION_NAME}"
CAPTURE_HELPER_PATH="${CAPTURE_ROOT}/pipe-pane-capture.ps1"
COMPLETION_PREFIX="__TRIFLUX_DONE__:"
POLL_INTERVAL_SEC="${PSMUX_POLL_INTERVAL_SEC:-1}"

usage() {
  cat <<'EOF'
Usage:
  scripts/psmux-steering-prototype.sh start
  scripts/psmux-steering-prototype.sh demo
  scripts/psmux-steering-prototype.sh attach
  scripts/psmux-steering-prototype.sh send <pane-name> <command text>
  scripts/psmux-steering-prototype.sh send-no-enter <pane-name> <text>
  scripts/psmux-steering-prototype.sh steer-ps <pane-name> <powershell command>
  scripts/psmux-steering-prototype.sh wait <pane-name> <regex> [timeout-sec]
  scripts/psmux-steering-prototype.sh logs
  scripts/psmux-steering-prototype.sh cleanup

Pane names:
  lead | codex-worker | gemini-worker

Environment overrides:
  PSMUX_BIN
  PSMUX_SESSION_NAME
  PSMUX_WINDOW_NAME
  PSMUX_SHELL_COMMAND
  PSMUX_CAPTURE_ROOT
  PSMUX_POLL_INTERVAL_SEC
EOF
}

log() {
  printf '[psmux-steering] %s\n' "$*"
}

die() {
  printf '[psmux-steering] ERROR: %s\n' "$*" >&2
  exit 1
}

require_psmux() {
  command -v "$PSMUX_BIN" >/dev/null 2>&1 || die "Cannot find '$PSMUX_BIN' in PATH."
}

session_target() {
  printf '%s:%s' "$SESSION_NAME" "$WINDOW_NAME"
}

pane_target_from_index() {
  local pane_index="$1"
  printf '%s.%s' "$(session_target)" "$pane_index"
}

log_file_for() {
  local pane_name="$1"
  printf '%s/%s.log' "$CAPTURE_DIR" "$pane_name"
}

to_windows_path() {
  local path_value="$1"

  if command -v cygpath >/dev/null 2>&1; then
    cygpath -aw "$path_value"
    return 0
  fi

  printf '%s\n' "$path_value"
}

ensure_capture_helper() {
  mkdir -p "$CAPTURE_ROOT"

  cat >"$CAPTURE_HELPER_PATH" <<'EOF'
param(
  [Parameter(Mandatory = $true)][string]$Path
)

$parent = Split-Path -Parent $Path
if ($parent) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

$reader = [Console]::In
while (($line = $reader.ReadLine()) -ne $null) {
  Add-Content -LiteralPath $Path -Value $line -Encoding utf8
}
EOF
}

session_exists() {
  "$PSMUX_BIN" has-session -t "$SESSION_NAME" >/dev/null 2>&1
}

resolve_pane_target() {
  local pane_name="$1"
  local pane_index

  pane_index="$("$PSMUX_BIN" list-panes -t "$(session_target)" -F '#{pane_index} #{pane_title}' \
    | awk -v wanted="$pane_name" '$2 == wanted { print $1; exit }')"

  [[ -n "$pane_index" ]] || return 1
  pane_target_from_index "$pane_index"
}

require_pane_target() {
  local pane_name="$1"
  local pane_target

  pane_target="$(resolve_pane_target "$pane_name")"
  [[ -n "$pane_target" ]] || die "Pane '$pane_name' not found in session '$SESSION_NAME'."
  printf '%s\n' "$pane_target"
}

set_pane_title() {
  local pane_target="$1"
  local pane_name="$2"

  "$PSMUX_BIN" select-pane -t "$pane_target" -T "$pane_name" >/dev/null
}

start_capture_for_pane() {
  local pane_name="$1"
  local pane_target log_file helper_windows_path log_windows_path

  pane_target="$(require_pane_target "$pane_name")"
  log_file="$(log_file_for "$pane_name")"
  ensure_capture_helper
  helper_windows_path="$(to_windows_path "$CAPTURE_HELPER_PATH")"
  log_windows_path="$(to_windows_path "$log_file")"

  mkdir -p "$CAPTURE_DIR"
  : >"$log_file"

  "$PSMUX_BIN" pipe-pane -t "$pane_target" >/dev/null 2>&1 || true
  "$PSMUX_BIN" pipe-pane -t "$pane_target" powershell.exe -NoLogo -NoProfile -File "$helper_windows_path" "$log_windows_path" >/dev/null
  refresh_snapshot_for_pane "$pane_name"
}

start_capture_for_all_panes() {
  start_capture_for_pane "$PANE_LEAD"
  start_capture_for_pane "$PANE_CODEX"
  start_capture_for_pane "$PANE_GEMINI"
}

stop_capture_for_pane() {
  local pane_name="$1"
  local pane_target

  pane_target="$(resolve_pane_target "$pane_name" || true)"
  [[ -n "$pane_target" ]] || return 0
  "$PSMUX_BIN" pipe-pane -t "$pane_target" >/dev/null 2>&1 || true
}

refresh_snapshot_for_pane() {
  local pane_name="$1"
  local pane_target log_file

  pane_target="$(require_pane_target "$pane_name")"
  log_file="$(log_file_for "$pane_name")"
  mkdir -p "$CAPTURE_DIR"

  # Detached Windows sessions may not flush pipe-pane reliably yet.
  # Overwriting the log with a fresh capture-pane snapshot keeps
  # completion detection deterministic for the prototype.
  "$PSMUX_BIN" capture-pane -t "$pane_target" -p >"$log_file"
}

send_keys_to_pane() {
  local pane_name="$1"
  local text="$2"
  local submit="${3:-1}"
  local pane_target

  pane_target="$(require_pane_target "$pane_name")"
  "$PSMUX_BIN" send-keys -t "$pane_target" -l "$text"
  if [[ "$submit" != "0" ]]; then
    "$PSMUX_BIN" send-keys -t "$pane_target" C-m
  fi
}

dispatch_powershell_command() {
  local pane_name="$1"
  local command_text="$2"
  local token wrapped

  token="${pane_name}-$(date +%s)-$RANDOM"
  wrapped="${command_text}; \$trifluxExit = if (\$null -ne \$LASTEXITCODE) { [int]\$LASTEXITCODE } else { 0 }; Write-Output \"${COMPLETION_PREFIX}${token}:\$trifluxExit\""

  send_keys_to_pane "$pane_name" "$wrapped" 1
  printf '%s\n' "$token"
}

wait_for_pattern() {
  local pane_name="$1"
  local pattern="$2"
  local timeout_sec="${3:-300}"
  local log_file deadline

  log_file="$(log_file_for "$pane_name")"
  [[ -f "$log_file" ]] || die "Log file for pane '$pane_name' does not exist. Start capture first."

  deadline=$((SECONDS + timeout_sec))
  while (( SECONDS <= deadline )); do
    refresh_snapshot_for_pane "$pane_name"
    if grep -Eq -- "$pattern" "$log_file"; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SEC"
  done

  return 1
}

wait_for_completion_token() {
  local pane_name="$1"
  local token="$2"
  local timeout_sec="${3:-300}"
  local pattern

  pattern="${COMPLETION_PREFIX}${token}:[0-9]+"
  wait_for_pattern "$pane_name" "$pattern" "$timeout_sec"
}

print_log_locations() {
  mkdir -p "$CAPTURE_DIR"
  printf '%s\t%s\n' "$PANE_LEAD" "$(log_file_for "$PANE_LEAD")"
  printf '%s\t%s\n' "$PANE_CODEX" "$(log_file_for "$PANE_CODEX")"
  printf '%s\t%s\n' "$PANE_GEMINI" "$(log_file_for "$PANE_GEMINI")"
}

create_session_layout() {
  local lead_index codex_index gemini_index

  require_psmux

  if session_exists; then
    die "Session '$SESSION_NAME' already exists. Run cleanup first or set PSMUX_SESSION_NAME."
  fi

  mkdir -p "$CAPTURE_DIR"

  lead_index="$("$PSMUX_BIN" new-session -d -P -F '#{pane_index}' -s "$SESSION_NAME" -n "$WINDOW_NAME" -- $SHELL_COMMAND)"
  codex_index="$("$PSMUX_BIN" split-window -h -P -F '#{pane_index}' -t "$(session_target)" -- $SHELL_COMMAND)"
  gemini_index="$("$PSMUX_BIN" split-window -v -P -F '#{pane_index}' -t "$(pane_target_from_index "$codex_index")" -- $SHELL_COMMAND)"

  set_pane_title "$(pane_target_from_index "$lead_index")" "$PANE_LEAD"
  set_pane_title "$(pane_target_from_index "$codex_index")" "$PANE_CODEX"
  set_pane_title "$(pane_target_from_index "$gemini_index")" "$PANE_GEMINI"

  "$PSMUX_BIN" select-layout -t "$(session_target)" tiled >/dev/null
  "$PSMUX_BIN" select-pane -t "$(pane_target_from_index "$lead_index")" >/dev/null

  start_capture_for_all_panes
}

show_start_summary() {
  log "Session created: $SESSION_NAME"
  log "Window: $WINDOW_NAME"
  log "Attach with: $PSMUX_BIN attach -t $SESSION_NAME"
  print_log_locations
}

run_demo() {
  local lead_token codex_token gemini_token

  create_session_layout

  lead_token="$(dispatch_powershell_command "$PANE_LEAD" 'Write-Host "lead pane ready"')"
  codex_token="$(dispatch_powershell_command "$PANE_CODEX" 'Write-Host "codex-worker pane ready"')"
  gemini_token="$(dispatch_powershell_command "$PANE_GEMINI" 'Write-Host "gemini-worker pane ready"')"

  wait_for_completion_token "$PANE_LEAD" "$lead_token" 30 || die "Lead pane demo command timed out."
  wait_for_completion_token "$PANE_CODEX" "$codex_token" 30 || die "Codex pane demo command timed out."
  wait_for_completion_token "$PANE_GEMINI" "$gemini_token" 30 || die "Gemini pane demo command timed out."

  show_start_summary
}

cleanup() {
  stop_capture_for_pane "$PANE_LEAD"
  stop_capture_for_pane "$PANE_CODEX"
  stop_capture_for_pane "$PANE_GEMINI"

  if session_exists; then
    "$PSMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
  fi
}

main() {
  local action="${1:-demo}"

  case "$action" in
    start)
      create_session_layout
      show_start_summary
      ;;
    demo)
      run_demo
      ;;
    attach)
      require_psmux
      "$PSMUX_BIN" attach -t "$SESSION_NAME"
      ;;
    send)
      [[ $# -ge 3 ]] || die "Usage: $0 send <pane-name> <command text>"
      shift
      local pane_name="$1"
      shift
      send_keys_to_pane "$pane_name" "$*" 1
      ;;
    send-no-enter)
      [[ $# -ge 3 ]] || die "Usage: $0 send-no-enter <pane-name> <text>"
      shift
      local pane_name="$1"
      shift
      send_keys_to_pane "$pane_name" "$*" 0
      ;;
    steer-ps)
      [[ $# -ge 3 ]] || die "Usage: $0 steer-ps <pane-name> <powershell command>"
      shift
      local pane_name="$1"
      shift
      dispatch_powershell_command "$pane_name" "$*"
      ;;
    wait)
      [[ $# -ge 3 ]] || die "Usage: $0 wait <pane-name> <regex> [timeout-sec]"
      shift
      local pane_name="$1"
      local pattern="$2"
      local timeout_sec="${3:-300}"
      if wait_for_pattern "$pane_name" "$pattern" "$timeout_sec"; then
        log "Matched pattern for pane '$pane_name': $pattern"
      else
        die "Timed out waiting for pane '$pane_name' pattern: $pattern"
      fi
      ;;
    logs)
      print_log_locations
      ;;
    cleanup)
      cleanup
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      die "Unknown action: $action"
      ;;
  esac
}

main "$@"
