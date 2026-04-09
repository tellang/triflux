# PRD: Account Broker Deep Analysis 수정사항

## 목표
deep analysis에서 발견된 P0(차단) 2건 + P1(고위험) 3건 수정.

## Shard 1: security-fix
- agent: claude
- files: hub/account-broker.mjs
- critical: true
- prompt: |
    hub/account-broker.mjs에 3가지 수정을 적용하라:

    1. **authFile path traversal guard** (P0, Critical):
       lease() 메서드의 반환값 구성 부분 (authFile: acct.mode === "auth" ? join(AUTH_BASE_PATH, acct.authFile) : undefined)에서,
       join() 결과가 AUTH_BASE_PATH 밖으로 벗어나지 않도록 검증 추가.
       ```javascript
       if (acct.mode === "auth") {
         const resolved = join(AUTH_BASE_PATH, acct.authFile);
         if (!resolved.startsWith(AUTH_BASE_PATH)) {
           this.emit("securityViolation", { id: acct.id, authFile: acct.authFile });
           return null; // path traversal 차단
         }
       }
       ```

    2. **reloadBroker() 내부 singleton 교체** (P0, High):
       reloadBroker() 함수에서 새 broker를 반환만 하지 말고, 모듈 레벨 broker 변수를 직접 교체하라:
       ```javascript
       function reloadBroker() {
         const config = loadConfig();
         if (!config) return { ok: false, error: "Config not found or invalid" };
         try {
           broker = new AccountBroker(config); // 모듈 레벨 변수 직접 교체
           return { ok: true, broker };
         } catch (err) {
           return { ok: false, error: err.message };
         }
       }
       ```

    3. **snapshot() failureTimestamps 방어 복사** (P1):
       snapshot() 메서드에서 ...acct 스프레드 후 failureTimestamps를 새 배열로 복사:
       ```javascript
       return [...this.#state.values()].map((acct) => ({
         ...acct,
         failureTimestamps: [...acct.failureTimestamps],
         remainingMs: getRemainingLeaseMs(acct, now),
         circuitState: this.#getCircuitState(acct, now).state,
       }));
       ```

    커밋하지 마라.

## Shard 2: event-rename
- agent: claude
- files: hub/account-broker.mjs
- depends: security-fix
- prompt: |
    hub/account-broker.mjs에서 allCircuitsOpen 이벤트를 noAvailableAccounts로 이름 변경하라.
    emit("allCircuitsOpen", ...) 을 emit("noAvailableAccounts", ...) 으로 변경.
    CLAUDE.md의 account-broker 섹션에서도 이벤트 목록을 업데이트하라.
    커밋하지 마라.

## Shard 3: missing-tests
- agent: codex
- files: tests/unit/account-broker.test.mjs
- depends: security-fix
- prompt: |
    tests/unit/account-broker.test.mjs에 누락된 테스트 2개를 추가하라:

    1. **half-open trial failure re-open**:
       - broker 생성, 계정 하나에 3회 lease+release(ok:false) → circuit open
       - Date.now를 10분+1ms 후로 이동 → half-open
       - lease (halfOpen: true 확인) → release(ok:false) → circuit 다시 open 확인

    2. **time-based failure decay**:
       - 2회 실패 기록
       - Date.now를 10분+1ms 후로 이동
       - 1회 더 실패
       - snapshot에서 failureTimestamps.length === 1 확인 (이전 2개는 윈도우 밖)

    기존 테스트 스타일(node:test, assert/strict) 유지. 커밋하지 마라.
