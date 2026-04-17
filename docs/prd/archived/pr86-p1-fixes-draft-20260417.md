# PR #86 P1 블로커 fix — codex-app-server streaming

Issue #95 대응. Codex 교차 리뷰 (2026-04-17) 결과 REQUEST_CHANGES 판정된
4 P1 블로커 fix. 각 shard는 worktree 격리로 실행되며 완료 후 PR #86 브랜치에
cherry-pick 또는 force-push로 반영.

**공통 가드**: main 직접 커밋 금지. shard 전용 worktree 브랜치에서만 작업.

## Shard: pr86-p1-fixes
- agent: codex
- files: hub/workers/lib/jsonrpc-stdio.mjs, hub/workers/codex-app-server-worker.mjs, hub/workers/factory.mjs, hub/workers/interface.mjs, tests/fixtures/fake-codex-app-server.mjs, tests/unit/jsonrpc-stdio.test.mjs, tests/unit/codex-app-server-worker.test.mjs
- critical: true
- prompt: |
    Issue #95 P1 블로커 4건 fix. PR #86 (feat/codex-mcp-progress)에 반영.

    현재 branch는 main base worktree. 작업 완료 후 shard branch에 commit하면
    hypervisor가 PR #86 브랜치와 별도로 merge 관리한다. **main에 commit 금지.**

    ## P1 #1. Wire framing — jsonrpc 헤더 omit + thread/unsubscribe request 전환

    파일: hub/workers/lib/jsonrpc-stdio.mjs, hub/workers/codex-app-server-worker.mjs, tests/fixtures/fake-codex-app-server.mjs, tests/unit/jsonrpc-stdio.test.mjs

    요구:
    - jsonrpc-stdio.mjs encode: `jsonrpc: "2.0"` 키 omit. 결과 line에 "jsonrpc" 필드가 없어야 함
    - decode: 존재/부재 모두 수용 (backward compat)
    - codex-app-server-worker.stop(): `thread/unsubscribe`를 **notification이 아닌 request로 전송**
      * 응답 또는 타임아웃(2s) 대기 후 SIGTERM
    - fixture fake-codex-app-server.mjs: jsonrpc 헤더 없는 wire format 시뮬레이트
    - unit test: encode에 jsonrpc 키 없음 회귀 + thread/unsubscribe 경로 테스트

    ## P1 #2. Lifecycle — child exit/error 감시 + stop 시 unsubscribe 응답 대기

    파일: hub/workers/codex-app-server-worker.mjs

    요구:
    - bootstrap 이후 child.on("exit") + child.on("error") 리스너 등록
    - in-flight `execute()` 존재 시 `CODEX_APP_SERVER_TRANSPORT_ERROR` 로 reject (즉시)
    - stop(): `thread/unsubscribe` request를 먼저 보낸 뒤 응답 or 2s deadline 대기 → SIGTERM
    - turn 도중 app-server 크래시 → timeoutMs까지 매달리지 않고 즉시 실패

    ## P1 #3. 에러 전파 — parse/max-line/EOF fail-fast

    파일: hub/workers/lib/jsonrpc-stdio.mjs

    요구:
    - 상태 기계 추가: `running | closing | closed`
    - parse 실패 / max-line 초과 / stdout EOF 시점
      * 상태 != closing 이면 in-flight execute 에 대해 `ProtocolError` 또는 `TransportError` 로 reject
      * closing 상태면 정상 종료로 처리
    - 현 구현은 onError warn만 남김 → fail-fast로 전환

    ## P1 #4. approvalPolicy validation

    파일: hub/workers/factory.mjs, hub/workers/interface.mjs (필요 시)

    요구:
    - app-server transport에서 `approvalPolicy !== 'never'` 이면 factory에서 throw
    - 명확한 validation 에러 메시지: "app-server transport currently requires approvalPolicy='never' — approval round-trip is tracked in follow-up issue"
    - interface에 approvalPolicy 허용값 enum 명시 (`'never' | 'on-failure' | 'untrusted'` 등)

    ## 작업 순서

    1. jsonrpc-stdio.mjs P1#1 + P1#3 (상태기계, fail-fast, jsonrpc omit)
    2. codex-app-server-worker.mjs P1#2 (lifecycle + stop)
    3. factory/interface P1#4 (validation)
    4. fixture + unit test 갱신
    5. 기존 테스트 전부 pass 확인
    6. 새 회귀 테스트 추가:
       - encode에 jsonrpc 키 없음
       - thread/unsubscribe request 경로 (응답 대기 + 타임아웃)
       - mid-turn child crash → execute reject
       - EOF → execute reject
       - approvalPolicy !== 'never' → factory throw

    ## Acceptance

    - [ ] P1 #1~#4 모두 수정 + 회귀 테스트 추가
    - [ ] `node --test tests/unit/jsonrpc-stdio.test.mjs tests/unit/codex-app-server-worker.test.mjs tests/unit/worker-factory.test.mjs` 전부 pass
    - [ ] 기존 integration 테스트 (codex-app-server-streaming.test.mjs) 회귀 없음
    - [ ] CHANGELOG.md에 P1 fix 한 줄 추가

    ## 주의

    - wire format 변경은 하위 호환 고려: decode는 jsonrpc 헤더 있어도/없어도 수용
    - ProtocolError/TransportError 클래스가 없으면 신규 정의 (name만 구별, extends Error)
    - code style은 기존 파일 컨벤션 준수
