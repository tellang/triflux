#!/usr/bin/env bash
# =============================================================================
# tfx-codex-swarm — Generated Commands (Steps 5-8)
# =============================================================================
# 사용자 요청: "이 PRD 3개 파일을 각각 독립적으로 코덱스한테 맡겨서 병렬로 구현해줘"
# 생성일: 2026-03-30
# 상태: DRY-RUN (실제 실행 없음)
# =============================================================================

set -euo pipefail

PROJECT_ROOT="C:/Users/SSAFY/Desktop/Projects/cli/triflux"
SWARM_DIR="$PROJECT_ROOT/.codex-swarm"
BASH_EXE='C:\Program Files\Git\bin\bash.exe'

# =============================================================================
# Step 5: Worktree 생성
# =============================================================================

echo "=== Step 5: Worktree 생성 ==="

# auth-refactor worktree
git worktree add "$SWARM_DIR/wt-auth-refactor" -b codex/auth-refactor 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-auth-refactor" codex/auth-refactor

# api-v2 worktree
git worktree add "$SWARM_DIR/wt-api-v2" -b codex/api-v2 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-api-v2" codex/api-v2

# cache-layer worktree
git worktree add "$SWARM_DIR/wt-cache-layer" -b codex/cache-layer 2>/dev/null || \
git worktree add "$SWARM_DIR/wt-cache-layer" codex/cache-layer

# =============================================================================
# Step 6: 프롬프트 생성
# =============================================================================

echo "=== Step 6: 프롬프트 생성 ==="

mkdir -p "$SWARM_DIR/prompts"

# --- auth-refactor 프롬프트 ---
cat > "$SWARM_DIR/prompts/prompt-auth-refactor.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 리팩터링해야 합니다.

태스크 파일을 먼저 읽으세요: docs/prd/auth-refactor.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan을 실행하여 리팩터링 계획을 수립하세요
3. $ralph를 실행하여 완료까지 반복 실행하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# PRD를 worktree에 복사
cp "$PROJECT_ROOT/docs/prd/auth-refactor.md" "$SWARM_DIR/wt-auth-refactor/docs/prd/auth-refactor.md" 2>/dev/null || true

# --- api-v2 프롬프트 ---
cat > "$SWARM_DIR/prompts/prompt-api-v2.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: docs/prd/api-v2.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan을 실행하여 구현 계획을 수립하세요
3. $autopilot을 실행하여 자율 구현하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# PRD를 worktree에 복사
cp "$PROJECT_ROOT/docs/prd/api-v2.md" "$SWARM_DIR/wt-api-v2/docs/prd/api-v2.md" 2>/dev/null || true

# --- cache-layer 프롬프트 ---
cat > "$SWARM_DIR/prompts/prompt-cache-layer.md" << 'PROMPT_EOF'
triflux 프로젝트의 태스크를 구현해야 합니다.

태스크 파일을 먼저 읽으세요: docs/prd/cache-layer.md

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. $plan을 실행하여 구현 계획을 수립하세요
3. $autopilot을 실행하여 자율 구현하세요

프로젝트 정보:
- triflux: Claude Code용 멀티모델 CLI 오케스트레이터
- 언어: JavaScript/ESM (Node.js), 테스트: npm test
PROMPT_EOF

# PRD를 worktree에 복사
cp "$PROJECT_ROOT/docs/prd/cache-layer.md" "$SWARM_DIR/wt-cache-layer/docs/prd/cache-layer.md" 2>/dev/null || true

# =============================================================================
# Step 7: psmux 세션 생성 + Codex 실행
# =============================================================================

echo "=== Step 7: psmux 세션 + Codex 실행 ==="

# 공통 프로파일 플래그 (전부 codex53_high)
PROFILE_FLAGS="-c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"'"

# --- auth-refactor 세션 ---
psmux new-session --name "codex-swarm-auth-refactor" --dir "$SWARM_DIR/wt-auth-refactor"

psmux send-keys --target "codex-swarm-auth-refactor:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $SWARM_DIR/prompts/prompt-auth-refactor.md)\"" Enter

# --- api-v2 세션 ---
psmux new-session --name "codex-swarm-api-v2" --dir "$SWARM_DIR/wt-api-v2"

psmux send-keys --target "codex-swarm-api-v2:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $SWARM_DIR/prompts/prompt-api-v2.md)\"" Enter

# --- cache-layer 세션 ---
psmux new-session --name "codex-swarm-cache-layer" --dir "$SWARM_DIR/wt-cache-layer"

psmux send-keys --target "codex-swarm-cache-layer:0" \
  "codex -c 'model=\"gpt-5.3-codex\"' -c 'model_reasoning_effort=\"high\"' --full-auto \"\$(cat $SWARM_DIR/prompts/prompt-cache-layer.md)\"" Enter

# =============================================================================
# Step 8: WT 탭 일괄 attach
# =============================================================================

echo "=== Step 8: WT 탭 attach ==="

# 첫 번째 세션: 새 WT 윈도우
psmux attach --session "codex-swarm-auth-refactor" --wt-new-window

# 나머지 세션: 같은 윈도우에 탭 추가
psmux attach --session "codex-swarm-api-v2" --wt-tab
psmux attach --session "codex-swarm-cache-layer" --wt-tab

# --- fallback: psmux attach 불가 시 wt.exe 직접 호출 ---
# wt.exe -w new \
#   --title "auth-refactor" -d "$SWARM_DIR/wt-auth-refactor" "$BASH_EXE" -c "psmux attach codex-swarm-auth-refactor" \; \
#   new-tab --title "api-v2" -d "$SWARM_DIR/wt-api-v2" "$BASH_EXE" -c "psmux attach codex-swarm-api-v2" \; \
#   new-tab --title "cache-layer" -d "$SWARM_DIR/wt-cache-layer" "$BASH_EXE" -c "psmux attach codex-swarm-cache-layer"

echo "=== 스웜 스폰 완료 ==="
echo ""
echo "| # | 태스크          | 유형       | OMX 스킬            | Worktree            | 세션                        |"
echo "|---|-----------------|------------|---------------------|---------------------|-----------------------------|"
echo "| 1 | auth-refactor   | 리팩터링   | \$plan→\$ralph      | wt-auth-refactor    | codex-swarm-auth-refactor   |"
echo "| 2 | api-v2          | 구현       | \$plan→\$autopilot  | wt-api-v2           | codex-swarm-api-v2          |"
echo "| 3 | cache-layer     | 구현       | \$plan→\$autopilot  | wt-cache-layer      | codex-swarm-cache-layer     |"
