# 파이프라인 상세 (thorough 기본)

> `--thorough`(기본) 모드에서 Phase 2.5-2.6과 Phase 3.5-3.7이 실행된다.
> `--quick` 플래그 시 이 파일의 내용은 적용되지 않는다.
> tfx-auto 경유 시: `-t`/`--thorough` 플래그가 있을 때만 파이프라인이 활성화된다.

## Phase 2.5: Plan (Opus Lead + Codex Scout 협업)

> 기존: Codex architect(단독, one-shot)
> 변경: Opus 설계 주도 + Codex scout(병렬 탐색) → 합산 판단 → 최종 계획

### Step 2.5.1: Opus 과제 분석 → 탐색 목록 생성

Lead(Opus)가 과제를 분석하고, 설계에 필요한 정보 탐색 목록을 인라인 생성한다:

```json
{
  "questions": [
    { "id": "q1", "question": "현재 인증 미들웨어 구조와 세션 관리 방식", "scope": "src/middleware/auth*" },
    { "id": "q2", "question": "DB 스키마와 마이그레이션 현황", "scope": "db/migrations/" }
  ]
}
```

탐색 목록은 3-7개 항목 권장. 과도하면 Codex 비용이 아닌 Lead 컨텍스트가 팽창.

### Step 2.5.2: Codex Scout 병렬 파견

각 탐색 항목마다 Codex scout를 파견하여 코드베이스 탐색:

```bash
# 각 question마다 병렬 실행
for each question:
  bash ~/.claude/scripts/tfx-route.sh scientist "${question.question}. 탐색 범위: ${question.scope}" analyze
```

**scout 실행 규칙:**
- scout는 **read-only** — 코드 수정 금지, 탐색+보고만
- 병렬 실행 (run_in_background=true)
- scope 힌트로 탐색 범위를 제한하여 정확도 향상
- MCP 프로필: `analyze` (읽기 전용 도구만)
- 팀 모드 시: slim wrapper Agent로 spawn (Shift+Down 네비게이션)
- 단일 모드 시: tfx-route.sh 직접 호출

### Step 2.5.3: Opus 종합 판단 → 최종 계획 작성

Lead(Opus)가 scout 보고를 종합하고, 전략적 설계 결정을 내린다:

1. scout 결과 수집 (모든 scout 완료 대기)
2. 아키텍처 선택, 트레이드오프 판단, 리스크 평가
3. 최종 계획 작성
4. `pipeline.writePlanFile(planContent)` 저장
5. pipeline advance: plan → prd

### Step 2.5.4: 추가 질의 루프 (선택)

계획 작성 중 추가 정보 필요 시:
- 팀 모드: 피드백 루프(Phase 0 구현)를 활용하여 scout에 "재실행:" 메시지 전송
- 단일 모드: 추가 tfx-route.sh 호출
- maxIterations 내에서 반복 가능 (기본 2회)

## Phase 2.6: PRD (Codex analyst)

1. Codex analyst로 수용 기준 확정:
   ```bash
   bash ~/.claude/scripts/tfx-route.sh analyst "${task}" analyze
   ```
2. 결과를 파이프라인 artifact에 저장:
   ```
   pipeline.setArtifact('prd_path', prdOutputPath)
   ```
3. pipeline advance: prd → exec

## Phase 3.5: Verify (Codex review)

1. pipeline advance: exec → verify
2. Codex verifier로 결과 검증:
   ```bash
   bash ~/.claude/scripts/tfx-route.sh verifier "결과 검증: ${task}" review
   ```
   — verifier는 Codex --profile thorough review로 실행됨
3. 검증 결과를 파이프라인 artifact에 저장:
   ```
   pipeline.setArtifact('verify_report', verifyOutputPath)
   ```
4. 통과 → pipeline advance: verify → complete → Phase 5 (cleanup)
5. 실패 → Phase 3.6

## Phase 3.6: Fix (Codex executor, max 3회)

1. pipeline advance: verify → fix
   — fix_attempt 자동 증가, fix_max(3) 초과 시 전이 거부
2. fix_attempt > fix_max → Phase 3.7 (ralph loop) 또는 failed 보고 → Phase 5
3. Codex executor로 실패 항목 수정:
   ```bash
   bash ~/.claude/scripts/tfx-route.sh executor "실패 항목 수정: ${failedItems}" implement
   ```
4. pipeline advance: fix → exec (재실행)
5. → Phase 3 (exec) → Phase 3.5 (verify) 재실행

## Phase 3.7: Ralph Loop (fix 3회 초과 시)

1. ralph_iteration 증가 (pipeline.restart())
2. ralph_iteration > ralph_max(10) → 최종 failed → Phase 5
3. fix_attempt 리셋, 전체 파이프라인 재시작 (Phase 2.5 plan부터)
