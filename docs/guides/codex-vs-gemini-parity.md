# tfx-codex vs tfx-gemini 패리티 가이드

이 문서는 Triflux 오케스트레이터의 두 가지 전용 모드인 `tfx-codex`와 `tfx-gemini`의 기능적 차이와 아키텍처 패리티 상태를 정리합니다.

## 1. 개요

Triflux는 기본적으로 하이브리드 모드(`tfx-auto`)를 지향하지만, 특정 CLI가 없는 환경이나 특정 모델만 사용해야 하는 환경을 위해 전용 모드를 제공합니다.

- **tfx-codex**: 모든 작업을 Codex CLI로 라우팅. Gemini 미설치 환경용.
- **tfx-gemini**: 모든 작업을 Gemini CLI로 라우팅. Codex 미설치 환경용.

---

## 2. 모델 및 프로필 매핑 비교

| 구분 | tfx-codex (Codex 전용) | tfx-gemini (Gemini 전용) |
| :--- | :--- | :--- |
| **핵심 모델** | GPT-4o 기반 (effort: high/medium) | Gemini 3.1 Pro / Gemini 3 Flash |
| **매핑 방식** | `mcp_profile` 리매핑 | `TFX_CLI_MODE` 기반 모델 분기 |
| **High Effort** | `effort: high` (executor, architect) | `gemini-3.1-pro-preview` |
| **Low Effort** | `effort: low` / `spark_fast` (writer) | `gemini-3-flash-preview` |
| **UI/Design** | `designer` -> `implement` 프로필 | `designer` -> Gemini Pro |
| **문서/리서치** | `writer` -> `analyze` 프로필 | `writer` -> Gemini Flash |

---

## 3. MCP 서버 및 필터링 차이

| 항목 | Codex MCP | Gemini MCP (Legacy/Native) |
| :--- | :--- | :--- |
| **설정 방식** | Codex 전용 프로필(`analyze`, `implement` 등) | 환경 변수 `GEMINI_ALLOWED_SERVERS` |
| **필터링 메커니즘** | 각 프로필에 정의된 MCP 서버만 활성화 | **동적 필터링(M단계 반영)**: `gemini` 실행 시 필요 도구만 허용하도록 `--allowed-mcp-server-names` 동적 전달 |
| **서버 관리** | `codex mcp-server` 프로세스 내 통합 | 각 서버가 독립적인 프로세스로 실행 가능 |
| **동작 원리** | `hub/workers/codex-mcp.mjs` (SDK 기반) | `hub/workers/gemini-worker.mjs` (CLI Wrapper) |

---

## 4. 실행 경로 및 아키텍처

### tfx-codex (`run_codex`)
- **브릿지**: `hub/workers/codex-mcp.mjs`
- **통신**: MCP SDK `StdioClientTransport` 사용.
- **특징**: `codex-reply` 도구를 사용하여 장기 세션(Thread) 유지가 아키텍처적으로 통합되어 있음.

### tfx-gemini (`run_legacy_gemini` 및 `gemini-worker`)
- **브릿지**: `hub/workers/gemini-worker.mjs` (Stream wrapper) 및 legacy 래퍼
- **통신**: `spawn`을 통한 단발성 CLI 호출. `stream-json` 출력 파싱.
- **특징**: 
  - **슬림래퍼 Bypass 방지 (.issues/006 반영)**: Agent 우회 및 무단 실행 방지를 위한 검증 로직 적용.
  - **Stream Wrapper Fallback 시그널**: Stream 파싱 실패나 예외 상황 시 안정성을 위해 fallback 시그널 처리 강화.
  - Windows 환경에서의 안정성을 위해 `--timeout` 및 자동 재시도 로직이 강화됨.

---

## 5. Health Check 및 진단 방식

| 항목 | tfx-codex | tfx-gemini |
| :--- | :--- | :--- |
| **기본 도구** | `tfx-doctor --fix` | `tfx-doctor --fix` |
| **체크 방식** | `listTools` 호출 및 필수 도구(`codex`, `codex-reply`) 존재 확인 | `gemini --version` 확인 및 단순 헬로월드 실행 테스트 |
| **실패 처리** | `CODEX_MCP_TRANSPORT_EXIT_CODE (70)` 반환 | Hang 감지 시 프로세스 강제 종료(Kill Grace) |

---

## 6. Multi-turn 지원 현황 (세션 유지)

| 모드 | 지원 상태 | 구현 방식 |
| :--- | :--- | :--- |
| **Codex** | **지원됨** | `threadId` 및 `sessionKey`를 통한 컨텍스트 유지 |
| **Gemini** | **미구현** | 단발성 실행 위주 (이슈 `.issues/001`에서 추적 중) |

### 6.1 팀/오케스트레이터 연동 동기화
- **TaskUpdate 동기화**: `tfx-auto` 등 상위 오케스트레이터에서 모델과 무관하게 진행 상태(`TaskUpdate`)가 일관되게 동기화되도록 브릿지 개선 반영.

> **참고**: Gemini 모드에서 Multi-turn이 필요한 경우, `tfx-auto` 모드를 사용하여 상위 오케스트레이터(Opus/Sonnet) 레벨에서 컨텍스트를 관리하는 것이 권장됩니다.

---

## 7. 요약 가이드

- **복잡한 코드 수정 및 설계**: `tfx-codex` (GPT-4o의 추론 능력 활용)
- **빠른 린트 수정 및 대량 문서화**: `tfx-gemini` (Flash 모델의 비용 효율성 및 속도 활용)
- **둘 다 가용한 환경**: `tfx-auto` (최적의 도구 자동 선택)
