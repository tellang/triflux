#!/usr/bin/env bash
# =============================================================================
# Codex Swarm — 7 PRDs from .omx/plans/
# Generated for: triflux @ C:/Users/SSAFY/Desktop/Projects/cli/triflux
# 5 implement ($plan -> $autopilot), 2 investigate ($plan only)
# All sessions in one WT window with tabs
# =============================================================================

set -euo pipefail

PROJECT_ROOT="C:/Users/SSAFY/Desktop/Projects/cli/triflux"
SWARM_DIR="$PROJECT_ROOT/.codex-swarm"
PROMPTS_DIR="$SWARM_DIR/prompts"
BASH_EXE='C:\Program Files\Git\bin\bash.exe'

# ─── Phase 1: Worktree Creation ─────────────────────────────────────────────

echo "=== Phase 1: Creating worktrees ==="

git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-24" -b codex/issue-24 2>/dev/null || \
git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-24" codex/issue-24

git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-25" -b codex/issue-25 2>/dev/null || \
git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-25" codex/issue-25

git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-26" -b codex/issue-26 2>/dev/null || \
git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-26" codex/issue-26

git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-27" -b codex/issue-27 2>/dev/null || \
git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-27" codex/issue-27

git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-28" -b codex/issue-28 2>/dev/null || \
git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-28" codex/issue-28

git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-29" -b codex/issue-29 2>/dev/null || \
git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-29" codex/issue-29

git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-30" -b codex/issue-30 2>/dev/null || \
git -C "$PROJECT_ROOT" worktree add "$SWARM_DIR/wt-issue-30" codex/issue-30

echo "  7 worktrees created under $SWARM_DIR/"

# ─── Phase 2: Copy PRD files into worktrees ──────────────────────────────────

echo "=== Phase 2: Staging PRD files ==="

for N in 24 25 26 27 28 29 30; do
  mkdir -p "$SWARM_DIR/wt-issue-$N/.omx/plans"
  cp "$PROJECT_ROOT/.omx/plans/prd-issue-$N-"*.md "$SWARM_DIR/wt-issue-$N/.omx/plans/" 2>/dev/null || true
done

echo "  PRD files staged into worktrees"

# ─── Phase 3: Generate prompt files ─────────────────────────────────────────

echo "=== Phase 3: Generating prompts ==="

mkdir -p "$PROMPTS_DIR"

# --- Issue #24: implement -> $plan -> $autopilot ---
cat > "$PROMPTS_DIR/prompt-24.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-24-remote-spawn-file-transfer.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬을 사용하여 구현 계획을 수립하세요
3. 계획이 완성되면 $autopilot 스킬로 자율 구현을 진행하세요
4. Acceptance Criteria를 모두 충족하는지 검증하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 주요 수정 대상: scripts/remote-spawn.mjs
PROMPT_EOF

# --- Issue #25: investigate -> $plan only ---
cat > "$PROMPTS_DIR/prompt-25.md" << 'PROMPT_EOF'
triflux 프로젝트의 이슈를 조사해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-25-remote-spawn-resize-blank-screen.md

작업 순서:
1. 태스크 파일을 읽고 조사 요구사항을 파악하세요
2. $plan 스킬을 사용하여 조사 계획을 수립하세요
3. 재현 절차, 계측 방법, 원인 분류 기준을 포함하세요
4. 구현은 하지 마세요 — 조사 계획 수립까지만 진행하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 조사 대상: SSH PTY resize, psmux pane capture, WT alternate screen
PROMPT_EOF

# --- Issue #26: implement -> $plan -> $autopilot ---
cat > "$PROMPTS_DIR/prompt-26.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-26-remote-spawn-session-cleanup.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬을 사용하여 구현 계획을 수립하세요
3. 계획이 완성되면 $autopilot 스킬로 자율 구현을 진행하세요
4. Acceptance Criteria를 모두 충족하는지 검증하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 주요 수정 대상: scripts/remote-spawn.mjs, hub/server.mjs
PROMPT_EOF

# --- Issue #27: implement -> $plan -> $autopilot ---
cat > "$PROMPTS_DIR/prompt-27.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-27-hud-dashboard-anchor.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬을 사용하여 구현 계획을 수립하세요
3. 계획이 완성되면 $autopilot 스킬로 자율 구현을 진행하세요
4. Acceptance Criteria를 모두 충족하는지 검증하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 주요 수정 대상: hub/team/headless.mjs (dashboard attach path)
PROMPT_EOF

# --- Issue #28: implement -> $plan -> $autopilot ---
cat > "$PROMPTS_DIR/prompt-28.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬을 사용하여 구현 계획을 수립하세요
3. 계획이 완성되면 $autopilot 스킬로 자율 구현을 진행하세요
4. Acceptance Criteria를 모두 충족하는지 검증하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 주요 수정 대상: scripts/headless-guard.mjs, tests/unit/headless-guard.test.mjs
PROMPT_EOF

# --- Issue #29: implement -> $plan -> $autopilot ---
cat > "$PROMPTS_DIR/prompt-29.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-29-headless-cwd-propagation.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan 스킬을 사용하여 구현 계획을 수립하세요
3. 계획이 완성되면 $autopilot 스킬로 자율 구현을 진행하세요
4. Acceptance Criteria를 모두 충족하는지 검증하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 주요 수정 대상: hub/team/cli/commands/start/parse-args.mjs, start-headless.mjs, hub/team/headless.mjs, hub/team/backend.mjs
PROMPT_EOF

# --- Issue #30: investigate -> $plan only ---
cat > "$PROMPTS_DIR/prompt-30.md" << 'PROMPT_EOF'
triflux 프로젝트의 이슈를 조사해야 합니다.

태스크 파일을 먼저 읽으세요: .omx/plans/prd-issue-30-remote-spawn-terminal-minimize.md

작업 순서:
1. 태스크 파일을 읽고 조사 요구사항을 파악하세요
2. $plan 스킬을 사용하여 조사 계획을 수립하세요
3. 재현 스크립트, 터미널 상태 캡처 방법, 판별 기준을 포함하세요
4. 구현은 하지 마세요 — 조사 계획 수립까지만 진행하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 조사 대상: remote-spawn.mjs WT tab/pane creation, headless.mjs focus manipulation
PROMPT_EOF

echo "  7 prompt files generated in $PROMPTS_DIR/"

# ─── Phase 4: psmux Session Creation + Codex Launch ─────────────────────────

echo "=== Phase 4: Creating psmux sessions and launching Codex ==="

# --- Issue #24: implement, codex53_high ---
psmux new-session --name "codex-swarm-24" --dir "$SWARM_DIR/wt-issue-24"
psmux send-keys --target "codex-swarm-24:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPTS_DIR/prompt-24.md)\"" Enter

# --- Issue #25: investigate, gpt54_high ---
psmux new-session --name "codex-swarm-25" --dir "$SWARM_DIR/wt-issue-25"
psmux send-keys --target "codex-swarm-25:0" \
  "codex -c 'model=\"gpt-5.4\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPTS_DIR/prompt-25.md)\"" Enter

# --- Issue #26: implement, codex53_high ---
psmux new-session --name "codex-swarm-26" --dir "$SWARM_DIR/wt-issue-26"
psmux send-keys --target "codex-swarm-26:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPTS_DIR/prompt-26.md)\"" Enter

# --- Issue #27: implement, codex53_high ---
psmux new-session --name "codex-swarm-27" --dir "$SWARM_DIR/wt-issue-27"
psmux send-keys --target "codex-swarm-27:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPTS_DIR/prompt-27.md)\"" Enter

# --- Issue #28: implement, codex53_high ---
psmux new-session --name "codex-swarm-28" --dir "$SWARM_DIR/wt-issue-28"
psmux send-keys --target "codex-swarm-28:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPTS_DIR/prompt-28.md)\"" Enter

# --- Issue #29: implement, codex53_high ---
psmux new-session --name "codex-swarm-29" --dir "$SWARM_DIR/wt-issue-29"
psmux send-keys --target "codex-swarm-29:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPTS_DIR/prompt-29.md)\"" Enter

# --- Issue #30: investigate, gpt54_high ---
psmux new-session --name "codex-swarm-30" --dir "$SWARM_DIR/wt-issue-30"
psmux send-keys --target "codex-swarm-30:0" \
  "codex -c 'model=\"gpt-5.4\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $PROMPTS_DIR/prompt-30.md)\"" Enter

echo "  7 psmux sessions created, Codex launched in each"

# ─── Phase 5: WT Tab Attach — All sessions in one window ────────────────────

echo "=== Phase 5: Attaching all sessions to one WT window ==="

# First session opens a new WT window
psmux attach --session "codex-swarm-24" --wt-new-window

# Remaining 6 sessions attach as tabs in the same window
psmux attach --session "codex-swarm-25" --wt-tab
psmux attach --session "codex-swarm-26" --wt-tab
psmux attach --session "codex-swarm-27" --wt-tab
psmux attach --session "codex-swarm-28" --wt-tab
psmux attach --session "codex-swarm-29" --wt-tab
psmux attach --session "codex-swarm-30" --wt-tab

echo "  All 7 sessions attached as tabs in one WT window"

# ─── Fallback: wt.exe direct (if psmux attach --wt-tab unavailable) ─────────

# Uncomment below if psmux attach --wt-tab is not available:
#
# PSMUX_WIN=$(command -v psmux.exe || echo "psmux")
# wt.exe -w new \
#   --title "swarm-24 file-transfer" -d "$SWARM_DIR/wt-issue-24" "$BASH_EXE" -c "psmux attach codex-swarm-24" \; \
#   new-tab --title "swarm-25 resize-blank" -d "$SWARM_DIR/wt-issue-25" "$BASH_EXE" -c "psmux attach codex-swarm-25" \; \
#   new-tab --title "swarm-26 session-cleanup" -d "$SWARM_DIR/wt-issue-26" "$BASH_EXE" -c "psmux attach codex-swarm-26" \; \
#   new-tab --title "swarm-27 dashboard-anchor" -d "$SWARM_DIR/wt-issue-27" "$BASH_EXE" -c "psmux attach codex-swarm-27" \; \
#   new-tab --title "swarm-28 guard-deadlock" -d "$SWARM_DIR/wt-issue-28" "$BASH_EXE" -c "psmux attach codex-swarm-28" \; \
#   new-tab --title "swarm-29 cwd-propagation" -d "$SWARM_DIR/wt-issue-29" "$BASH_EXE" -c "psmux attach codex-swarm-29" \; \
#   new-tab --title "swarm-30 terminal-minimize" -d "$SWARM_DIR/wt-issue-30" "$BASH_EXE" -c "psmux attach codex-swarm-30"

echo ""
echo "=== Codex Swarm Complete ==="
echo "  Sessions: 7 (5 implement + 2 investigate)"
echo "  Window:   1 WT window, 7 tabs"
echo "  Monitor:  psmux capture-pane --session codex-swarm-{N} --lines 5"
