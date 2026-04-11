# PRD: wt/psmux Cross-Platform Terminal Layer — Phase 1

목적: wt-manager 중심 터미널 추상화 Phase 1 구현. env-detect 신규 모듈 + wt-manager 개선 + 직접 wt.exe 호출 제거.

## Shard: env-detect
- agent: codex
- files: hub/lib/env-detect.mjs
- prompt: |
  hub/lib/env-detect.mjs 신규 모듈을 생성하라.
  모듈 레벨 lazy singleton 캐시 패턴 사용. 프로세스당 한 번만 which/where 실행.

  export할 함수:
  1. detectShell() — { name: 'pwsh'|'powershell'|'bash'|'zsh'|'sh', path: string, version: string|null }
     Windows: pwsh.exe 먼저, 없으면 powershell.exe fallback. Unix: $SHELL 또는 /bin/sh.
  2. detectTerminal() — { name: 'windows-terminal'|'iterm2'|'terminal-app'|'unknown', hasWt: boolean }
     Windows: where wt.exe. macOS: $TERM_PROGRAM.
  3. detectMultiplexer() — { name: 'tmux'|'none', path: string|null }
     which tmux 또는 where tmux.
  4. getEnvironment() — 위 3개를 합친 통합 객체 { shell, terminal, multiplexer, platform: process.platform }

  캐시: 모듈 스코프 let _cached = null; getEnvironment() 호출 시 _cached가 있으면 반환.
  installHint 필드: 감지 실패 시 설치 안내 문자열 (예: "pwsh: winget install Microsoft.PowerShell").
  child_process.execFileSync를 사용하되 timeout 3000ms, stdio 'pipe'.
  에러 시 throw 하지 않고 graceful fallback (unknown/null).

## Shard: keyword-rules-extend
- agent: claude
- files: hooks/keyword-rules.json, packages/core/hooks/keyword-rules.json, packages/triflux/hooks/keyword-rules.json
- prompt: |
  hooks/keyword-rules.json에 다음 context_hint 규칙 3개를 추가하라:
  1. "wt-tab-rename" — 패턴: "탭 이름 바꿔|탭 rename|rename tab|탭 제목"
     hint: wt-manager의 renameTab API 안내
  2. "wt-tab-list" — 패턴: "탭 목록|탭 리스트|list tabs|열린 탭"
     hint: wt-manager의 listTabs API 안내
  3. "wt-tab-close" — 패턴: "탭 닫아|탭 종료|close tab|탭 정리"
     hint: wt-manager의 closeTab API 안내

  기존 wt-tab-route 규칙의 패턴과 hint 형식을 따른다.
  packages/core/hooks/keyword-rules.json과 packages/triflux/hooks/keyword-rules.json에도 동일 적용.

## Shard: wt-manager-improve
- agent: codex
- depends: env-detect
- files: hub/team/wt-manager.mjs, packages/core/hub/team/wt-manager.mjs, packages/triflux/hub/team/wt-manager.mjs
- prompt: |
  hub/team/wt-manager.mjs를 개선하라. env-detect 연동이 핵심.

  1. import { getEnvironment } from '../lib/env-detect.mjs'; 추가
  2. createTab()에서 하드코딩된 pwsh.exe 대신 env.shell.path 사용:
     const env = getEnvironment();
     const shellPath = opts.profile || env.shell.path;
  3. renameTab({ oldTitle, newTitle }) 메서드 추가:
     wt.exe의 경우 title 변경은 pid 파일 rename으로 관리.
  4. getEnvironmentInfo() 메서드 추가: getEnvironment() 결과를 HUD/외부에 노출.
  5. WT 미설치 시 graceful failure: env.terminal.hasWt가 false면 createTab이 Error 대신
     { success: false, reason: 'wt-not-installed', installHint: env.terminal.installHint } 반환.

  packages/core/, packages/triflux/ 동기화 필수.

## Shard: refactor-headless-dashboard
- agent: gemini
- depends: wt-manager-improve
- files: hub/team/headless.mjs, hub/team/dashboard-open.mjs
- prompt: |
  hub/team/headless.mjs와 hub/team/dashboard-open.mjs에서 직접 wt.exe 호출을 모두 제거하고 wt-manager 경유로 전환하라.

  headless.mjs:
  1. import { createWtManager } from './wt-manager.mjs'; 추가
  2. autoAttachTerminal() — wt.exe spawn 대신 wt.createTab() 사용
  3. attachDashboardTab() — wt.exe spawn 대신 wt.createTab() 사용
  4. buildWtAttachArgs() 제거 (wt-manager가 대체)
  5. spawnDetachedWt() 제거 (wt-manager가 대체)
  6. ensureWtProfile() → wt-manager로 이관 (이 shard에서는 호출만 교체)

  dashboard-open.mjs:
  1. spawn("wt.exe", ...) → wt.createTab({ title, command, cwd }) 전환
  2. wt.exe 직접 import/require 제거

## Shard: refactor-session-tui
- agent: gemini
- depends: wt-manager-improve
- files: hub/team/session.mjs, hub/team/tui.mjs, hub/team/cli/commands/start/start-wt.mjs
- prompt: |
  session.mjs, tui.mjs, start-wt.mjs에서 직접 wt.exe 호출을 모두 제거하고 wt-manager 경유로 전환하라.

  session.mjs:
  1. wt() 래퍼 함수 제거
  2. createWtSession을 async로 전환: async function createWtSession(...)
  3. 내부에서 wt.createTab() await 사용
  4. hasWindowsTerminal() → getEnvironment().terminal.hasWt로 대체

  tui.mjs:
  1. openTab 기본 구현에서 execFile("wt.exe") → wt.createTab() 전환
  2. buildDashboardAttachRequest() → wt-manager 구조 반환으로 교체

  start-wt.mjs:
  1. createWtSession 호출에 await 추가 (async 전환 반영)

## Shard: tests
- agent: claude
- depends: env-detect, wt-manager-improve, refactor-headless-dashboard, refactor-session-tui
- files: tests/unit/env-detect.test.mjs, tests/unit/wt-manager.test.mjs
- prompt: |
  env-detect와 wt-manager 개선에 대한 단위 테스트를 작성하라.

  tests/unit/env-detect.test.mjs (신규, 8건):
  1. detectShell() — pwsh 감지 (Windows mock)
  2. detectShell() — bash 감지 (Unix mock)
  3. detectShell() — fallback to powershell when pwsh missing
  4. detectTerminal() — Windows Terminal 감지
  5. detectTerminal() — WT 미설치 시 unknown
  6. detectMultiplexer() — tmux 감지
  7. getEnvironment() — 캐시 동작 검증 (두 번 호출 시 같은 객체)
  8. installHint — 미감지 시 힌트 문자열 존재

  tests/unit/wt-manager.test.mjs (기존 확장, 4건 추가):
  1. renameTab() — pid 파일 rename 검증
  2. getEnvironmentInfo() — env-detect 결과 반환 검증
  3. createTab() graceful failure — hasWt false 시 success:false 반환
  4. createTab() — env.shell.path 사용 검증

  vitest 또는 프로젝트 기존 테스트 프레임워크 사용. 기존 wt-manager.test.mjs 스타일 따를 것.
