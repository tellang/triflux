#!/usr/bin/env bash
# =============================================================================
# Codex Swarm — Full Swarm: 7 PRDs (Issues 24-30)
# Generated: 2026-03-30
# User directive: 구현=autopilot, 조사=plan만, 하나의 WT에 탭으로
# =============================================================================
# DO NOT EXECUTE — this is a dry-run generation for review.
# =============================================================================

set -euo pipefail

PROJECT_ROOT="C:/Users/SSAFY/Desktop/Projects/cli/triflux"
SWARM_DIR="$PROJECT_ROOT/.codex-swarm"
WT_DIR="$SWARM_DIR/wt-issue"
PROMPT_DIR="$SWARM_DIR/prompts"
BASH_EXE='C:\Program Files\Git\bin\bash.exe'

# =============================================================================
# Step 5: Create git worktrees
# =============================================================================

echo "=== Step 5: Creating git worktrees ==="

git worktree add "$SWARM_DIR/wt-issue-24" -b codex/issue-24 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-24" codex/issue-24

git worktree add "$SWARM_DIR/wt-issue-25" -b codex/issue-25 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-25" codex/issue-25

git worktree add "$SWARM_DIR/wt-issue-26" -b codex/issue-26 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-26" codex/issue-26

git worktree add "$SWARM_DIR/wt-issue-27" -b codex/issue-27 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-27" codex/issue-27

git worktree add "$SWARM_DIR/wt-issue-28" -b codex/issue-28 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-28" codex/issue-28

git worktree add "$SWARM_DIR/wt-issue-29" -b codex/issue-29 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-29" codex/issue-29

git worktree add "$SWARM_DIR/wt-issue-30" -b codex/issue-30 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-30" codex/issue-30

# =============================================================================
# Step 6: Generate prompts + copy PRD files into worktrees
# =============================================================================

echo "=== Step 6: Generating prompts ==="

mkdir -p "$PROMPT_DIR"

# --- Issue 24: implement -> $plan -> $autopilot ---
cp "$PROJECT_ROOT/.omx/plans/prd-issue-24-remote-spawn-file-transfer.md" \
   "$SWARM_DIR/wt-issue-24/.omx/plans/prd-issue-24-remote-spawn-file-transfer.md" 2>/dev/null || \
   { mkdir -p "$SWARM_DIR/wt-issue-24/.omx/plans" && \
     cp "$PROJECT_ROOT/.omx/plans/prd-issue-24-remote-spawn-file-transfer.md" \
        "$SWARM_DIR/wt-issue-24/.omx/plans/prd-issue-24-remote-spawn-file-transfer.md"; }

cat > "$PROMPT_DIR/prompt-24.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-24-remote-spawn-file-transfer.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬로 구현 계획을 수립하세요
3. 계획이 완료되면 $autopilot 스킬로 자율 구현을 시작하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# --- Issue 25: investigate -> $plan only ---
cp "$PROJECT_ROOT/.omx/plans/prd-issue-25-remote-spawn-resize-blank-screen.md" \
   "$SWARM_DIR/wt-issue-25/.omx/plans/prd-issue-25-remote-spawn-resize-blank-screen.md" 2>/dev/null || \
   { mkdir -p "$SWARM_DIR/wt-issue-25/.omx/plans" && \
     cp "$PROJECT_ROOT/.omx/plans/prd-issue-25-remote-spawn-resize-blank-screen.md" \
        "$SWARM_DIR/wt-issue-25/.omx/plans/prd-issue-25-remote-spawn-resize-blank-screen.md"; }

cat > "$PROMPT_DIR/prompt-25.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 조사해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-25-remote-spawn-resize-blank-screen.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬로 조사 계획을 수립하세요
3. 계획 수립까지만 진행하세요 (구현하지 마세요)

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# --- Issue 26: implement -> $plan -> $autopilot ---
cp "$PROJECT_ROOT/.omx/plans/prd-issue-26-remote-spawn-session-cleanup.md" \
   "$SWARM_DIR/wt-issue-26/.omx/plans/prd-issue-26-remote-spawn-session-cleanup.md" 2>/dev/null || \
   { mkdir -p "$SWARM_DIR/wt-issue-26/.omx/plans" && \
     cp "$PROJECT_ROOT/.omx/plans/prd-issue-26-remote-spawn-session-cleanup.md" \
        "$SWARM_DIR/wt-issue-26/.omx/plans/prd-issue-26-remote-spawn-session-cleanup.md"; }

cat > "$PROMPT_DIR/prompt-26.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-26-remote-spawn-session-cleanup.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬로 구현 계획을 수립하세요
3. 계획이 완료되면 $autopilot 스킬로 자율 구현을 시작하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# --- Issue 27: implement -> $plan -> $autopilot ---
cp "$PROJECT_ROOT/.omx/plans/prd-issue-27-hud-dashboard-anchor.md" \
   "$SWARM_DIR/wt-issue-27/.omx/plans/prd-issue-27-hud-dashboard-anchor.md" 2>/dev/null || \
   { mkdir -p "$SWARM_DIR/wt-issue-27/.omx/plans" && \
     cp "$PROJECT_ROOT/.omx/plans/prd-issue-27-hud-dashboard-anchor.md" \
        "$SWARM_DIR/wt-issue-27/.omx/plans/prd-issue-27-hud-dashboard-anchor.md"; }

cat > "$PROMPT_DIR/prompt-27.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-27-hud-dashboard-anchor.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬로 구현 계획을 수립하세요
3. 계획이 완료되면 $autopilot 스킬로 자율 구현을 시작하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# --- Issue 28: implement -> $plan -> $autopilot ---
cp "$PROJECT_ROOT/.omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md" \
   "$SWARM_DIR/wt-issue-28/.omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md" 2>/dev/null || \
   { mkdir -p "$SWARM_DIR/wt-issue-28/.omx/plans" && \
     cp "$PROJECT_ROOT/.omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md" \
        "$SWARM_DIR/wt-issue-28/.omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md"; }

cat > "$PROMPT_DIR/prompt-28.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬로 구현 계획을 수립하세요
3. 계획이 완료되면 $autopilot 스킬로 자율 구현을 시작하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# --- Issue 29: implement -> $plan -> $autopilot ---
cp "$PROJECT_ROOT/.omx/plans/prd-issue-29-headless-cwd-propagation.md" \
   "$SWARM_DIR/wt-issue-29/.omx/plans/prd-issue-29-headless-cwd-propagation.md" 2>/dev/null || \
   { mkdir -p "$SWARM_DIR/wt-issue-29/.omx/plans" && \
     cp "$PROJECT_ROOT/.omx/plans/prd-issue-29-headless-cwd-propagation.md" \
        "$SWARM_DIR/wt-issue-29/.omx/plans/prd-issue-29-headless-cwd-propagation.md"; }

cat > "$PROMPT_DIR/prompt-29.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-29-headless-cwd-propagation.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬로 구현 계획을 수립하세요
3. 계획이 완료되면 $autopilot 스킬로 자율 구현을 시작하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# --- Issue 30: investigate -> $plan only ---
cp "$PROJECT_ROOT/.omx/plans/prd-issue-30-remote-spawn-terminal-minimize.md" \
   "$SWARM_DIR/wt-issue-30/.omx/plans/prd-issue-30-remote-spawn-terminal-minimize.md" 2>/dev/null || \
   { mkdir -p "$SWARM_DIR/wt-issue-30/.omx/plans" && \
     cp "$PROJECT_ROOT/.omx/plans/prd-issue-30-remote-spawn-terminal-minimize.md" \
        "$SWARM_DIR/wt-issue-30/.omx/plans/prd-issue-30-remote-spawn-terminal-minimize.md"; }

cat > "$PROMPT_DIR/prompt-30.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 조사해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-30-remote-spawn-terminal-minimize.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬로 조사 계획을 수립하세요
3. 계획 수립까지만 진행하세요 (구현하지 마세요)

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# =============================================================================
# Step 7: Create psmux sessions + launch Codex
# =============================================================================

echo "=== Step 7: Creating psmux sessions and launching Codex ==="

# --- Issue 24: implement | codex53_high ---
psmux new-session --name "codex-swarm-24" --dir "$SWARM_DIR/wt-issue-24"
psmux send-keys --target "codex-swarm-24:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPT_DIR/prompt-24.md)\"" Enter

# --- Issue 25: investigate | gpt54_high ---
psmux new-session --name "codex-swarm-25" --dir "$SWARM_DIR/wt-issue-25"
psmux send-keys --target "codex-swarm-25:0" \
  "codex -c 'model=\"gpt-5.4\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPT_DIR/prompt-25.md)\"" Enter

# --- Issue 26: implement | codex53_high ---
psmux new-session --name "codex-swarm-26" --dir "$SWARM_DIR/wt-issue-26"
psmux send-keys --target "codex-swarm-26:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPT_DIR/prompt-26.md)\"" Enter

# --- Issue 27: implement | codex53_high ---
psmux new-session --name "codex-swarm-27" --dir "$SWARM_DIR/wt-issue-27"
psmux send-keys --target "codex-swarm-27:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPT_DIR/prompt-27.md)\"" Enter

# --- Issue 28: implement | codex53_high ---
psmux new-session --name "codex-swarm-28" --dir "$SWARM_DIR/wt-issue-28"
psmux send-keys --target "codex-swarm-28:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPT_DIR/prompt-28.md)\"" Enter

# --- Issue 29: implement | codex53_high ---
psmux new-session --name "codex-swarm-29" --dir "$SWARM_DIR/wt-issue-29"
psmux send-keys --target "codex-swarm-29:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPT_DIR/prompt-29.md)\"" Enter

# --- Issue 30: investigate | gpt54_high ---
psmux new-session --name "codex-swarm-30" --dir "$SWARM_DIR/wt-issue-30"
psmux send-keys --target "codex-swarm-30:0" \
  "codex -c 'model=\"gpt-5.4\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPT_DIR/prompt-30.md)\"" Enter

# =============================================================================
# Step 8: WT tab attach — all sessions in one window
# =============================================================================

echo "=== Step 8: Attaching all sessions to one WT window ==="

# First session: new WT window
psmux attach --session "codex-swarm-24" --wt-new-window

# Remaining sessions: tabs in same window
psmux attach --session "codex-swarm-25" --wt-tab
psmux attach --session "codex-swarm-26" --wt-tab
psmux attach --session "codex-swarm-27" --wt-tab
psmux attach --session "codex-swarm-28" --wt-tab
psmux attach --session "codex-swarm-29" --wt-tab
psmux attach --session "codex-swarm-30" --wt-tab

# --- Fallback: wt.exe direct (if psmux attach unavailable) ---
# wt.exe -w new \
#   --title "issue-24 file-transfer" -d "$SWARM_DIR/wt-issue-24" "$BASH_EXE" -c "psmux attach codex-swarm-24" \; \
#   new-tab --title "issue-25 resize-blank" -d "$SWARM_DIR/wt-issue-25" "$BASH_EXE" -c "psmux attach codex-swarm-25" \; \
#   new-tab --title "issue-26 session-cleanup" -d "$SWARM_DIR/wt-issue-26" "$BASH_EXE" -c "psmux attach codex-swarm-26" \; \
#   new-tab --title "issue-27 hud-dashboard" -d "$SWARM_DIR/wt-issue-27" "$BASH_EXE" -c "psmux attach codex-swarm-27" \; \
#   new-tab --title "issue-28 guard-deadlock" -d "$SWARM_DIR/wt-issue-28" "$BASH_EXE" -c "psmux attach codex-swarm-28" \; \
#   new-tab --title "issue-29 cwd-propagation" -d "$SWARM_DIR/wt-issue-29" "$BASH_EXE" -c "psmux attach codex-swarm-29" \; \
#   new-tab --title "issue-30 terminal-minimize" -d "$SWARM_DIR/wt-issue-30" "$BASH_EXE" -c "psmux attach codex-swarm-30"

echo "=== Swarm spawned: 7 sessions in 1 WT window (7 tabs) ==="
