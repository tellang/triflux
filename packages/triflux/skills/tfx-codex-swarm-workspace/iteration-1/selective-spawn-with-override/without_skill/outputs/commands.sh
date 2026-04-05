#!/bin/bash
# commands.sh — Codex selective spawn: Issue 24, 28 only
# Profile: codex53_xhigh | Skill: $ralph | Mode: full-auto
# Generated: 2026-03-30 (without_skill variant)
#
# DO NOT EXECUTE DIRECTLY — this is a generated reference.
# The commands below show what WOULD be executed.
set -euo pipefail

PROJ_DIR="/c/Users/SSAFY/Desktop/Projects/cli/triflux"
BASH_EXE='C:\Program Files\Git\bin\bash.exe'
SWARM_DIR="$PROJ_DIR/.codex-swarm"

# ============================================================
# Step 1: Worktree Creation (2 worktrees only)
# ============================================================

cd "$PROJ_DIR"

git worktree add "$SWARM_DIR/wt-issue-24" -b codex/issue-24 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-24" codex/issue-24

git worktree add "$SWARM_DIR/wt-issue-28" -b codex/issue-28 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-issue-28" codex/issue-28

# ============================================================
# Step 2: Copy PRD files to worktrees
# ============================================================

mkdir -p "$SWARM_DIR/wt-issue-24/.omx/plans"
cp "$PROJ_DIR/.omx/plans/prd-issue-24-remote-spawn-file-transfer.md" \
   "$SWARM_DIR/wt-issue-24/.omx/plans/"

mkdir -p "$SWARM_DIR/wt-issue-28/.omx/plans"
cp "$PROJ_DIR/.omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md" \
   "$SWARM_DIR/wt-issue-28/.omx/plans/"

# ============================================================
# Step 3: Generate Prompts (with $ralph skill directive)
# ============================================================

mkdir -p "$SWARM_DIR/prompts"

cat > "$SWARM_DIR/prompts/prompt-24.md" << 'PROMPT_EOF'
triflux 프로젝트의 PRD를 구현해야 합니다.

PRD 파일을 먼저 읽으세요: .omx/plans/prd-issue-24-remote-spawn-file-transfer.md

작업 순서:
1. PRD 파일을 읽고 요구사항을 파악하세요
2. $ralph 스킬로 완료될 때까지 반복 실행하세요. 멈추지 마세요.
3. 구현 후 관련 테스트를 작성하고 npm test로 검증하세요
4. 모든 acceptance criteria를 충족할 때까지 계속하세요

핵심 요구사항:
- remote-spawn에서 --handoff 파일과 참조된 파일을 원격 호스트로 전송
- 전송 대상은 명시적이고 경계가 명확해야 함
- MAX_HANDOFF_BYTES 및 로컬 검증 동작 유지

프로젝트 컨텍스트:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 핵심 파일: scripts/remote-spawn.mjs
PROMPT_EOF

cat > "$SWARM_DIR/prompts/prompt-28.md" << 'PROMPT_EOF'
triflux 프로젝트의 PRD를 구현해야 합니다.

PRD 파일을 먼저 읽으세요: .omx/plans/prd-issue-28-headless-guard-spawn-deadlock.md

작업 순서:
1. PRD 파일을 읽고 요구사항을 파악하세요
2. $ralph 스킬로 완료될 때까지 반복 실행하세요. 멈추지 마세요.
3. 구현 후 관련 테스트를 작성하고 npm test로 검증하세요
4. 모든 acceptance criteria를 충족할 때까지 계속하세요

핵심 요구사항:
- headless-guard의 거부 메시지를 액션 지향적으로 개선
- 바이패스(TFX_ALLOW_DIRECT_CLI=1)와 승인된 headless 명령을 같은 응답에 표시
- 가드 결정 매트릭스에 대한 회귀 테스트 추가

프로젝트 컨텍스트:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
- 핵심 파일: scripts/headless-guard.mjs
PROMPT_EOF

# ============================================================
# Step 4: psmux Session Creation + Codex Launch
# ============================================================

# --- Issue 24: remote-spawn file transfer ---
psmux new-session --name "codex-swarm-24" --dir "$SWARM_DIR/wt-issue-24"

psmux send-keys --target "codex-swarm-24:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"xhigh\"' \"\$(cat $SWARM_DIR/prompts/prompt-24.md)\"" Enter

# --- Issue 28: headless-guard spawn deadlock ---
psmux new-session --name "codex-swarm-28" --dir "$SWARM_DIR/wt-issue-28"

psmux send-keys --target "codex-swarm-28:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"xhigh\"' \"\$(cat $SWARM_DIR/prompts/prompt-28.md)\"" Enter

# ============================================================
# Step 5: WT Tab Attach (2 tabs in single window)
# ============================================================

# psmux attach 방식 (우선)
psmux attach --session "codex-swarm-24" --wt-new-window
psmux attach --session "codex-swarm-28" --wt-tab

# wt.exe fallback (psmux attach 불가 시)
# wt.exe -w new \
#   --title 'I24-FileTransfer' -d "$SWARM_DIR/wt-issue-24" "$BASH_EXE" -c "psmux attach codex-swarm-24" \; \
#   new-tab --title 'I28-GuardDeadlock' -d "$SWARM_DIR/wt-issue-28" "$BASH_EXE" -c "psmux attach codex-swarm-28"

# ============================================================
# Step 6: Status Report
# ============================================================

echo ""
echo "=== Codex Selective Spawn Complete ==="
echo ""
echo "| # | Task             | Type      | OMX Skill | Profile        | Worktree     | Session         |"
echo "|---|------------------|-----------|-----------|----------------|--------------|-----------------|"
echo "| 24 | file-transfer    | implement | \$ralph   | codex53_xhigh  | wt-issue-24  | codex-swarm-24  |"
echo "| 28 | guard-deadlock   | implement | \$ralph   | codex53_xhigh  | wt-issue-28  | codex-swarm-28  |"
echo ""
echo "Sessions: 2 | Profile: codex53_xhigh | Skill: \$ralph | Mode: full-auto"
echo "Excluded: issues 25, 26, 27, 29, 30"
