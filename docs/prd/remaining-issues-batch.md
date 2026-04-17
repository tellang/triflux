# 남은 이슈 일괄 처리

## Shard: kill-signal-fix
- agent: codex
- files: hub/team/process-cleanup.mjs, hub/lib/process-utils.mjs, packages/triflux/hub/team/process-cleanup.mjs, packages/triflux/hub/lib/process-utils.mjs
- prompt: |
    ISSUE-3: Windows에서 kill -9 (SIGKILL)이 무효한 문제 수정.

    Windows에서 process.kill(pid, 'SIGKILL') 또는 kill -9가 동작하지 않음.
    taskkill /F /PID 또는 process.kill(pid)로 대체해야 함.

    수정:
    1. hub/team/process-cleanup.mjs에서 SIGKILL 사용하는 곳을 찾아서 Windows 분기 추가
    2. Windows: child_process.execSync(`taskkill /F /PID ${pid}`) 또는 process.kill(pid)
    3. 비-Windows: 기존 SIGKILL 유지
    4. hub/lib/process-utils.mjs에도 동일 패턴이 있으면 수정
    5. packages/triflux/ 미러 동기화

## Shard: hook-spam-fix
- agent: codex
- files: hooks/hook-orchestrator.mjs, hooks/hook-manager.mjs, packages/triflux/hooks/hook-orchestrator.mjs, packages/triflux/hooks/hook-manager.mjs
- prompt: |
    ISSUE-10: PreToolUse:Bash hook이 3중 fan-out으로 과도하게 실행되는 문제.

    현재 hook-orchestrator.mjs에서 PreToolUse:Bash 이벤트가 여러 hook에 동시 fan-out됨.
    safety-guard, headless-guard, error-context 등이 모두 같은 이벤트를 받아 중복 처리.

    수정:
    1. hook-orchestrator.mjs에서 PreToolUse:Bash fan-out 로직을 찾음
    2. 동일 이벤트에 대해 priority 기반 단일 실행 또는 dedupe 로직 추가
    3. 최고 priority hook만 실행하거나, 결과를 캐시하여 후속 hook이 재계산하지 않도록
    4. packages/triflux/ 미러 동기화

## Shard: synapse-drift-fix
- agent: codex
- files: hub/team/synapse-http.mjs, hub/team/synapse-registry.mjs, packages/triflux/hub/team/synapse-http.mjs, packages/triflux/hub/team/synapse-registry.mjs
- prompt: |
    ISSUE-7: synapse-http 배선 drift 수정.

    root의 hub/team/synapse-http.mjs와 packages/triflux/hub/team/synapse-http.mjs 사이에
    배선이 다를 수 있음 (root에서만 수정되고 package에 반영 안 된 케이스).

    수정:
    1. root와 packages/triflux 두 파일을 비교 (diff)
    2. 차이가 있으면 root를 정본으로 삼아 packages/triflux에 동기화
    3. synapse-registry.mjs도 동일하게 비교 + 동기화
    4. import 경로나 상대경로 차이가 있으면 그것도 정리

## Shard: awaitable-integration
- agent: codex
- files: hub/team/swarm-hypervisor.mjs, hub/team/swarm-reconciler.mjs, packages/triflux/hub/team/swarm-hypervisor.mjs, packages/triflux/hub/team/swarm-reconciler.mjs
- prompt: |
    Swarm-C: integrationComplete awaitable API 추가.

    현재 swarm-hypervisor.mjs에서 integration 완료를 외부에서 await할 수 있는 API가 없음.
    caller가 integration 완료를 polling해야 함.

    수정:
    1. swarm-hypervisor.mjs에 integrationComplete() 메서드 추가 — Promise를 반환
    2. 내부적으로 모든 shard가 integrated 상태가 되면 resolve
    3. 실패 shard가 있으면 partial result와 함께 resolve (reject하지 않음)
    4. getStatus()에 integrationPromise 상태 노출
    5. packages/triflux/ 미러 동기화

## Shard: spawn-trace-governance
- agent: codex
- host: m2
- files: hub/lib/spawn-trace.mjs, hub/server.mjs, packages/triflux/hub/lib/spawn-trace.mjs, packages/triflux/hub/server.mjs
- prompt: |
    ISSUE-6: spawn-trace reload가 이미 구현되어 있지만 governance 문제.

    root의 hub/lib/spawn-trace.mjs와 packages/triflux, packages/core 사이에
    구현이 다를 수 있음. root에서만 수정되고 package에 반영 안 된 케이스.

    수정:
    1. root hub/lib/spawn-trace.mjs를 정본으로 확인
    2. packages/triflux/hub/lib/spawn-trace.mjs와 diff 비교
    3. 차이가 있으면 root를 정본으로 동기화
    4. hub/server.mjs도 동일 비교 + 동기화
    5. packages/core/hub/lib/spawn-trace.mjs도 동기화 확인
