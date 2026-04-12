# P1: Stall False-Positive Prevention

> Source: deep-analysis 3-CLI consensus 93% (2026-04-12)
> Target: codex stall 오탐 재발 방지 인프라

## Shard: rate-limit-retry-backoff
- agent: codex
- files: hub/lib/spawn-trace.mjs, tests/unit/spawn-trace.test.mjs
- prompt: |
    hub/lib/spawn-trace.mjs의 enforceGuards()가 rate limit 초과 시 즉시 throw하는 대신,
    async retry-with-backoff를 추가한다.

    현재 구조 (line 196-200):
    - recentSpawnTimes.length >= maxSpawnPerSec → createPolicyError("rate_limit") 즉시 반환

    목표:
    1. 새 export: async function spawnWithBackoff(command, args, options, maxRetries=1)
       - enforceGuards 호출 → rate_limit 에러면 RATE_WINDOW_MS만큼 대기 후 1회 재시도
       - 재시도도 실패하면 원본 에러 throw
       - rate_limit 외 다른 에러는 즉시 throw
    2. 기존 spawn() 함수는 그대로 유지 (breaking change 방지)
    3. 테스트 추가:
       - rate limit 초과 → 대기 → 성공 케이스
       - rate limit 초과 → 대기 → 재실패 케이스
       - 다른 에러는 즉시 throw 케이스

    제약:
    - RATE_WINDOW_MS 상수 재사용 (현재 1000ms)
    - jitter 필요 없음 (단일 재시도)
    - packages/core/hub/lib/spawn-trace.mjs, packages/triflux/hub/lib/spawn-trace.mjs도 동기화

## Shard: hub-version-preflight
- agent: codex
- files: hub/team/headless.mjs, hub/server.mjs
- depends: none
- prompt: |
    headless.mjs 진입점에서 hub 버전 skew 감지를 추가한다.

    목표:
    1. hub/server.mjs의 /info 엔드포인트 확인/추가:
       - 이미 /status에 version 필드가 있는지 확인
       - 없으면 /spawn-trace/info 새 엔드포인트 추가: { version: spawnTrace.getMaxSpawnPerSec(), loaded_at: <module load time> }
    2. hub/team/headless.mjs의 runHeadless 시작 시점:
       - fetch('http://127.0.0.1:27888/status')로 hub 정보 조회
       - hub의 로드된 spawn-trace config와 현재 코드의 MAX_SPAWN_PER_SEC 비교
       - 불일치 시 console.warn: "Hub version skew detected: running=X, current=Y. Restart hub to sync."
       - fail-open (경고만, 실행은 계속)
    3. fetch 타임아웃 500ms, catch 시 무시

    제약:
    - requestJson("/status") 재사용 (bridge.mjs에서 import)
    - packages/ 동기화 포함
