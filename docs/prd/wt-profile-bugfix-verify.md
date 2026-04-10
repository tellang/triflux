# PRD: ensureWtProfile 자동 호출 버그수정 검증

목적: createTab/splitPane에서 ensureWtProfile 자동 호출 패치(532744d) 검증. 프로필 미존재 시 WT Help 다이얼로그가 뜨지 않는지 확인.

## Shard: unit-test-profile-guard
- agent: codex
- files: tests/unit/wt-manager-profile.test.mjs
- prompt: |
  tests/unit/wt-manager-profile.test.mjs를 새로 작성하라. node:test 사용.
  hub/team/wt-manager.mjs의 createTab과 splitPane이 profile 옵션 전달 시
  ensureWtProfile을 자동 호출하는지 검증하는 테스트 4건:

  1. createTab({ profile: 'triflux' }) 호출 시 ensureWtProfile이 1회 호출됨
  2. createTab({ profile 미지정 }) 호출 시 ensureWtProfile이 호출되지 않음
  3. splitPane({ profile: 'triflux' }) 호출 시 ensureWtProfile이 1회 호출됨
  4. splitPane({ profile 미지정 }) 호출 시 ensureWtProfile이 호출되지 않음

  기존 tests/unit/wt-manager.test.mjs의 createTestHarness 패턴을 참고하되,
  ensureWtProfile 호출 여부를 추적하는 spy를 추가하라.
  ensureWtProfile은 WT settings.json에 접근하므로 실제 파일시스템 없이
  호출 횟수만 검증하면 된다 (try-catch로 감싸져 있어 실패해도 진행됨).

## Shard: integration-test-wt-launch
- agent: gemini
- files: tests/integration/wt-profile-launch.test.mjs
- prompt: |
  tests/integration/wt-profile-launch.test.mjs를 새로 작성하라.
  실제 Windows Terminal이 설치된 환경에서 wt-manager를 통해 탭을 생성하고
  Help 다이얼로그가 뜨지 않는지 검증하는 통합 테스트 2건:

  1. createTab으로 triflux 프로필 탭 생성 -> success: true 반환 확인
  2. 생성된 탭 정리 (closeTab) -> 정상 종료 확인

  process.platform !== 'win32'이면 skip 처리.
  테스트 후 반드시 closeTab으로 정리. node:test 사용.

## Shard: source-audit
- agent: codex
- files: .triflux/audit/profile-guard-audit.md
- prompt: |
  hub/team/wt-manager.mjs, hub/team/dashboard-open.mjs, hub/team/headless.mjs,
  hub/team/session.mjs, hub/team/tui.mjs에서 profile 관련 코드를 모두 감사하라.

  확인 항목:
  1. wt-manager의 createTab/splitPane에 ensureWtProfile 가드가 있는가
  2. dashboard-open이 profile을 전달할 때 wt-manager 경유인가 (직접 wt.exe 호출 없는가)
  3. headless가 여전히 별도 ensureWtProfile을 호출하는가 (이중 호출 가능성)
  4. session/tui에서 profile 전달 경로가 wt-manager 경유인가

  결과를 .triflux/audit/profile-guard-audit.md에 마크다운 테이블로 작성하라.
  문제 발견 시 severity (critical/warning/info)를 표시.
