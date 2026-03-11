# Codex 팀 런타임 요구사항 (v2.2+)

## 1) 목적
- Claude Agent Team UX와 유사한 팀 기반 작업 경험(역할 분리, 병렬 작업, 상태 가시성)을 제공한다.
- 백엔드는 Codex 실행 환경과 tfx hub 모델에 맞게 구성한다.
- psmux 기반의 Windows 친화적 멀티플렉싱과 MCP 통신을 기본으로 한다. (→ ADR-001, ADR-005 참조)

## 2) 핵심 제약 및 방향 (ADR-002)
- Native Claude TeamCreate/TaskCreate API는 Codex에서 사용할 수 없으므로 Hub task/message 추상화를 사용한다.
- v2.2+ 로드맵에 따라 인프라(Named Pipe, MCP)를 단계적으로 강화하는 점진적 전환을 수행한다.

## 3) 기능 요구사항 (CR1..CR8) 현행화
- `CR1 팀 런타임 생성` [부분 구현] : psmux 기반의 네이티브 세션 관리(ADR-001, 구현됨)와 Named Pipe 제어 채널(ADR-004, 예정)을 생성한다.
- `CR2 작업 생성/할당` [구현됨] : SKILL.md를 팀 실행의 표준 진입점(Canonical Entry Point)으로 삼아 Hub task/message 추상화를 관리한다. (→ ADR-003 참조)
- `CR3 병렬 실행` [부분 구현] : Gemini(`stream-json` headless) 및 Claude subprocess 래퍼를 통해 독립적인 병렬 실행을 보장한다. (→ ADR-006, ADR-007 참조, Phase 3 예정)
- `CR4 상태 전이` [부분 구현] : Named Pipe를 통해 실시간 상태 전이(`queued -> running -> done`) 이벤트를 추적한다. (→ ADR-004 참조, Phase 1 예정) 현재는 SQLite/파일 기반 추적.
- `CR5 메시지 상관관계` [부분 구현] : 모든 메시지에 `correlation_id`를 부여하여 요청-응답을 추적한다. 향후 Named Pipe 채널 기반으로 고도화한다. (→ ADR-004 참조)
- `CR6 실패 복구` [부분 구현] : Subprocess 수준의 재시도 로직과 타임아웃 보상 규칙을 적용한다. (→ ADR-006, ADR-007 참조, Phase 3 예정)
- `CR7 운영 가시성` [구현됨] : Codex MCP 서버 통합(`codex mcp-server`)을 통해 팀/작업 단위 메트릭과 감사 로그 가시성을 제공한다. (→ ADR-005 참조)
- `CR8 호환성` [구현됨] : 기존 `tfx team/hub` 스키마를 유지하며, `/bridge/team/*` 프록시를 통해 레거시 Native Teams 파일과의 하위 호환성을 보장한다. (→ ADR-002 참조)

## 4) 수용 기준(요약)
- `CR1~CR8` 각각에 대해 최소 1개 이상의 통합 시나리오 테스트가 통과해야 한다. (Node.js `node:test` 권장 → ADR-008 참조)
- 기존 hub consumer 변경 없이(또는 feature flag off 시) 현행 동작이 유지되어야 한다.

## 5) CLI 표면 (현행화)
- `tfx team "작업"`: 표준 팀 시작 (기본: lead=claude, agents=codex,gemini)
- `tfx codex-team "작업"`: Codex 전용 팀 시작 (기본: lead=codex, agents=codex,codex)
- `tfx team status|debug|tasks|task|attach|focus|send|interrupt|control|stop|kill|list`: 
  - psmux/tmux 세션 제어 및 Hub 기반 상태 조회
  - `control`: 리드 제어 명령(interrupt/stop/pause/resume) 직접 전달 및 Hub 발행
- `--teammate-mode <tmux|wt|in-process>`: 실행 환경에 따른 런타임 선택 (Windows psmux는 tmux 모드에서 자동 사용)
- `--agents <agent1,agent2>`: 팀 구성 에이전트 명시적 지정

## 변경 이력
- 2026-03-11: ADR-001~007 결정 사항 반영 및 v2.2+ 로드맵(Phase 1~4) 현행화. psmux 및 Codex MCP 구현 상태 업데이트.
