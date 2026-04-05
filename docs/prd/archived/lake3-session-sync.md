# Lake 3: 세션 동기화

## 목표

Hub 브릿지를 통한 멀티 에이전트 세션 간 실시간 제어 및 동기화.

## 요구사항

1. Lead 에이전트 제어 프로토콜
   - `publishLeadControl()` — lead→member 커맨드 발행
   - `/bridge/control` 엔드포인트 (POST)
   - 명령: pause, resume, abort, reassign
2. 멤버 상태 동기화
   - 각 멤버의 진행 상태를 Hub에 주기적 보고
   - `/bridge/status` 엔드포인트 (GET/POST)
3. 세션 구독
   - `subscribeToLeadCommands()` — member가 lead 커맨드 수신
   - `getTeamStatus()` — 팀 전체 상태 조회

## 영향 파일

- hub/team/session-sync.mjs — 동기화 로직 (신규)
- hub/team/lead-control.mjs — 리드 제어 (신규)
- hub/server.mjs — 라우트 등록
- tests/unit/session-sync.test.mjs

## 제약

- hub/team/ 기존 코드와 통합
- codex-compat.mjs 호환 유지
