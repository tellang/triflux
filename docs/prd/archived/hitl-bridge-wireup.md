# PRD: HITL 시스템 전체 연결 — pipe + bridge CLI + HTTP

## 목표

hub/hitl.mjs의 HITL 매니저를 pipe 커맨드, bridge CLI, HTTP 엔드포인트로 노출하여
외부 스크립트, conductor, swarm에서 human input을 요청/응답할 수 있게 한다.

## Shard 1: pipe + server HTTP 연결
- agent: codex
- files: hub/pipe.mjs, hub/server.mjs
- prompt: |
    HITL 매니저를 pipe 커맨드와 HTTP 엔드포인트로 노출한다.

    1. hub/pipe.mjs의 createPipeServer 함수 시그니처에 hitlManager 파라미터 추가.
       processCommand()에 3개 case 추가:
       - case "hitl_request": return hitl.requestHumanInput(msg) 호출
       - case "hitl_submit": return hitl.submitHumanInput(msg) 호출
       processQuery()에 1개 case 추가:
       - case "hitl_pending": return { ok: true, data: hitl.getPendingRequests() }

    2. hub/server.mjs에서 createPipeServer 호출 시 hitlManager 전달:
       createPipeServer({ ..., hitlManager: hitl })

    3. hub/server.mjs에 3개 HTTP 엔드포인트 추가 (기존 /bridge/* 패턴 따라):
       - POST /bridge/hitl/request → hitl.requestHumanInput(body)
       - POST /bridge/hitl/submit → hitl.submitHumanInput(body)
       - GET  /bridge/hitl/pending → hitl.getPendingRequests()

    제약:
    - 기존 pipe/server 코드 무영향
    - hitlManager 미전달 시 graceful fallback (pipe에서 "hitl not available" 반환)
    - npx biome check --write 후 커밋

    커밋 메시지: "feat(hitl): pipe 커맨드 + HTTP 엔드포인트 연결"

## Shard 2: bridge CLI 연결
- agent: codex
- files: hub/bridge.mjs
- prompt: |
    bridge.mjs에 HITL CLI 커맨드 3개를 추가한다.

    1. HUB_OPERATIONS에 추가:
       'hitl-request': { transport: 'command', action: 'hitl_request', httpPath: '/bridge/hitl/request' }
       'hitl-submit': { transport: 'command', action: 'hitl_submit', httpPath: '/bridge/hitl/submit' }
       'hitl-pending': { transport: 'query', action: 'hitl_pending', httpPath: '/bridge/hitl/pending' }

    2. cmdHitlRequest, cmdHitlSubmit, cmdHitlPending 함수 추가:
       - cmdHitlRequest: args에서 kind, prompt, requester_agent 파싱
       - cmdHitlSubmit: args에서 request_id, action, content 파싱
       - cmdHitlPending: 인자 없음, pending 목록 출력

    3. main()의 switch에 3개 case 추가

    제약:
    - 기존 bridge CLI 패턴 (cmdDelegatorDelegate 등) 따라 동일 스타일
    - npx biome check --write 후 커밋

    커밋 메시지: "feat(bridge): HITL CLI 커맨드 3개 추가 (request/submit/pending)"

## 파일
- hub/pipe.mjs (수정, ~15줄)
- hub/server.mjs (수정, ~20줄)
- hub/bridge.mjs (수정, ~40줄)

## 테스트 명령
```bash
npm test
```
