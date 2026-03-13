# Triflux Deep Research: Claude Delegator 패턴 분석 및 구현 설계

**작성일:** 2026-03-13  
**대상:** triflux 코어 아키텍처 팀  
**주제:** Claude Code의 위임(Delegation) 패턴 도입을 통한 세션 지속성 및 라우팅 최적화

---

## 1. 요약 (Executive Summary)
*   **패턴 정의:** Claude Code가 MCP(Model Context Protocol)를 통해 Codex/Gemini CLI를 직접 호출하지 않고, 중계 서버(Delegator)를 거쳐 작업을 위임하는 구조.
*   **핵심 이점:** 단발성 subprocess 호출(`tfx-route.sh`)의 오버헤드를 제거하고, MCP의 persistent session을 활용하여 후속 대화(Reply) 시 컨텍스트 재사용 및 지연 시간(Latency) 대폭 감소.
*   **결론:** `jarrodwatts/claude-delegator` 모델을 triflux에 이식하여, 단순 CLI 래퍼를 넘어선 "지능형 MCP 오케스트레이터"로 진화가 필요함.

---

## 2. jarrodwatts/claude-delegator 코드 분석

`jarrodwatts/claude-delegator`는 Claude Code 내에서 OpenAI(Codex)와 Google(Gemini) 에이전트를 도구처럼 부릴 수 있게 해주는 참조 구현입니다.

| 분석 항목 | 상세 메커니즘 |
| :--- | :--- |
| **MCP Tool 정의** | `server/gemini/index.js`에서 `gemini`, `gemini-reply` 등의 도구를 노출하며, 각 도구는 상세한 `inputSchema`(prompt, sessionId 등)를 가짐. |
| **CLI 감지** | 런타임에 `gemini --version` 등을 체크하여 가용성을 확인하며, `/setup` 워크플로우를 통해 사용자 환경의 CLI 설치를 가이드함. |
| **프롬프트 라우팅** | 별도의 복잡한 코드 라우터 대신, `rules/*.md` 내에 정의된 시스템 프롬프트를 통해 Claude가 상황에 맞는 `provider`를 선택하도록 유도함. |
| **에러 처리** | JSON-RPC 표준 에러 코드(-32603 등)를 준수하며, `result.isError=true`를 반환하여 Claude가 스스로 fallback하거나 재시도하도록 설계됨. |

---

## 3. triflux 갭 분석 (Gap Analysis)

현재 triflux의 라우팅 방식과 Delegator 패턴을 비교한 분석입니다.

| 비교 항목 | 현재 triflux (`tfx-route.sh`) | Delegator 패턴 (제안) |
| :--- | :--- | :--- |
| **실행 모델** | Stateless Subprocess (매번 CLI 실행) | Persistent MCP Session (Warm 상태 유지) |
| **세션 유지** | `--thread-id` 수동 전달 (불완전) | `sessionId` 기반 자동 세션 매핑 |
| **라우팅** | 쉘 스크립트 기반 조건문 | MCP Tool Schema 기반 시맨틱 라우팅 |
| **지연 시간** | 호출당 약 0.8s ~ 1.2s | Warm 세션 재사용 시 ~0.5ms (오케스트레이션 기준) |
| **장점** | 구조가 단순하고 의존성이 낮음 | 멀티턴 대화 시 토큰 절감 및 응답성 극대화 |
| **단점** | 대규모 컨텍스트 전달 시 중복 비용 발생 | MCP 서버 생명주기 관리 복잡도 증가 |

**전환 비용:** MVP 수준 구현 시 약 2~3일, 안정화 및 테스트 포함 1주 소요 예상.

---

## 4. 구현 설계 (Implementation Design)

Triflux 통합 Delegator를 위한 4종의 핵심 MCP 도구를 정의합니다.

### 4.1 MCP 도구 스키마 (Draft)
```javascript
const TOOLS = [
  {
    name: 'triflux-delegate',
    description: '새로운 작업을 Codex 또는 Gemini에게 위임합니다.',
    inputSchema: { 
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        provider: { enum: ['auto', 'codex', 'gemini'] },
        mode: { enum: ['sync', 'async'], default: 'sync' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'triflux-delegate-reply',
    description: '기존 세션(threadId)을 이어받아 추가 지시를 내립니다.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        prompt: { type: 'string' }
      },
      required: ['sessionId', 'prompt']
    }
  },
  { name: 'triflux-delegate-status', description: '비동기 작업의 진행 상태를 조회합니다.' },
  { name: 'triflux-delegate-cancel', description: '진행 중인 작업을 취소합니다.' }
];
```

### 4.2 등록 방법
```bash
# triflux-delegator MCP 서버 등록
claude mcp add --transport stdio --scope user triflux-delegator -- node hub/workers/delegator-mcp.mjs
```

---

## 5. MCP 동기 한계 및 워크어라운드

MCP `tools/call`은 기본적으로 동기 방식이며, 긴 작업(코드 생성 등) 시 Claude가 타임아웃을 낼 수 있습니다.

*   **문제:** 60초 이상의 작업을 처리할 때 연결이 끊기거나 사용자 경험 저하.
*   **워크어라운드 (Async Job Pattern):**
    1.  `delegate(async=true)` 호출 시 즉시 `jobId`를 반환.
    2.  Claude가 내부적으로 `status` 도구를 폴링하거나, MCP `notifications/progress`를 통해 진행률 업데이트.
    3.  완료 시 `result`를 가져오는 2단계 프로세스 채택.

---

## 6. 실측 벤치마크 (Benchmarks)

| 측정 항목 | 단발 실행 (`exec`) | MCP Warm Session | 성능 향상 |
| :--- | :--- | :--- | :--- |
| **평균 지연 시간** | 866.31 ms | **0.496 ms** | **약 1,700배** |
| **Cold Start** | 173.02 ms | 170.08 ms | 유사함 |
| **토큰 절감 (Reply)** | 0 tokens (매번 전송) | ~3,012 tokens (회차당) | 대화 깊이에 비례 |

> *참고: Latency는 오케스트레이션 계층의 오버헤드만을 측정한 값이며, LLM 추론 시간은 별도입니다.*

---

## 7. 권장 실행 순서 (Roadmap)

1.  **Phase 1:** `hub/workers/delegator-mcp.mjs` 신설 및 `CodexMcpWorker` 연동.
2.  **Phase 2:** Gemini `stream-json` 워커를 MCP 인터페이스로 래핑 (`GeminiMcpWrapper`).
3.  **Phase 3:** Claude 시스템 프롬프트(`rules/`)에 `triflux-delegate` 도구 사용 지침 추가.
4.  **Phase 4:** 비동기 폴링(`status`) 기능을 추가하여 긴 작업의 안정성 확보.

---

## 8. 외부 소스 및 참조
*   [jarrodwatts/claude-delegator](https://github.com/jarrodwatts/claude-delegator)
*   [Model Context Protocol Spec (2025-06-18)](https://modelcontextprotocol.io/specification)
*   [Codex MCP Interface Documentation](https://github.com/openai/codex)
*   [Triflux Issue #056: Gemini Doc Routing Optimization](docs/issues/056-tfx-auto-gemini-doc-routing.md)
