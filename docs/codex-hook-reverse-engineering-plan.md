# Codex 훅 구현 가능성 및 리버스 엔지니어링 계획

## 질문

Claude Code의 훅/팀 동작을 Codex 환경에서 역공학해 구현할 수 있는가?

## 답변 (실무 관점)

가능하다. 다만 "동일 API 복제"보다 "동일 목적의 동작 재현" 접근이 현실적이다.

## 접근 전략

## 1) 이벤트 소스 계층

- 공식 Codex `notify`를 1차 이벤트 트리거로 사용
- 필요 이벤트:
  - turn 완료
  - 오류/타임아웃
  - 사용자 입력 감지(키워드 기반)
- 구현 포인트:
  - `~/.codex/config.toml`의 `notify = [...]`
  - `notify-hook.js`에서 상태/큐/후속 명령 dispatch

## 2) 훅 확장 계층

- `.omx/hooks/*.mjs` 플러그인 로더 방식으로 확장
- 필수 계약:
  - 이벤트 스키마
  - 실패 격리(한 플러그인 실패가 전체 중단을 유발하지 않음)
  - 타임아웃/재시도 정책

## 3) 팀/스웜 계층

- `swarm`을 별도 엔진으로 만들기보다 `team` alias로 통합
- task/message/state를 파일 또는 MCP로 일원화
- 최소 기능:
  - create-task
  - claim/release
  - status transition
  - mailbox/message

## 4) HUD 계층

- `.omx/state` 기반 2-layer 렌더링
  - Layer 1: Codex status line
  - Layer 2: OMX orchestration HUD (`omx hud --watch`)
- 팀 모드에서는 tmux pane 레이아웃과 동기화

## 리버스 엔지니어링 체크리스트

1. Claude 측 도구의 행위 단위 정의
   - TeamCreate / TaskCreate / TaskUpdate / SendMessage
2. Codex 측 대응 primitive 매핑
   - notify, CLI, MCP, team runtime 파일/DB
3. 동치성 테스트
   - 상태 전이 일치
   - 중복 실행 방지
   - 타임아웃 복구

## 리스크

- Rust 코어를 직접 수정하는 방식은 유지보수 비용이 높다.
- 따라서 "외부 확장 레이어(스크립트/MCP/플러그인)" 우선 전략이 권장된다.

## 제안

1. Core patch 금지, extension-first 원칙 채택
2. `notify` + `.omx/hooks` + `team api`를 표준 인터페이스로 고정
3. 각 훅 플러그인에 계약 테스트 추가

