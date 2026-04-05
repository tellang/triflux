# Lake 4: 컨텍스트 모니터

## 목표

Claude 세션의 토큰/컨텍스트 사용량을 실시간 모니터링하고 HUD에 표시.

## 현재 상태 (이전 스웜 수거)

- `hud/context-monitor.mjs` — 핵심 모니터 모듈 (13KB, 신규)
- `hud/constants.mjs` — CONTEXT_MONITOR_* 상수 3개 추가
- `hud/hud-qos-status.mjs` — contextView 통합
- `hud/providers/claude.mjs` — readClaudeContextSnapshot()
- `hud/renderers.mjs` — CTX 표시 포맷 변경 (ctx:25% → CTX:50K/200K (25%))
- `hub/middleware/request-logger.mjs` — 요청/응답 바디 캡처 + 토큰 추정
- `tests/unit/context-monitor.test.mjs` — 테스트 (신규)
- 6개 스냅샷 파일 업데이트

## 남은 작업

1. 테스트 실행 + 실패 수정 (의존성 import 정합성)
2. `buildContextUsageView()` 엣지케이스 검증
3. request-logger의 토큰 추정 정확도 검증
4. HUD 스냅샷 테스트 업데이트 확인

## 영향 파일

- hud/context-monitor.mjs (수거됨)
- hub/middleware/request-logger.mjs (수거됨)
- tests/unit/context-monitor.test.mjs (수거됨)
