# #30 SKILL.md vs cli.mjs 실행 경로 이원화

> 등록일: 2026-03-11
> 상태: **[CLOSED]** — ADR-003 확정으로 코드 변경 없이 해소
> 종료일: 2026-03-13

## 이슈 요약

`SKILL.md`와 `cli.mjs` 두 개의 독립된 실행 경로가 공존하여 유지보수 부하가 증가하는 문제.
팀 실행 로직의 표준 진입점이 불명확하여, 동일 기능이 두 경로에서 중복 구현될 위험이 있었음.

## Close 판정 근거

### 1. ADR-003 확정 (Accepted)

`docs/handoff/11-architecture-decisions.md` ADR-003:

- **결정**: 모든 팀 실행 로직의 표준 진입점을 `SKILL.md`로 단일화
- **cli.mjs 역할**: 네비게이션 및 HUD UI 전용 모듈로 기능 축소
- **이유**: Claude Code 스킬 시스템을 Canonical Entry Point로 삼아 일관성 확보

### 2. ADR-009에서 해결 완료 확인

`docs/adr/ADR-009-orchestration-architecture.md` (2026-03-12):

- 해결 완료 목록에 "#30 | ADR-003으로 SKILL.md primary"로 명시
- 관련 이슈 #47도 동일하게 ADR-003 확정으로 해소 처리됨

### 3. 구현은 별도 이슈(#54)에서 추적

실행 경로 단일화 방향은 ADR-003으로 확정되었으나, 실제 cli.mjs 분해 작업은
`#54 모듈 구조 결정`에서 별도 추적 중. 본 이슈(#30)는 "방향 결정" 문제이므로
ADR 확정만으로 close 가능.

## 판정

코드 변경 없이 ADR-003 아키텍처 결정 확정으로 해소. 구현 작업은 #54에서 계속.
