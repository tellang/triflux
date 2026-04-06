# Lake 5: Mesh Router + Queue + Conductor 통합

## 목표

mesh/ 기초 모듈(protocol, registry, budget) 위에 라우팅, 비동기 큐, Conductor 통합을 구축하여 Agent Mesh를 완성한다.

## 요구사항

### 1. mesh-router.mjs (~100줄)
- `routeMessage(message, registry)` — 메시지 타입+수신자에 따라 대상 에이전트 결정
  - `to: "agent-id"` → 직접 전달
  - `to: "*"` → 브로드캐스트 (registry의 모든 에이전트)
  - `to: "capability:codex"` → capability 매칭 (registry.discover)
- dead letter 처리: 대상 없으면 `{ routed: false, reason }` 반환

### 2. mesh-queue.mjs (~150줄)
- `createMessageQueue(opts)` 팩토리
  - `enqueue(message)` — 큐에 메시지 추가
  - `dequeue(agentId)` — 에이전트의 다음 메시지 꺼냄
  - `peek(agentId)` — 꺼내지 않고 확인
  - `size(agentId)` — 큐 크기
- per-agent 큐 (Map 기반)
- maxQueueSize 제한 (기본 100, 초과 시 가장 오래된 것 drop)
- TTL 지원: 메시지 생성 후 일정 시간 경과 시 자동 만료

### 3. mesh-heartbeat.mjs (~80줄)
- `createHeartbeatMonitor(registry, opts)` 팩토리
  - `recordHeartbeat(agentId)` — 마지막 heartbeat 시간 갱신
  - `getStaleAgents(thresholdMs)` — 임계값 초과 에이전트 목록
  - `start(intervalMs)` / `stop()` — 주기적 스캔 (stale 에이전트 감지)
- stale 에이전트 감지 시 `onStale(agentId)` 콜백

### 4. conductor-mesh-bridge.mjs (~100줄)
- Conductor의 EventEmitter 이벤트를 Mesh 메시지로 변환
  - `stateChange` → mesh event 메시지
  - `completed` → mesh event 메시지
  - `dead` → mesh event 메시지
- 세션 spawn 시 registry 자동 등록
- 세션 종료 시 registry 자동 해제

### 5. 테스트
- tests/unit/mesh-router.test.mjs
- tests/unit/mesh-queue.test.mjs
- tests/unit/mesh-heartbeat.test.mjs
- tests/unit/conductor-mesh-bridge.test.mjs

## 영향 파일

- mesh/mesh-router.mjs (신규)
- mesh/mesh-queue.mjs (신규)
- mesh/mesh-heartbeat.mjs (신규)
- hub/team/conductor-mesh-bridge.mjs (신규)
- mesh/index.mjs (수정 — 새 모듈 export 추가)
- tests/unit/mesh-*.test.mjs (4개 신규)

## 제약

- immutable 패턴 (입력 객체 변경 금지)
- 파일 200줄 이하
- 기존 mesh 테스트 + conductor 테스트 전부 통과
- 외부 의존성 추가 금지 (node:* 만 사용)
