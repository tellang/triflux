# #32 v2.1 vs v2.2 아키텍처 방향 상충

> 등록일: 2026-03-11
> 상태: **[CLOSED]** — ADR-002 확정으로 코드 변경 없이 해소
> 종료일: 2026-03-13

## 이슈 요약

v2.1과 v2.2 아키텍처 설계 간의 상충 및 모순이 발생.
Teammate 통신 방식(Agent 래퍼 vs MCP 서버 vs 프로세스 스폰 등)에 대한
버전 간 정합성이 결여되어 개발 방향이 불명확했음.

## Close 판정 근거

### 1. ADR-002 확정 (Accepted)

`docs/handoff/11-architecture-decisions.md` ADR-002:

- **결정**: Teammate 통신 → D방식 (Codex MCP 서버) primary
- **A방식(Agent 래퍼)**: 폐기 — 토큰 낭비 및 지연 시간
- **B방식(프로세스 스폰)**: 보조 역할 유지
- **C방식(Lead 직접)**: 현행 유지
- **D방식(MCP 서버)**: Primary로 승격
- v2.2+ 방향으로 확정, v2.1 설계와의 상충 해소

### 2. ADR-009에서 해결 완료 확인

`docs/adr/ADR-009-orchestration-architecture.md` (2026-03-12):

- 해결 완료 목록에 "#32 | ADR-002로 v2.2+ 확정"으로 명시
- Q1 결정에서 Hub MCP 도구 유지를 재확인 (ADR-002 존중)

### 3. 후속 구현은 Phase 2에서 추적

ADR-002의 실제 구현(Codex MCP 서버 통합)은 로드맵 Phase 2에서 추적.
본 이슈(#32)는 "v2.1 vs v2.2 방향 결정" 문제이므로
ADR 확정만으로 close 가능.

## 판정

코드 변경 없이 ADR-002 아키텍처 결정 확정으로 해소. v2.2+ 방향 확정.
구현 작업은 로드맵 Phase 2 (ADR-005)에서 계속.
