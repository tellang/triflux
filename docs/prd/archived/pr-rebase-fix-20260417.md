# PRD: PR #83~86 rebase + Codex 리뷰 반영

## 목표

main이 `827bec5`로 전진하면서 PR #83, #85, #86이 CONFLICTING (DIRTY), #84는 UNKNOWN 상태가 됐다. 각 PR을 worktree 격리 환경에서:

1. `main`으로 rebase
2. Codex 교차 리뷰에서 나온 구체적 피드백 반영 (nits / fix 요구사항)
3. 테스트 실행
4. `git push --force-with-lease`로 원격 PR 갱신
5. rebased/fixed 사실을 PR comment로 공지

모든 shard는 `codex` (gpt-5-codex-xhigh) agent. 파일 lease는 각 PR이 실제 수정한 파일로 격리.

---

## 공통 규칙 (모든 shard)

- agent: `codex`
- 절대 main 브랜치에 직접 commit 금지. 각 shard는 자기 PR 브랜치만 수정.
- `headless-guard` 우회 금지. codex/gemini 직접 호출 금지.
- rebase conflict 시: **main 쪽 변경이 새 파일/구조라면 유지**하고 PR 쪽 로직을 그 위에 재적용. `hooks/safety-guard.mjs`/`scripts/preinstall.mjs` 같은 로컬 uncommitted는 main에 없으므로 무시.
- 강제 push는 `--force-with-lease` 사용 (다른 누군가의 concurrent push 보호).
- 완료 후 해당 PR에 comment 추가: rebased + 반영된 변경 요약.

---

## Shard: pr-83-rebase

- agent: codex
- files: hub/server.mjs, packages/triflux/hub/server.mjs
- prompt: |
    PR #83 (fix/hub-quota-refresh-safety)을 main에 rebase + push.

    **범위**: rebase only. nit (비차단성 테스트 + 로깅 보강)은 follow-up 이슈 #91로 분리됐으므로 **이 shard에서 건드리지 않는다**.

    ## 단계
    ```bash
    git fetch origin
    git checkout -B fix/hub-quota-refresh-safety origin/fix/hub-quota-refresh-safety
    git rebase origin/main
    ```

    conflict 발생 시:
    - `hub/server.mjs`/`packages/triflux/hub/server.mjs` 안에서 quota-refresh try-catch 로직 유지
    - main의 다른 변경(PR #72 등 macOS 호환성)과 겹치면 main 구조를 base로 하여 quota-refresh 로직 재적용
    - 해결 불가 시 `git rebase --abort` 후 stdout에 "pr-83 rebase IMPOSSIBLE: <reason>" 출력

    ## 검증
    ```bash
    npm test -- --run --reporter=default tests/unit/hub-quota 2>&1 | tail -30
    ```
    (테스트 파일이 없으면 skip — 이 PR은 테스트 추가 없음 명시됨)

    ## push + comment
    ```bash
    git push --force-with-lease origin fix/hub-quota-refresh-safety
    gh pr comment 83 --body "Rebased onto main @ $(git rev-parse --short origin/main). nit follow-up은 #91 참조."
    ```

    ## 완료 출력
    stdout 마지막 줄:
    - 성공: `pr-83 rebase success @ <short-sha>`
    - 실패: `pr-83 rebase FAILED: <reason>`

---

## Shard: pr-84-fix

- agent: codex
- files: hub/team/conductor.mjs, hub/account-broker.mjs, tests/unit/conductor-tier-fallback.test.mjs
- prompt: |
    PR #84 (feat/conductor-auth-swap-tier-fallback)를 main에 rebase + Codex 리뷰 **BLOCK** 피드백 전체 반영.

    ## Codex 리뷰 요지 (PR comment 전체)

    현재 `tierFallback` listener가 `broker.lease()`를 재호출해서 재귀/lease 누수 발생. auth 파일 direct copy (not atomic). session.config.accountId 교체 + 기존 lease release 누락. 에러 핸들링 불충분. 테스트 전무.

    ## 반영해야 할 5가지 수정

    1. **tierFallback 재진입 방지**:
       - listener 내부에서 `broker.lease({ provider })` 직접 호출 **금지**
       - broker에 `requestAccountMigration(sessionId, provider)` 같은 별도 API 노출 or conductor가 명시적으로 `old lease release -> new lease acquire` 순서 관리
       - `hub/account-broker.mjs`의 `lease()`가 tierFallback emit 전에 상태 전환하도록 보장 (재진입 시 같은 이벤트 안 터지게)
    2. **atomic auth swap**:
       - `auth.json` 직접 `copyFileSync` 대신 `copyFileSync(src, tempPath); renameSync(tempPath, auth.json)` pattern
       - temp 경로는 `auth.json.swap.<pid>.tmp`
       - 실패 시 temp 파일 정리
    3. **lease ownership 교체**:
       - fallback 성공 시 `session.config.accountId = newLeaseId`
       - 이전 `accountId`로 `broker.release()` 호출 → double-lease 방지
       - 실패 시 rollback (새 lease release + auth 파일 원복)
    4. **에러 핸들링 명확화**:
       - `copyFileSync`/`renameSync` 실패 → 즉시 `throw` (fail-fast) vs `log + 세션 유지` 둘 중 정책 결정
       - JSON 검증: copy 전에 `JSON.parse(readFileSync(src))` 로 유효성 확인 (실패 시 early return)
    5. **테스트 추가** (`tests/unit/conductor-tier-fallback.test.mjs`):
       - tierFallback listener가 `lease()`를 재호출해도 재진입하지 않음
       - fallback 후 이전 lease가 release되어 double-lease 없음
       - auth 파일 atomic swap — rename 실패 시 temp 정리 + 원본 유지
       - copyFileSync 실패 시 fail-fast 동작
       - invalid JSON 발견 시 swap 중단

    ## 단계
    ```bash
    git fetch origin
    git checkout -B feat/conductor-auth-swap-tier-fallback origin/feat/conductor-auth-swap-tier-fallback
    git rebase origin/main
    # conflict 해결 후 위 5개 피드백 반영 구현
    # (hub/team/conductor.mjs, hub/account-broker.mjs, tests/unit/conductor-tier-fallback.test.mjs 수정)
    npm test -- --run tests/unit/conductor-tier-fallback.test.mjs 2>&1 | tail -40
    git add -A
    git commit -m "fix(conductor): PR #84 Codex 리뷰 반영 — tierFallback 재진입/atomic swap/lease ownership/에러 정책/테스트"
    git push --force-with-lease origin feat/conductor-auth-swap-tier-fallback
    gh pr comment 84 --body "Codex 리뷰 BLOCK 5건 모두 반영 + 단위 테스트 추가. rebased onto main @ $(git rev-parse --short origin/main)."
    ```

    ## 완료 출력
    - 성공: `pr-84 fix success: <N> tests pass`
    - 실패: `pr-84 fix FAILED: <reason>`

---

## Shard: pr-85-rebase

- agent: codex
- files: hub/team/synapse-registry.mjs, packages/remote/hub/team/synapse-registry.mjs, packages/triflux/hub/team/synapse-registry.mjs
- prompt: |
    PR #85 (fix/synapse-heartbeat-mutation-safety) rebase + push. nit (debounce 유실 창 + persist 복구 테스트)은 follow-up 이슈 #92에서 별도 처리 → **이 shard에서는 건드리지 않는다**.

    ## 단계
    ```bash
    git fetch origin
    git checkout -B fix/synapse-heartbeat-mutation-safety origin/fix/synapse-heartbeat-mutation-safety
    git rebase origin/main
    ```

    conflict 시:
    - mutation safety + debounce 로직 유지
    - main의 구조적 변경(packages 동기화 등)은 main 기준

    ## 검증
    ```bash
    npm test -- --run tests/unit/synapse 2>&1 | tail -30
    ```

    ## push + comment
    ```bash
    git push --force-with-lease origin fix/synapse-heartbeat-mutation-safety
    gh pr comment 85 --body "Rebased onto main @ $(git rev-parse --short origin/main). nit follow-up은 #92."
    ```

    ## 완료 출력
    - 성공: `pr-85 rebase success @ <short-sha>`
    - 실패: `pr-85 rebase FAILED: <reason>`

---

## Shard: pr-86-fix

- agent: codex
- files: hub/workers/codex-app-server-worker.mjs, hub/workers/factory.mjs, hub/workers/interface.mjs, hub/workers/lib/jsonrpc-stdio.mjs, tests/fixtures/fake-codex-app-server.mjs, tests/integration/codex-app-server-streaming.test.mjs, tests/unit/codex-app-server-worker.test.mjs, tests/unit/jsonrpc-stdio.test.mjs, tests/unit/packages-sync.test.mjs, CHANGELOG.md
- prompt: |
    PR #86 (feat/codex-mcp-progress)를 main에 rebase + Codex 리뷰 **FIX_FIRST** 피드백 전체 반영.

    ## Codex 리뷰 요지

    jsonrpc-stdio.mjs가 wire에 `jsonrpc: "2.0"` header 강제 탑재 (공식 JSONL variant와 불일치). `thread/unsubscribe`를 notification으로 보냄 (공식은 request). child exit/error 감시 없음. approval/server-request 경로 미구현. 테스트 부족.

    ## 반영해야 할 수정

    1. **Wire format 교정 (`hub/workers/lib/jsonrpc-stdio.mjs`)**:
       - 송신 시 `jsonrpc: "2.0"` header **omit** (OpenAI App Server 공식 JSONL variant)
       - 수신 시에도 `jsonrpc` 필드 없어도 정상 파싱
       - fixture `tests/fixtures/fake-codex-app-server.mjs`도 공식 포맷으로 교정
    2. **`thread/unsubscribe`를 request로** (`hub/workers/codex-app-server-worker.mjs` `stop()`):
       - notification 대신 request + response 대기
       - unsubscribe 응답 받은 후 `close()`/`SIGTERM`
    3. **child exit/error 감시**:
       - bootstrap 이후 child process `exit`/`error` 이벤트 계속 감시
       - 이벤트 수신 시 진행 중인 `execute()`를 즉시 `TransportError`로 reject (fail-fast)
    4. **EOF/parse error fail-fast** (`JsonRpcStdioClient`):
       - stream EOF, parse 실패, max-line 초과 시 `execute()` 즉시 reject
       - 현재 `onError` warn만 남기는 경로 제거
    5. **approval/server-request 처리**:
       - server-initiated request (approval prompt 등) 수신 시 최소한 error 응답으로 회신
       - 현재로는 approval flow 미구현이므로 `approvalPolicy !== 'never'` 시 factory에서 **에러로 거부** (또는 강제 'never' override + log warn)
    6. **테스트 추가**:
       - `tests/integration/codex-app-server-streaming.test.mjs`: mid-turn child crash → execute reject
       - `tests/unit/jsonrpc-stdio.test.mjs`: EOF/parse error → execute reject, wire format 공식 준수
       - `tests/unit/codex-app-server-worker.test.mjs`: thread/unsubscribe request/response round-trip, approvalPolicy validation
    7. **CHANGELOG.md**: entry 업데이트 (리뷰 반영 사실 요약).

    ## 단계
    ```bash
    git fetch origin
    git checkout -B feat/codex-mcp-progress origin/feat/codex-mcp-progress
    git rebase origin/main
    # conflict 시 CHANGELOG는 main의 최신 entry + PR #86 entry 병합
    # 위 7개 피드백 반영
    npm test -- --run tests/unit/jsonrpc-stdio.test.mjs tests/unit/codex-app-server-worker.test.mjs tests/integration/codex-app-server-streaming.test.mjs 2>&1 | tail -50
    git add -A
    git commit -m "fix(codex-app-server): PR #86 Codex 리뷰 반영 — wire format / unsubscribe request / child exit 감시 / fail-fast / approval / 테스트"
    git push --force-with-lease origin feat/codex-mcp-progress
    gh pr comment 86 --body "Codex 리뷰 FIX_FIRST 7건 모두 반영 + 테스트 추가. rebased onto main @ $(git rev-parse --short origin/main)."
    ```

    ## 완료 출력
    - 성공: `pr-86 fix success: <N> tests pass`
    - 실패: `pr-86 fix FAILED: <reason>`

---

## Merge 순서

의존 없음. 4 shard 병렬 실행 가능. 완료 후 Claude(lead)가:
1. 각 PR mergeable 재조회
2. mergeable=MERGEABLE인 것만 `gh pr merge --squash --delete-branch`
3. conflict나 test fail이 남은 PR은 report

## 완료 조건

- 4 shard 전부 push + PR comment 성공
- 최소 2/4 PR이 mergeable (rebase-only 2개는 반드시 머지 가능해야 함)
- fix shard (#84, #86)는 Codex 리뷰 재요청 권장 (이 PRD 범위 밖)
