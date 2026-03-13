# Speakeasy Gram 동적 도구 로딩 딥 리서치 및 triflux 통합 전략

**작성일:** 2026-03-13  
**대상:** triflux 코어 아키텍처 팀  
**주제:** Speakeasy Gram의 동적 도구 발견(Dynamic Tool Discovery) 메커니즘 분석 및 triflux 적용 방안

---

## 1. 요약 (Summary)
*   **핵심 개념:** Speakeasy Gram은 수백 개의 MCP 도구 스키마를 모델에게 한꺼번에 주입(Upfront Loading)하지 않고, 시맨틱 검색을 통해 필요한 도구만 동적으로 제공하는 **Dynamic Tool Discovery**를 구현함.
*   **주요 성과:** 특정 벤치마크 조건(Claude Sonnet 4.5, 40~400개 툴)에서 입력 토큰량을 **최대 160배(160x)** 절감하는 효과를 입증함.
*   **triflux 적용 방향:** Gram의 풀스택(임베딩+벡터 DB) 방식은 운영 복잡도가 높으므로(XL 단계), 현재 triflux 구조에서는 키워드+가중치 기반의 **경량 동적 필터링(M~L 단계)**을 통한 15~35% 절감을 우선 권장함.

---

## 2. Gram 코드 분석 (Code Analysis)

Speakeasy Gram(`speakeasy-api/gram`)의 아키텍처는 시맨틱 검색과 3단계 도구 발견 프로토콜로 구성됩니다.

### 2.1 시맨틱 검색 엔진 (Semantic Search)
| 구성 요소 | 상세 구현 |
| :--- | :--- |
| **임베딩 모델** | `openai/text-embedding-3-small` (1536차원) 고정 사용 |
| **벡터 저장소** | **Postgres pgvector** 활용, `HNSW cosine` 인덱스로 고속 검색 지원 |
| **검색 쿼리** | `embedding_1536 <=> query_embedding` 거리를 기반으로 유사도 산출 |

### 2.2 도구 발견 메커니즘 (Discovery Protocol)
모델에게는 항상 다음 3개의 도구만 노출하여 컨텍스트 윈도우를 최소화합니다.

1.  **`search_tools(query)`**: 사용자의 태스크 설명(query)과 유사한 top-k 후보 도구 리스트(이름, 설명만 포함)를 반환. 이 때 `InputSchema`는 의도적으로 생략하여 토큰 절약.
2.  **`describe_tools(tool_names)`**: 후보 도구 중 실제 사용 가능성이 높은 도구의 상세 `InputSchema` 및 예시를 조회.
3.  **`execute_tool(name, arguments)`**: 최종 확정된 도구를 실행.

### 2.3 MCP 통합 방식
- **Proxy 구조**: 원격 MCP 서버를 direct 또는 proxy 정의로 관리하며, `<slug>--<toolName>` 네이밍 컨벤션을 통해 도구 호출을 매칭함.
- **런타임 분기**: Gateway 레벨에서 `ToolKindExternalMCP` 분기를 통해 `client.CallTool`을 수행하며, `streamable-http` 및 `sse` 전송 프로토콜을 모두 지원함.

---

## 3. 갭 분석 (Gap Analysis)

Claude Code의 `MCPSearch`와 Speakeasy Gram, 그리고 현재 triflux의 최적화 수준을 비교합니다.

| 비교 항목 | Claude Code (내장) | Speakeasy Gram | triflux (현재) |
| :--- | :--- | :--- | :--- |
| **최적화 방식** | Client-side Deferral | Server-side Semantic Search | Keyword-based Hinting |
| **지연 로딩 조건** | 스키마가 컨텍스트의 10% 초과 시 | 항상 (Dynamic Mode) | 수동 설정 (`get_mcp_hint`) |
| **검색 엔진** | 로컬 인덱스 (추정) | **pgvector (공식)** | **키워드 규칙 (JSON)** |
| **토큰 절감률** | 46.9% (비공식 리포트) | **최대 160x (입력 토큰 기준)** | 0~10% (현 상태) |
| **복잡도** | 낮음 (자동) | 높음 (벡터 DB 필요) | 매우 낮음 |

---

## 4. 구현 설계 (Implementation Design)

Triflux의 복잡도를 관리하면서도 Gram의 이점을 취하기 위한 단계적 통합 설계를 제안합니다.

### 4.1 "M 단계" 경량 동적 필터링 (권장)
- **`mcp-inventory.json` 확장**: 각 MCP 서버별 `tool_count`, `domain_tags`, `priority_weight` 필드 추가.
- **Keyword-Detector 연동**: 기존 `scripts/keyword-detector.mjs`를 활용하여 태스크 키워드와 매칭되는 MCP 서버만 `--allowed-mcp-server-name`으로 Gemini/Claude에게 전달.

### 4.2 "L 단계" FTS 기반 검색
- **BM25/FTS5**: 별도의 벡터 DB 없이 SQLite의 가상 테이블 기능을 활용하여 도구 설명을 전문 검색(Full-Text Search).
- **자동 힌트 생성**: 검색 결과 상위 3~5개 도구만 `tfx-route` 시점에 컨텍스트에 주입.

---

## 5. 벤치마크 (Benchmarks)

Gram의 공식 평가 데이터(`evaluation/README.md`)를 기반으로 분석한 예상 지표입니다.

| 시나리오 | 도구 수 | Upfront 로딩 토큰 | Dynamic 로딩 토큰 | 절감 배수 |
| :--- | :--- | :--- | :--- | :--- |
| **Simple Task** | 40개 | ~12,000 | ~75 | **160x** |
| **Complex Task** | 400개 | ~120,000 | ~1,200 | **100x** |
| **Real-world (Total)** | - | - | - | **20~45% (총 비용)** |

> *참고: 160x는 '입력 토큰' 기준이며, 실제 총 비용(Total Tokens) 절감은 응답 생성 비용을 포함하므로 20~45% 범위가 현실적임.*

---

## 6. 권장 실행 순서 (Roadmap)

1.  **Phase 1 (M 단계):** `keyword-rules.json`에 MCP 서버 매칭 룰 추가 및 `tfx-route.sh` 필터링 로직 구현. (15~35% 절감 기대)
2.  **Phase 2 (인벤토리 고도화):** `mcp-inventory.json`을 자동 생성하는 스크립트 작성 (도구 설명 추출 포함).
3.  **Phase 3 (L 단계):** SQLite FTS5를 이용한 `search_mcp_tools` 헬퍼 스크립트 도입.
4.  **Phase 4 (XL 단계):** 외부 벡터 DB(Pinecone/Supabase) 연동 필요성 검토 (도구 수가 1,000개 이상일 때만 추천).

---

## 7. 외부 소스 및 참조
*   [Speakeasy: Dynamic Tool Discovery Guide](https://www.speakeasy.com/mcp/tool-design/dynamic-tool-discovery)
*   [Speakeasy Blog: 100x Token Reduction with Dynamic Toolsets](https://www.speakeasy.com/blog/100x-token-reduction-dynamic-toolsets)
*   [GitHub: speakeasy-api/gram](https://github.com/speakeasy-api/gram)
*   [Claude Code: MCP Documentation](https://code.claude.com/docs/en/mcp)
*   [Triflux Issue #056: TFX Auto Gemini Doc Routing](docs/issues/056-tfx-auto-gemini-doc-routing.md)
