# PRD: Broker Dashboard v2 — 쿼터 게이지 안정화 + circuit 분리

## 배경

v10.9.7~9에서 broker dashboard + quota-refresh API를 추가했으나:
1. `/broker/quota-refresh`가 Hub를 크래시시킴 (unhandled rejection 추정)
2. 인프라 에러(모듈 누락 등)가 계정별 circuit breaker를 일괄 오염시킴
3. 배포 필요 (v10.9.10)

## Shard: quota-refresh-fix
- agent: codex
- files: hub/server.mjs, packages/triflux/hub/server.mjs
- prompt: |
  `/broker/quota-refresh` POST 엔드포인트가 Hub를 크래시시킨다.
  `refreshAllAccountQuotas()`는 11개 계정에 fetch 호출하는 async 함수.

  디버그:
  1. server.mjs에서 `refreshAllAccountQuotas` 함수를 찾아 읽어라
  2. `checkSingleAccountQuota` 각 계정에서 fetch 실패 시 에러 전파 경로 확인
  3. brokerInstance가 null일 때의 처리 확인
  4. AUTH_BASE_PATH가 server.mjs 스코프에 없을 수 있음 — import 확인

  수정:
  - 누락 import/변수 추가
  - 각 계정 체크를 개별 try-catch로 감싸서 한 계정 실패가 전체를 죽이지 않게
  - 수정 후 `node --check hub/server.mjs`로 문법 검증

## Shard: circuit-separation
- agent: codex
- files: hub/account-broker.mjs, hub/cli-adapter-base.mjs, packages/triflux/hub/account-broker.mjs, packages/triflux/hub/cli-adapter-base.mjs
- depends: quota-refresh-fix
- prompt: |
  현재 AccountBroker의 circuit breaker가 인프라 에러(모듈 누락, 서버 에러)와
  쿼터 에러(429 rate limit)를 동일하게 취급한다. 인프라 에러로 모든 계정의
  circuit이 일괄 open되는 문제.

  수정:
  1. `cli-adapter-base.mjs`의 `release()` 호출 시 failureMode 전달:
     - `failureMode === "rate_limited"` → 기존 markRateLimited (이미 구현됨)
     - `failureMode === "crash"` 또는 인프라 에러 → circuit에 카운트하지 않음
  2. `account-broker.mjs`의 `release(accountId, result)` 수정:
     - `result.skipCircuit === true`이면 circuit failure 기록 건너뛰기
     - cooldown도 걸지 않음 (인프라 문제는 계정 문제가 아님)
  3. `cli-adapter-base.mjs`에서 release 호출 시:
     - `lastResult.failureMode === "crash"` → `{ ok: false, skipCircuit: true }`
     - `lastResult.failureMode === "rate_limited"` → 기존 markRateLimited (변경 없음)
     - 나머지 → `{ ok: false }` (기존 동작)

  packages/triflux/ 복사본도 동일하게 수정.
  수정 후 `node --check` 문법 검증.

## Shard: release-v10-9-10
- agent: claude
- depends: quota-refresh-fix, circuit-separation
- prompt: |
  두 shard 완료 후:
  1. package.json, packages/triflux/package.json, .claude-plugin/marketplace.json 버전을 10.9.10으로 범프
  2. git add + commit: "chore: v10.9.10 — quota-refresh 크래시 수정, circuit 인프라 분리"
  3. git push origin main
  4. cd packages/triflux && npm publish
  5. gh release create v10.9.10
  6. npm install -g triflux@10.9.10
