# PRD: Account Broker 아키텍처 리팩터링

## 목표
eng review에서 발견된 8개 이슈 해결: CircuitBreaker를 AccountBroker로 per-account 통합,
release() busy guard, 시간 기반 실패 감쇠, DRY adapter 추출, EventEmitter 관측성,
config 에러 로깅, reload API, 테스트 갭 8개 채우기.

## 배경
현재 CircuitBreaker(cli-adapter-base.mjs)와 AccountBroker(account-broker.mjs)가
독립적으로 동작하여, 한 계정 장애가 전체 CLI 경로를 차단하는 문제 존재.
release()에 busy guard가 없어 가짜 쿨다운 발생. 실패 카운터에 시간 감쇠 없음.

## Shard 1: core-broker
- agent: claude
- files: hub/account-broker.mjs
- critical: true
- prompt: |
    hub/account-broker.mjs를 다음과 같이 리팩터링하라:

    1. **Per-account CircuitBreaker 통합** (Issue 1+4):
       - cli-adapter-base.mjs의 createCircuitBreaker() 로직을 AccountBroker 내부로 이전
       - 각 계정마다 독립된 circuit state (closed/open/half-open) 유지
       - 실패는 타임스탬프 배열로 저장, windowMs(기본 10분) 이내 것만 유효
       - maxFailures(기본 3) 초과 시 circuit open
       - windowMs 경과 후 half-open, trial 성공 시 close

    2. **release() busy guard** (Issue 2):
       - release() 시작 부분에 `if (!acct.busy) return;` 추가
       - 비-busy 계정에 대한 중복 release 방지

    3. **EventEmitter 관측성** (Issue 5):
       - AccountBroker를 EventEmitter 상속으로 변경
       - 이벤트: 'lease' (id, provider, tier), 'release' (id, ok),
         'cooldown' (id, reason, durationMs), 'tierFallback' (provider, from, to),
         'circuitOpen' (id), 'circuitClose' (id)

    4. **Config 에러 로깅** (Issue 8):
       - loadConfig()의 catch에서 console.error로 에러 출력 후 null 반환
       - createBroker()의 catch에서도 동일

    기존 API (lease, release, markRateLimited, snapshot, nextAvailableEta) 시그니처 유지.
    lease() 반환값에 circuitState 필드 추가하지 않음 (내부 관리만).
    immutable 패턴 유지: #state.set(id, {...acct, ...changes}).
    커밋: "refactor: AccountBroker에 per-account CircuitBreaker 통합 + 관측성 추가"

## Shard 2: adapter-dry
- agent: codex
- files: hub/cli-adapter-base.mjs, hub/codex-adapter.mjs, hub/gemini-adapter.mjs
- depends: core-broker
- prompt: |
    Issue 7 (DRY) 해결: codex-adapter와 gemini-adapter에서 중복되는 execute() 로직을 추출.

    1. **cli-adapter-base.mjs에서 createCircuitBreaker 제거**:
       - export function createCircuitBreaker() 삭제
       - circuit breaker는 이제 AccountBroker 내부에서 관리됨

    2. **공통 executeWithBroker() 추출** (cli-adapter-base.mjs에 추가):
       ```javascript
       export async function executeWithBroker(runFn, opts = {}) {
         // 1. AccountBroker에서 lease
         // 2. preflight 실행
         // 3. withRetry로 runFn 실행
         // 4. 성공/실패에 따라 release
         // 5. circuit 상태는 AccountBroker가 자동 관리
       }
       ```

    3. **codex-adapter.mjs / gemini-adapter.mjs 수정**:
       - 전역 `const breaker = createCircuitBreaker()` 제거
       - execute()를 executeWithBroker(runCodex, opts) 호출로 대체
       - getCircuitState()는 AccountBroker.snapshot()을 래핑하거나 제거

    기존 외부 API 유지: execute(opts), buildExecArgs(opts).
    커밋: "refactor: codex/gemini adapter DRY — executeWithBroker() 공통 추출"

## Shard 3: tests
- agent: codex
- files: tests/unit/account-broker.test.mjs
- depends: core-broker, adapter-dry
- prompt: |
    account-broker.test.mjs에 8개 테스트 갭을 채워라.
    Shard 1에서 리팩터링된 AccountBroker API를 사용한다.

    추가할 테스트:
    1. TTL 만료 프루닝: leasedAt을 31분 전으로 설정 후, 다음 lease()에서 자동 해제 확인
    2. release() busy guard: 비-busy 계정에 release(ok:false) 호출 시 failures 증가 안 됨
    3. markRateLimited() unknown ID: 존재하지 않는 ID에 호출 시 에러 없이 무시
    4. nextAvailableEta() 빈 provider: 계정 0개인 provider에 null 반환
    5. CircuitBreaker half-open → trial success → close: 윈도우 경과 후 성공하면 circuit 닫힘
    6. CircuitBreaker half-open → trial fail → re-open: 윈도우 경과 후 실패하면 다시 열림
    7. resolveEnvValues $없는 값: env에 '$' 접두사 없는 값은 그대로 통과
    8. 시간 기반 실패 감쇠: 윈도우 외 실패는 카운트에서 제거됨

    node:test describe/it 패턴, assert/strict 사용. 기존 테스트 스타일 유지.
    커밋: "test: account-broker 8개 테스트 갭 채우기 — 커버리지 64%→95%"

## Shard 4: reload-api
- agent: codex
- files: packages/core/hub/index.mjs
- depends: core-broker
- prompt: |
    Issue 3 해결: Hub bridge에 /broker/reload 엔드포인트 추가.

    packages/core/hub/index.mjs (또는 hub server가 라우트를 등록하는 파일)에:
    1. POST /broker/reload 핸드러 추가
    2. accounts.json을 다시 읽어서 AccountBroker 인스턴스 교체
    3. 응답: { ok: true, accounts: N } 또는 { ok: false, error: "..." }
    4. 기존 lease 상태는 유지하지 않아도 됨 (reload = fresh start)

    기존 라우트 패턴에 맞춰 구현.
    커밋: "feat: /broker/reload 엔드포인트 — 장시간 세션에서 계정 설정 핫리로드"

## Shard 5: docs
- agent: gemini
- files: CLAUDE.md
- depends: core-broker
- prompt: |
    Issue 6 해결: CLAUDE.md에 AccountBroker 아키텍처 문서화.

    CLAUDE.md의 적절한 위치에 다음 내용 추가:
    - conductor, headless, swarm-hypervisor가 같은 AccountBroker 싱글턴을 공유한다는 사실
    - per-account CircuitBreaker가 계정 단위 장애 격리를 제공한다는 사실
    - /broker/reload로 장시간 세션에서 계정 설정 변경 가능
    - busy 플래그로 동시 lease 방지

    짧게, 운영에 필요한 정보만. 코드 설명 아닌 운영 가이드.
    커밋: "docs: CLAUDE.md에 AccountBroker 동시 lease + reload 문서 추가"
