# #60 — Hub 미가동 시 자동 시작 또는 사전 안내

**분류**: design/ux
**심각도**: medium
**등록일**: 2026-03-13
**상태**: open

## 현상

`/tfx-multi` 등 오케스트레이션 명령 실행 시 Hub가 미가동이면 **Claude 네이티브 에이전트로 자동 폴백**됨.

- 사용자가 Hub 미가동을 인지하지 못한 채 Claude 토큰이 소비됨
- Codex(무료) 위임 기회를 놓침
- "Hub 미가동 → Claude 네이티브 폴백" 메시지가 나오지만, 이미 실행이 시작된 후라 되돌리기 어려움

## 기대 동작

다음 중 하나 이상 구현:

### A. 자동 시작 (권장)
- 오케스트레이션 명령 실행 전 Hub 상태 체크
- 미가동이면 자동으로 `tfx hub start` 실행 후 ready 대기
- ready 확인 후 원래 명령 계속 실행

### B. 사전 차단 + 안내
- Hub 미가동 감지 시 즉시 중단
- "Hub를 먼저 시작하세요: `tfx hub start`" 안내 후 사용자 확인 대기
- 확인 후 재실행

### C. preflight 체크
- 세션 시작 훅(`hooks/`)에서 Hub 상태 체크
- 미가동이면 HUD에 경고 표시

## 관련 파일

- `hub/index.mjs` — Hub 서버 진입점
- `scripts/tfx-route.sh` — CLI 라우팅 (Hub 연동)
- `hooks/` — 세션 시작 훅
- `skills/tfx-multi/` — 멀티 오케스트레이터

## 비고

- Hub 시작 시간: ~2초 (cold start)
- 방안 A가 UX 최상이나, 백그라운드 프로세스 관리 복잡도 있음
- 방안 C는 최소 비용으로 가시성 확보 가능
