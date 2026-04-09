# PRD: Headless 워커 Hub 양방향 소통 연결

## 목표

headless.mjs의 워커가 Hub에 register하고, 실행 결과를 Hub publish로 보고하며,
Lead의 control 명령(pause/resume/abort)을 수신할 수 있도록 양방향 소통을 연결한다.

## Shard 1: 워커 Hub 등록 + 결과 publish
- agent: codex
- files: hub/team/headless.mjs
- prompt: |
    hub/team/headless.mjs를 수정하여 headless 워커가 Hub에 등록되고 결과를 publish하도록 한다.

    현재 상태: 워커는 psmux send-keys로 CLI를 실행하고, completion token + HANDOFF stdout 파싱으로만 결과를 수집한다. Hub에 register/publish하지 않는다.

    변경 사항:
    1. `dispatchProgressive()` 또는 `dispatchBatch()`에서 각 워커 pane 생성 직후, Hub bridge를 통해 워커를 등록한다:
       ```javascript
       import { requestJson } from '../bridge.mjs';
       // 워커 등록
       await requestJson('/bridge/register', {
         body: { agentId: `headless-${sessionName}-${i}`, topics: ['headless.worker'], capabilities: [cli] }
       }).catch(() => {}); // Hub 미실행 시 graceful fallback
       ```
    2. `collectResults()`에서 각 워커 결과 수집 후 Hub에 publish:
       ```javascript
       await requestJson('/bridge/publish', {
         body: { from: `headless-${sessionName}-lead`, to: 'topic:headless.results', type: 'event', payload: { workerId, status, handoff } }
       }).catch(() => {});
       ```
    3. `cleanup()` 또는 세션 종료 시 워커 등록 해제:
       ```javascript
       await requestJson('/bridge/deregister', {
         body: { agentId: `headless-${sessionName}-${i}` }
       }).catch(() => {});
       ```

    중요 제약:
    - Hub 미실행 시에도 기존 동작이 100% 유지되어야 한다 (graceful fallback)
    - 모든 Hub 호출은 `.catch(() => {})` 또는 try/catch로 감싸서 실패해도 headless 실행에 영향 없음
    - 기존 completion token + HANDOFF 메커니즘은 유지 (Hub는 보조 채널)
    - 테스트: `node --test tests/unit/headless-*.test.mjs`

    커밋 메시지: "feat(headless): 워커 Hub register/publish 양방향 소통 연결"

## Shard 2: Lead control 수신 연결
- agent: codex
- files: hub/team/session-sync.mjs, hub/team/lead-control.mjs
- prompt: |
    hub/team/session-sync.mjs의 `subscribeToLeadCommands()`를 headless 실행에서 사용할 수 있도록 thin wrapper를 추가한다.

    현재 상태: session-sync.mjs에 `subscribeToLeadCommands()`가 구현되어 있지만, headless.mjs에서 호출하지 않는다. lead-control.mjs의 `publishLeadControl()`도 구현되어 있지만 연결되지 않음.

    변경 사항:
    1. session-sync.mjs에 `createHeadlessControlSubscriber(sessionName, opts)` 함수 추가:
       ```javascript
       export function createHeadlessControlSubscriber(sessionName, { onPause, onResume, onAbort, onReassign } = {}) {
         // subscribeToLeadCommands를 래핑하여 headless 세션용 콜백 연결
         // Hub 미실행 시 noop 반환 (graceful)
         // 반환: { stop() } — 구독 해제
       }
       ```
    2. lead-control.mjs에 `publishHeadlessControl(sessionName, command, targetWorker)` 편의 함수 추가:
       ```javascript
       export async function publishHeadlessControl(sessionName, command, targetWorker = '*') {
         // publishLeadControl을 래핑하여 headless 세션 + 특정 워커 타겟팅
       }
       ```

    제약:
    - 기존 subscribeToLeadCommands / publishLeadControl API 변경 금지
    - 새 함수만 추가 (기존 함수는 그대로 유지)
    - Hub 미실행 시 graceful noop
    - 테스트: `node --test tests/unit/session-sync.test.mjs` (있으면), 없으면 기존 테스트 전체 통과 확인

    커밋 메시지: "feat(session-sync): headless control subscriber/publisher 래퍼 추가"

## 파일
- `hub/team/headless.mjs` (수정, ~30줄 추가)
- `hub/team/session-sync.mjs` (수정, ~40줄 추가)
- `hub/team/lead-control.mjs` (수정, ~20줄 추가)

## 제약
- Hub 미실행 시 기존 headless 동작 100% 유지 (graceful fallback 필수)
- 기존 API 호환 유지
- 파일 800줄 이하
- npm test 전체 통과

## 테스트 명령
```bash
node --test tests/unit/headless-*.test.mjs
node --test tests/unit/session-sync*.test.mjs
npm test
```
