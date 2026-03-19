# --thorough 파이프라인 상세

> `--quick`(기본) 모드에서는 이 파일의 내용이 적용되지 않는다.
> `--thorough` 모드에서만 Phase 2.5-2.6과 Phase 3.5-3.7이 실행된다.

## Phase 2.5: Plan (Codex architect)

1. Hub pipeline 초기화:
   ```bash
   Bash("node hub/bridge.mjs pipeline-advance --team ${teamName} --status plan")
   ```
   — 또는 createPipeline(db, teamName) 직접 호출
2. Codex architect로 작업 분석 + 접근법 설계:
   ```bash
   bash ~/.claude/scripts/tfx-route.sh architect "${task}" analyze
   ```
3. 결과를 파이프라인 artifact에 저장:
   ```
   pipeline.setArtifact('plan_path', planOutputPath)
   ```
4. pipeline advance: plan → prd

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
