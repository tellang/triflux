# PRD: sendInput MCP 도구 + Hub CLI 노출

## 목표

conductor의 `sendInput()` 함수를 Hub MCP tool + bridge CLI 커맨드로 노출하여,
원격 에이전트나 Lead가 INPUT_WAIT 상태의 워커에게 응답을 보낼 수 있게 한다.

## Shard 1: MCP tool + bridge CLI 추가
- agent: codex
- files: hub/tools.mjs, hub/pipe.mjs, hub/bridge.mjs
- prompt: |
    conductor.sendInput()을 Hub의 MCP tool과 pipe/bridge CLI로 노출한다.

    현재 상태:
    - conductor.mjs:588에 `sendInput(id, text)` 구현됨 — child stdin에 쓰기
    - health-probe.mjs가 INPUT_WAIT 패턴을 감지함 (질문, y/n, choose/select 등)
    - 하지만 MCP tool이나 bridge CLI에서 호출할 방법이 없음
    - 에이전트가 INPUT_WAIT를 해결하려면 conductor 내부 API에 직접 접근해야 함

    변경 사항:

    1. hub/tools.mjs에 `send_input` MCP tool 추가 (기존 20개 도구 뒤에):
       ```javascript
       {
         name: 'send_input',
         description: 'Send input text to a worker in INPUT_WAIT state to resolve the wait',
         inputSchema: {
           type: 'object',
           properties: {
             session_id: { type: 'string', description: 'Conductor session ID' },
             text: { type: 'string', description: 'Input text to send (will be followed by newline)' },
           },
           required: ['session_id', 'text'],
         },
       }
       ```
       핸들러에서 conductor registry를 통해 해당 세션의 conductor를 찾아 `sendInput()` 호출.
       conductor를 찾을 수 없으면 `{ success: false, error: 'session not found' }` 반환.

    2. hub/pipe.mjs의 `processCommand()`에 `send_input` 액션 추가:
       ```javascript
       case 'send_input': {
         const { session_id, text } = msg;
         // conductor registry에서 찾아 sendInput 호출
         break;
       }
       ```

    3. hub/bridge.mjs에 `send-input` CLI 서브커맨드 추가:
       ```javascript
       // HUB_OPERATIONS에 추가
       'send-input': { action: 'send_input', httpPath: '/bridge/send-input' },
       ```
       main()의 switch에도 추가:
       ```javascript
       case 'send-input': {
         const sessionId = args[1];
         const text = args.slice(2).join(' ');
         return requestHub('send-input', { session_id: sessionId, text });
       }
       ```

    4. hub/server.mjs에 `/bridge/send-input` HTTP 엔드포인트 추가 (기존 bridge 엔드포인트 패턴 따름)

    제약:
    - conductor registry가 없으면 "conductor registry not available" 에러 반환
    - session_id로 conductor를 찾을 수 없으면 "session not found" 에러 반환
    - 원격 세션(remote conductor)은 현재 미지원, false 반환 + 로그
    - 기존 MCP 도구 20개의 동작에 영향 없음
    - 기존 테스트 전체 통과

    커밋 메시지: "feat(hub): send_input MCP tool + bridge CLI — INPUT_WAIT 원격 응답"

## 파일
- `hub/tools.mjs` (수정, ~30줄 추가)
- `hub/pipe.mjs` (수정, ~10줄 추가)
- `hub/bridge.mjs` (수정, ~15줄 추가)
- `hub/server.mjs` (수정, ~10줄 추가)

## 제약
- 기존 20개 MCP tool 동작 무영향
- conductor registry 접근 필요 (server.mjs에서 주입)
- 원격 세션 sendInput은 미지원 (향후 확장)
- 파일 800줄 이하

## 테스트 명령
```bash
node --test tests/unit/tools*.test.mjs
node --test tests/unit/pipe*.test.mjs
node --test tests/unit/bridge*.test.mjs
npm test
```
