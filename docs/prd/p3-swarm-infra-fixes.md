# P3: Swarm 인프라 근본 수정

> v10.9.17 차단 6개 이슈. architect+critic 합의 기반.

## Shard: worktree-isolation
- agent: codex
- files: hub/team/swarm-hypervisor.mjs, hub/team/worktree-lifecycle.mjs, hub/team/headless.mjs, hub/team/handoff.mjs, packages/triflux/hub/team/swarm-hypervisor.mjs, packages/triflux/hub/team/worktree-lifecycle.mjs, packages/triflux/hub/team/headless.mjs, packages/triflux/hub/team/handoff.mjs
- prompt: |
    ISSUE-4 worktree 격리 + ISSUE-1 artifact-bound accept 수정.

    ## ISSUE-4: swarm worktree 격리 연결 (회귀 리스크 9.5/10)
    swarm-hypervisor.mjs의 launchShard()에서 ensureWorktree() 호출이 누락됨.
    worktree-lifecycle.mjs:53-137에 ensureWorktree()가 이미 구현되어 있음. 호출만 연결하면 됨.

    수정 사항:
    1. swarm-hypervisor.mjs: launchShard()에서 ensureWorktree(shardName, baseBranch) 호출 추가
    2. buildSessionConfig()에 worktreePath + branchName을 세션 config에 주입
    3. integration 단계: rebaseShardOntoIntegration() + cleanupWorktree() 연결
    4. worktree-lifecycle.mjs import 추가

    ## ISSUE-1: artifact-bound accept
    headless.mjs의 collectResults()에서 worker가 실제 파일 변경 없이도 accept됨.

    수정 사항:
    1. headless.mjs: collectResults()에서 worker-local diff가 없으면 accept를 거부하고 needs_review로 강등
    2. handoff.mjs: validateHandoff()에서 files_changed가 비어있으면 자동 needs_read로 강등
    3. buildFallbackHandoff()도 동일 검증 추가

    packages/triflux/ 미러에도 동일 수정 적용.

## Shard: state-machine
- agent: codex
- depends: worktree-isolation
- files: hub/team/headless.mjs, hub/team/psmux.mjs, hub/team/swarm-hypervisor.mjs, hub/team/conductor.mjs, packages/triflux/hub/team/headless.mjs, packages/triflux/hub/team/psmux.mjs, packages/triflux/hub/team/swarm-hypervisor.mjs, packages/triflux/hub/team/conductor.mjs
- prompt: |
    ISSUE-8 stall restart token lineage + Swarm-B completion state machine 수정.
    NOTE: worktree-isolation shard가 먼저 완료됨. headless.mjs와 swarm-hypervisor.mjs에 해당 변경이 반영된 상태에서 작업할 것.

    ## ISSUE-8: stall restart token lineage
    headless.mjs:466-485 waitForCompletionWithStallDetect()에서 restart 시 _dispatch() 반환값이 state에 재채택되지 않음.

    수정 사항:
    1. headless.mjs: waitForCompletionWithStallDetect()에서 restart 후 _dispatch()의 반환값(paneId, token, logPath)을 worker state에 업데이트
    2. psmux.mjs: waitForCompletion()은 보조 채널(fallback)로만 유지. 주 채널은 headless의 stall detector

    ## Swarm-B: completion state machine
    swarm-hypervisor.mjs에서 launched/completed/integrated 상태가 구분되지 않음.

    수정 사항:
    1. swarm-hypervisor.mjs:327-328,614,709 — completedShards Set 추가
    2. conductor.on("completed") 또는 session.config.onCompleted 이벤트 배선
    3. launchReady()가 launched.has(d) 대신 completed.has(d)로 의존성 검사
    4. getStatus().completedShards가 실제 completion 수 반영

    packages/triflux/ 미러에도 동일 수정 적용.

## Shard: timeout-and-parsing
- agent: codex
- host: m2
- files: hub/team/swarm-planner.mjs, scripts/tfx-route.sh, scripts/headless-guard.mjs, packages/triflux/hub/team/swarm-planner.mjs, packages/triflux/scripts/tfx-route.sh, packages/triflux/scripts/headless-guard.mjs
- prompt: |
    Swarm-A depends:none 파싱 + ISSUE-5 timeout 통합 수정.

    ## Swarm-A: depends:none 파싱 오류
    swarm-planner.mjs:110-114에서 depends 필드가 "none", "-", 빈 문자열일 때 파싱 실패.

    수정 사항:
    1. swarm-planner.mjs: depends 파싱에서 "none", "-", "", "—" (em dash) → [] 정규화
    2. 기존 parseDependencies() 함수 또는 해당 로직 수정
    3. 테스트 추가: "none", "-", "", null, undefined, "—" 모두 빈 배열 반환 확인

    ## ISSUE-5: timeout contract 분열
    tfx-route.sh, headless-guard.mjs에서 각각 다른 timeout 값을 사용.

    수정 사항:
    1. scripts/tfx-route.sh:1528-1551 — MIN_TIMEOUT을 권고값(300)으로 하향
    2. scripts/headless-guard.mjs:317-324 — 별도 --timeout 600 하드코딩 제거
    3. timeout을 single policy로 통합: { soft: 300, hard: 600, drain: 30 }
    4. headless-guard가 tfx-route의 timeout을 존중하도록 수정 (override 대신 max() 사용)

    packages/triflux/ 미러에도 동일 수정 적용.
