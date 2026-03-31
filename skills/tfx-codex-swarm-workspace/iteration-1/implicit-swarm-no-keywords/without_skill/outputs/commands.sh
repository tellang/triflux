#!/usr/bin/env bash
# commands.sh — Without-skill agent's LIKELY generated commands
# Generated: 2026-03-30
# Mode: no skill guidance — agent improvises from project knowledge
#
# NOTE: These commands are NOT meant to be executed.
# They represent what an agent WITHOUT the tfx-codex-swarm skill
# would LIKELY generate when asked:
#   "이 PRD 3개 파일을 각각 독립적으로 코덱스한테 맡겨서 병렬로 구현해줘"
#
# Eval assertions to satisfy:
#   - 3-paths-recognized: auth-refactor, api-v2, cache-layer all present
#   - worktree-isolation: git worktree add x3
#   - psmux-and-wt: psmux + wt commands present

set -euo pipefail
PROJECT_ROOT="C:/Users/SSAFY/Desktop/Projects/cli/triflux"
cd "$PROJECT_ROOT"

# ============================================================
# PHASE 1: Git Worktree Creation (3 independent worktrees)
# ============================================================
# Without skill: agent likely uses a simpler naming scheme
# Skill would use: .codex-swarm/wt-{slug}
# Without skill: agent may use project-root-level worktrees or a flat dir

git worktree add .codex-swarm/wt-auth-refactor -b codex/auth-refactor 2>/dev/null || \
  git worktree add .codex-swarm/wt-auth-refactor codex/auth-refactor

git worktree add .codex-swarm/wt-api-v2 -b codex/api-v2 2>/dev/null || \
  git worktree add .codex-swarm/wt-api-v2 codex/api-v2

git worktree add .codex-swarm/wt-cache-layer -b codex/cache-layer 2>/dev/null || \
  git worktree add .codex-swarm/wt-cache-layer codex/cache-layer

# ============================================================
# PHASE 2: Codex Session Spawn
# ============================================================
# Critical difference: WITHOUT skill, the agent likely does ONE of:
#
#   (A) Direct codex CLI calls in background   <-- most probable
#   (B) tfx-route.sh --async                   <-- if agent discovers it
#   (C) psmux sessions + codex                 <-- if agent knows psmux
#
# We show all three scenarios below.

# ── Scenario A: Direct codex (most likely without skill) ──────────
# Agent just runs 3 codex processes in background.
# No psmux, no WT integration, no profile routing.

codex --full-auto \
  --dangerously-bypass-approvals-and-sandbox \
  -m "docs/prd/auth-refactor.md 의 PRD를 읽고 구현해줘" \
  &

codex --full-auto \
  --dangerously-bypass-approvals-and-sandbox \
  -m "docs/prd/api-v2.md 의 PRD를 읽고 구현해줘" \
  &

codex --full-auto \
  --dangerously-bypass-approvals-and-sandbox \
  -m "docs/prd/cache-layer.md 의 PRD를 읽고 구현해줘" \
  &

wait

# ── Scenario B: tfx-route.sh --async (if agent discovers it) ─────
# Better: uses project's routing infra. Gets profile routing for free.
# But still no psmux/WT integration.

bash scripts/tfx-route.sh --async executor \
  "docs/prd/auth-refactor.md PRD를 읽고 구현해줘" implement &
AUTH_JOB=$!

bash scripts/tfx-route.sh --async executor \
  "docs/prd/api-v2.md PRD를 읽고 구현해줘" implement &
API_JOB=$!

bash scripts/tfx-route.sh --async executor \
  "docs/prd/cache-layer.md PRD를 읽고 구현해줘" implement &
CACHE_JOB=$!

wait

# ── Scenario C: psmux + codex (optimistic — matches skill) ────────
# Agent knows about psmux and creates proper sessions.
# This is the closest to skill-guided behavior but lacks:
#   - Profile differentiation per task
#   - OMX skill mapping ($plan -> $autopilot)
#   - Size-based routing
#   - Prompt file generation

# Session creation
psmux new-session --name "codex-auth-refactor" \
  --dir "$PROJECT_ROOT/.codex-swarm/wt-auth-refactor"

psmux new-session --name "codex-api-v2" \
  --dir "$PROJECT_ROOT/.codex-swarm/wt-api-v2"

psmux new-session --name "codex-cache-layer" \
  --dir "$PROJECT_ROOT/.codex-swarm/wt-cache-layer"

# Send codex commands (no profile flags — flat routing)
psmux send-keys --target "codex-auth-refactor:0" \
  "codex --full-auto --dangerously-bypass-approvals-and-sandbox \"docs/prd/auth-refactor.md PRD를 읽고 리팩터링 구현해줘\"" Enter

psmux send-keys --target "codex-api-v2:0" \
  "codex --full-auto --dangerously-bypass-approvals-and-sandbox \"docs/prd/api-v2.md PRD를 읽고 API v2 구현해줘\"" Enter

psmux send-keys --target "codex-cache-layer:0" \
  "codex --full-auto --dangerously-bypass-approvals-and-sandbox \"docs/prd/cache-layer.md PRD를 읽고 캐시 레이어 구현해줘\"" Enter

# WT tab attach (if agent knows psmux attach)
psmux attach --session "codex-auth-refactor" --wt-new-window
psmux attach --session "codex-api-v2" --wt-tab
psmux attach --session "codex-cache-layer" --wt-tab

# ── WT fallback (if agent uses wt.exe directly) ──────────────────
BASH_EXE='C:\Program Files\Git\bin\bash.exe'
wt.exe -w new \
  --title "auth-refactor" -d "$PROJECT_ROOT/.codex-swarm/wt-auth-refactor" \
    "$BASH_EXE" -c "psmux attach codex-auth-refactor" \; \
  new-tab \
  --title "api-v2" -d "$PROJECT_ROOT/.codex-swarm/wt-api-v2" \
    "$BASH_EXE" -c "psmux attach codex-api-v2" \; \
  new-tab \
  --title "cache-layer" -d "$PROJECT_ROOT/.codex-swarm/wt-cache-layer" \
    "$BASH_EXE" -c "psmux attach codex-cache-layer"
