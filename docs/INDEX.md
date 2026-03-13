# Docs Index

문서를 빠르게 찾기 위한 인덱스입니다.

## tfx-auto / Codex 전환

- [tfx-auto 분석 (dev 기준)](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/tfx-auto-dev-analysis.md)
- [Codex 제약 주장 검증 리서치 (2026-03-10)](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/tfx-auto-codex-research.md)
- [Codex 훅 구현 가능성 및 리버스 엔지니어링 계획](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/codex-hook-reverse-engineering-plan.md)
- [Gemini 분석 메모 기반 정리](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/insights/oh-my-codex-hooks-hud-swarm-gemini.md)

## Architecture Decision Records (ADR)

- [ADR-009: 오케스트레이션 아키텍처 통합 결정](adr/ADR-009-orchestration-architecture.md) — Hub MCP vs bridge vs tfx-auto vs tfx-multi vs OMC 전체 비교, 이슈 현황, 결정 사항
- [ADR-001~007: 아키텍처 결정](handoff/11-architecture-decisions.md) — psmux, MCP, Named Pipe, Codex/Gemini 프로토콜
- [ADR-008: 테스트 프레임워크](adr/ADR-008-test-framework.md)

## Team / Runtime

- [Codex 팀 런타임 요구사항](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/codex-team-runtime-requirements.md)
- [Codex 팀 런타임 구현 계획](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/codex-team-runtime-implementation-plan.md)
- [tfx-team v2.1 PRD 참고](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/tfx-team-v2.1-prd-reference.md)
- [Native Teams 리버스 엔지니어링 인사이트](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/native-teams-insights.md)
- [Native Agent Teams Research](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/insights/native-agent-teams-research.md)

## Pipeline (v3)

- `hub/pipeline/transitions.mjs` — 7단계 전이 규칙 (plan→prd→exec→verify→fix→complete/failed), fix loop 3회, ralph 10회 바운딩
- `hub/pipeline/state.mjs` — SQLite pipeline_state CRUD
- `hub/pipeline/index.mjs` — createPipeline 통합 매니저 (advance, restart, setArtifact, isTerminal, reset)
- `hooks/pipeline-stop.mjs` — 세션 중단 시 비터미널 파이프라인 감지 + 지속 프롬프트
- `tests/pipeline/` — 전이(37) + 상태(14) + bridge fallback(5) = 56개 테스트
- Bridge CLI: `pipeline-state`, `pipeline-advance` 커맨드
- Hub HTTP: `/bridge/pipeline/{state,advance,init,list}` 엔드포인트
- Hub MCP: `pipeline_state`, `pipeline_advance`, `pipeline_init`, `pipeline_list` 도구

## Research

- [라우팅 최적화 리서치 (2026-03-13)](research-2026-03-13-routing-optimization.md) — tfx-route.sh 진단, 멀티모델 MCP 오케스트레이션, Claude hooks, 세션 핸드오프 패턴, 토큰 절약 프로젝트 딥 리서치

## Handoff

- [#16: tfx-multi v3 파이프라인 구현 핸드오프](handoff/16-tfx-multi-v3-handoff.md) — 5 Phase 구현 가이드, 확정 결정, 에이전트 실행법, 검증 체크리스트
- [중기 아키텍처 검토 (2026-03-13)](handoff/2026-03-13-midterm-actions.md) — Claude Delegator, AWS CAO, Speakeasy Gram, A2A, API quota 분배 5개 항목

## Hook / Internal

- [handoff-magic-keywords](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/insights/handoff-magic-keywords.md)
- [infra-file-sync](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/internal/infra-file-sync.md)
- [cli-route-url-aware-hints](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/internal/cli-route-url-aware-hints.md)
- [codex-deep-executor-timeout-large-refactor](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/internal/codex-deep-executor-timeout-large-refactor.md)
- [codex-executor-timeout-planning-phase](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/internal/codex-executor-timeout-planning-phase.md)
- [gemini-rate-limits-429](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/internal/gemini-rate-limits-429.md)

## Visual / Demo

- [hub-architecture.html](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/hub-architecture.html)
- [demo.tape](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/demo.tape)
- [demo-light.tape](/C:/Users/SSAFY/Desktop/Projects/tools/triflux/docs/demo-light.tape)

