# PRD: handoff + publish pipe 커맨드 bridge CLI 연결

## 목표

pipe.mjs에 구현되어 있지만 bridge CLI/HTTP에서 접근 불가능한
handoff와 publish 커맨드를 bridge CLI + HTTP로 노출한다.

## Shard 1: handoff + publish bridge 연결
- agent: codex
- files: hub/bridge.mjs, hub/server.mjs
- prompt: |
    handoff와 publish pipe 커맨드를 bridge CLI와 HTTP로 연결한다.

    1. hub/bridge.mjs의 HUB_OPERATIONS에 추가:
       'handoff': { transport: 'command', action: 'handoff', httpPath: '/bridge/handoff' }
       'publish': { transport: 'command', action: 'publish', httpPath: '/bridge/publish' }

    2. cmdHandoff 함수 추가:
       - args: from, to, payload (JSON string)
       - requestHub('handoff', { from, to, payload: JSON.parse(payloadStr) })

    3. cmdPublish 함수 추가:
       - args: from, to, type, payload (JSON string)
       - type 기본값: 'event'
       - requestHub('publish', { from, to, type, payload: JSON.parse(payloadStr) })

    4. main()의 switch에 2개 case 추가

    5. hub/server.mjs에 2개 HTTP 엔드포인트 추가:
       - POST /bridge/handoff → router.handleHandoff(body)
       - POST /bridge/publish → router.handlePublish(body)
       기존 /bridge/* 패턴 동일하게 구현

    제약:
    - 기존 pipe 커맨드 동작 무영향
    - publish의 to 필드가 'topic:' 접두사면 topic fanout
    - npx biome check --write 후 커밋

    커밋 메시지: "feat(bridge): handoff + publish CLI 커맨드 + HTTP 엔드포인트 연결"

## 파일
- hub/bridge.mjs (수정, ~30줄)
- hub/server.mjs (수정, ~15줄)

## 테스트 명령
```bash
npm test
```
