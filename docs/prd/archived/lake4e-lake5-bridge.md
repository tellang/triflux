# PRD: Lake 4e — Lake 5 Agent Mesh 브릿지 인프라

## Summary

Lake 5(Agent Mesh)를 위한 기반 인터페이스와 스캐폴딩을 준비한다.
Context Monitor의 토큰 버짓 시스템과 Skill Templates의 동적 로딩을
mesh 아키텍처에 연결하는 인터페이스를 정의한다.

## Problem

- Lake 5 Agent Mesh 구현 시 Lake 4 모듈과의 연결점이 미정의
- Context Monitor의 per-agent 토큰 버짓 할당 인터페이스 없음
- Skill Templates의 에이전트별 동적 스킬 로딩 메커니즘 없음

## Solution

### mesh/ 디렉토리 구조

```
mesh/
  mesh-protocol.mjs    — 메시지 프로토콜 정의 (타입, 직렬화)
  mesh-registry.mjs    — 에이전트 등록/발견 레지스트리
  mesh-budget.mjs      — Context Monitor 연동: per-agent 토큰 버짓
  index.mjs            — public API 통합 export
```

### 핵심 인터페이스

#### MeshMessage (mesh-protocol.mjs)

```javascript
const MSG_TYPES = { REQUEST: "request", RESPONSE: "response", EVENT: "event", HEARTBEAT: "heartbeat" };

createMessage(type, from, to, payload) → { type, from, to, payload, timestamp, correlationId }
serialize(message) → string
deserialize(raw) → message
validate(message) → { valid: boolean, errors: string[] }
```

#### MeshRegistry (mesh-registry.mjs)

```javascript
createRegistry() → {
  register(agentId, capabilities) → void,
  unregister(agentId) → void,
  discover(capability) → agentId[],
  getAgent(agentId) → AgentInfo | null,
  listAll() → AgentInfo[],
  clear() → void
}
```

#### MeshBudget (mesh-budget.mjs)

```javascript
createMeshBudget(contextMonitor?) → {
  allocate(agentId, tokenLimit) → void,
  consume(agentId, tokens) → { remaining, percent, level },
  getStatus(agentId) → { allocated, consumed, remaining, level },
  resetAll() → void,
  listAllocations() → Map
}
```

`level`은 Context Monitor의 `classifyContextThreshold()` 재사용.

### Context Monitor 연동

- `createContextMonitor()` 반환값에 `meshBudget` 필드 추가 (선택적)
- 기존 API 100% 호환 유지

### Skill Templates 연동 (index.mjs)

- `loadSkillsForAgent(agentId, skillsDir)` — 에이전트에 할당된 스킬만 로드
- 내부적으로 `generateSkillDocs()` 재사용

## Deliverables

- `mesh/mesh-protocol.mjs` — 메시지 프로토콜
- `mesh/mesh-registry.mjs` — 에이전트 레지스트리
- `mesh/mesh-budget.mjs` — 토큰 버짓
- `mesh/index.mjs` — 통합 export
- `tests/unit/mesh-protocol.test.mjs`
- `tests/unit/mesh-registry.test.mjs`
- `tests/unit/mesh-budget.test.mjs`

## Constraints

- 기존 Lake 4a/4b 모듈 API 변경 최소화 (선택적 확장만)
- 순수 인터페이스 + 기본 구현 (외부 의존성 금지, node:* 내장만)
- immutable 패턴, 함수 50줄 이하, 파일 300줄 이하
- npm test 전체 통과

## Success Criteria

- mesh/ 4개 파일 생성, 각 export 함수 동작
- 단위 테스트 전체 통과
- npm test 전체 통과 (기존 테스트 무영향)
- Context Monitor / Skill Templates 기존 API 100% 호환
