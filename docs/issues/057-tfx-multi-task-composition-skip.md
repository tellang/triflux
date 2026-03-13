# #57 tfx-multi에서 multi 작업임에도 task 구성 누락

> 등록: 2026-03-13
> 상태: resolved
> 분류: bug / design
> 심각도: medium
> 관련: skills/tfx-multi/SKILL.md

## 질문

tfx-multi가 multi 작업임에도 task 구성(TeamCreate + TaskCreate)을 건너뛰는 케이스가 있는가?

## 의심 시나리오

1. **단일 에이전트 요청**: `/tfx-multi 1:codex "작업"` — 워커 1개면 팀 구성 없이 직접 실행할 수 있음
2. **preflight 실패 후 fallback**: Hub/route.sh 미발견 시 팀 구성을 포기하고 직접 실행
3. **triage가 서브태스크 1개만 생성**: 자동 모드에서 Codex가 분해 불필요 판단 → 직행
4. **--quick 모드 단축**: 간단한 작업에서 task 생성 오버헤드 회피
5. **Native Teams API 실패**: `EXPERIMENTAL_AGENT_TEAMS` 비활성 시 TeamCreate 실패 → task 없이 진행

## 기대 동작

- tfx-multi 호출 시 **항상** TeamCreate + TaskCreate 구성
- 워커 1개여도 팀 구조를 통해 상태 추적 + Shift+Down 네비게이션 보장
- task 없이 실행하면 결과 수집/상태 추적 불가

## 조사 필요

- [x] SKILL.md에서 task 구성 스킵 조건이 정의되어 있는지 확인
- [x] 단일 워커 요청 시 실제 동작 추적
- [x] Native Teams API 실패 시 fallback 경로에서 task 생성 여부
- [x] Lead가 triage 없이 직접 실행하는 코드 경로 존재 여부

## 해결 방향

- task 구성은 tfx-multi의 핵심 계약 — 스킵 불가 명시
- 단일 워커여도 TeamCreate + TaskCreate 필수
- API 실패 시 `--tmux` fallback에서도 task 파일 생성 보장
- **해결 완료**: SKILL.md Phase 3에 task 구성 스킵 금지 정책 명시 (2026-03-13)
