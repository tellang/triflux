# Codex 팀 런타임 요구사항 (v2.2+)

## 1) 목적
- Claude Agent Team UX와 유사한 팀 기반 작업 경험(역할 분리, 병렬 작업, 상태 가시성)을 제공한다.
- 백엔드는 Codex 실행 환경과 tfx hub 모델에 맞게 구성한다.
- psmux 기반의 Windows 친화적 멀티플렉싱과 MCP 통신을 기본으로 한다. (→ ADR-001, ADR-005 참조)

## 2) 핵심 제약 및 방향 (ADR-002)
- Native Claude TeamCreate/TaskCreate API는 Codex에서 사용할 수 없으므로 Hub task/message 추상화를 사용한다.
- v2.2+ 로드맵에 따라 인프라(Named Pipe, MCP)를 단계적으로 강화하는 점진적 전환을 수행한다.

## 3) 기능 요구사항 (CR1..CR8) 현행화
- `CR1 팀 런타임 생성` [Implemented]: psmux 기반 네이티브 세션 관리(ADR-001)와 Named Pipe 제어 채널(ADR-004)을 사용한다. (psmux-steering-prototype.sh 및 hub/pipe.mjs 구현 완료)
- `CR2 작업 생성/할당` [Implemented]: SKILL.md를 팀 실행의 표준 진입점(Canonical Entry Point)으로 단일화하여 Hub task/message 추상화를 관리한다. (ADR-003 적용)
- `CR3 병렬 실행` [Implemented]: Gemini(stream-json headless, ADR-006), Claude(stream-json bilateral, ADR-007), Codex(MCP stdio, ADR-005) 워커를 통해 독립적인 병렬 실행을 보장한다. (workers/ 폴더 내 구현 완료)
- `CR4 상태 전이` [Implemented]: Named Pipe(ADR-004) 및 hub/pipeline 전이 규칙(ADR-009)을 통해 실시간 상태 전이(`plan -> prd -> exec -> verify -> fix -> complete/failed`)를 추적한다.
- `CR5 메시지 상관관계` [Implemented]: `correlation_id` 및 Named Pipe 채널(ADR-004), Codex `threadId`(ADR-005)를 사용하여 메시지 요청-응답을 정밀하게 추적한다.
- `CR6 실패 복구` [Implemented]: 파이프라인 fix loop(최대 3회) 및 Ralph 연동(최대 10회)을 통해 자동 실패 복구 및 재시도 로직을 적용한다. (ADR-009/transitions.mjs 코드 강제 적용)
- `CR7 운영 가시성` [Implemented]: psmux `pipe-pane`(ADR-001) 실시간 로그 시각화와 Codex MCP 서버 통합(ADR-005)을 통해 팀/작업 단위 가시성을 제공한다.
- `CR8 호환성` [Implemented]: 기존 `tfx team/hub` 스키마를 유지하며, bridge CLI의 nativeProxy fallback(ADR-009)을 통해 Hub 미실행 시에도 하위 호환성을 보장한다. (ADR-002: D방식 MCP Primary)

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
- 2026-03-13: ADR-001~009 확정 내용에 맞춰 CR1~CR8 요구사항 및 구현 상태(Implemented) 현행화.
- 2026-03-11: ADR-001~007 결정 사항 반영 및 v2.2+ 로드맵(Phase 1~4) 현행화. psmux 및 Codex MCP 구현 상태 업데이트.
