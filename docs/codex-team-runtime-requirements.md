# Codex 팀 런타임 요구사항

## 1) 목적
- Claude Agent Team UX와 유사한 팀 기반 작업 경험(역할 분리, 병렬 작업, 상태 가시성)을 제공한다.
- 백엔드는 Codex 실행 환경과 tfx hub 모델에 맞게 구성한다.

## 2) 핵심 제약
> native Claude TeamCreate/TaskCreate APIs are not available in Codex; use Hub task/message abstraction instead.

## 3) 기능 요구사항 (CR1..CR8)
- `CR1 팀 런타임 생성` [구현됨] : psmux 기반의 네이티브 세션 관리와 Named Pipe 제어 채널을 생성한다. (→ ADR-001, ADR-004 참조, Phase 1)
- `CR2 작업 생성/할당` [구현됨] : SKILL.md를 팀 실행의 주축으로 삼아 Hub task/message 추상화를 관리한다. (→ ADR-003 참조, Phase 2)
- `CR3 병렬 실행` [구현됨] : Gemini 및 Claude subprocess 래퍼를 통해 독립적인 병렬 실행을 보장한다. (→ ADR-006, ADR-007 참조, Phase 2)
- `CR4 상태 전이` [부분 구현] : Named Pipe를 통해 실시간 상태 전이(`queued -> running -> done`) 이벤트를 추적한다. (→ ADR-004 참조, Phase 1)
- `CR5 메시지 상관관계` [구현됨] : 모든 메시지에 Named Pipe 채널 기반의 `correlation_id`를 부여하여 요청-응답을 추적한다. (→ ADR-004 참조, Phase 1)
- `CR6 실패 복구` [부분 구현] : Subprocess 수준의 재시도 로직과 타임아웃 보상 규칙을 적용한다. (→ ADR-006, ADR-007 참조, Phase 2)
- `CR7 운영 가시성` [부분 구현] : Codex MCP 서버 통합을 통해 팀/작업 단위 메트릭과 감사 로그를 제공한다. (→ ADR-005 참조, Phase 3)
- `CR8 호환성` [구현됨] : 기존 `tfx team/hub` 스키마를 유지하며 하위 호환성을 갖춘 점진적 전환을 지원한다. (→ ADR-002 참조, Phase 4)

## 4) 수용 기준(요약)
- `CR1~CR8` 각각에 대해 최소 1개 이상의 통합 시나리오 테스트가 통과해야 한다.
- 기존 hub consumer 변경 없이(또는 feature flag off 시) 현행 동작이 유지되어야 한다.

## 5) CLI 표면 (현행화)
- `tfx codex-team "작업"`: SKILL.md 기반 팀 로직 실행, psmux 세션 자동 생성
- `tfx codex-team status|attach|stop|kill|send|list`: psmux 명령을 통해 기존 `tfx team` 제어 경험 유지 (→ ADR-001 참조)
- `tfx codex-team --agents ...`: 팀 구성 에이전트 명시적 지정

## 변경 이력
- 2026-03-11: ADR-001~007 결정 사항 반영 및 v2.2+ 로드맵(Phase 1~4) 현행화
