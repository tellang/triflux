#!/usr/bin/env bash
# tests/fixtures/fake-route.sh — delegator route 연동 테스트 대역

set -euo pipefail

agent_type="${1:-}"
prompt="${2:-}"
mcp_profile="${3:-auto}"
timeout_sec="${4:-0}"

if [[ "${prompt}" == *"FAIL_ROUTE"* ]]; then
  echo "fake route failed" >&2
  exit 9
fi

echo "route:${agent_type}:${mcp_profile}:${timeout_sec}:${prompt}"
echo "team=${TFX_TEAM_NAME:-} task=${TFX_TEAM_TASK_ID:-} agent=${TFX_TEAM_AGENT_NAME:-} lead=${TFX_TEAM_LEAD_NAME:-} cli=${TFX_CLI_MODE:-auto}" >&2
