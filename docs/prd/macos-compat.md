# PRD: macOS 호환성 전수 수정

## 목표
triflux의 macOS 비호환 부분을 수정하여 macOS를 1등 시민으로 지원한다.

## Shard: process-cleanup-bsd
- agent: codex
- files: hub/team/process-cleanup.mjs, packages/remote/hub/team/process-cleanup.mjs
- prompt: |
  process-cleanup.mjs의 queryUnixProcesses 함수에서 `ps -eo pid,ppid,rss,comm,args --no-headers`를 사용하는데, macOS BSD ps는 `--no-headers`를 지원하지 않는다.
  같은 프로젝트의 staleState.mjs:137처럼 BSD 호환 방식 `ps -ax -o pid=,ppid=,rss=,comm=,args=`으로 수정하라 (= 접미사가 헤더를 숨긴다).
  hub/team/process-cleanup.mjs와 packages/remote/hub/team/process-cleanup.mjs 두 파일 모두 동일하게 수정.
  기존 파싱 로직(공백 split)은 유지.

## Shard: notify-macos
- agent: codex
- files: hub/team/notify.mjs, packages/remote/hub/team/notify.mjs, packages/triflux/hub/team/notify.mjs
- prompt: |
  notify.mjs의 sendToast 함수가 win32가 아니면 "unsupported-platform"을 반환한다.
  macOS에서는 osascript를 사용한 네이티브 알림을 추가하라:
  `osascript -e 'display notification "body" with title "title"'`
  구현 방식:
  1. sendToast에서 platform === "darwin" 분기 추가
  2. execFileAsync("osascript", ["-e", `display notification "${safeBody}" with title "${safeTitle}"`], ...) 호출
  3. hub/team/notify.mjs, packages/remote/hub/team/notify.mjs, packages/triflux/hub/team/notify.mjs 모두 동일 수정

## Shard: runtime-tmux
- agent: codex
- files: hub/team/runtime-strategy.mjs
- prompt: |
  runtime-strategy.mjs의 createRuntime()이 "psmux"만 지원한다.
  macOS에서 tmux를 런타임으로 사용할 수 있도록 "tmux" 모드를 추가하라.
  hub/team/session.mjs에서 createSession/killSession/sessionExists를 tmux로 이미 구현하고 있으므로,
  session.mjs의 기존 tmux 함수들(tmuxExec, listSessions, killSession)을 import해서 tmux 런타임을 구현하라.
  패턴은 createPsmuxRuntime()과 동일하게 createTmuxRuntime()을 만들면 된다.

## Shard: dashboard-open-macos
- agent: codex
- files: hub/team/dashboard-open.mjs
- prompt: |
  dashboard-open.mjs가 Windows Terminal 전용이다.
  macOS에서는 tmux를 사용하여 대시보드를 열 수 있도록 수정하라:
  1. spawnWindowsTerminal() 외에 spawnMacTerminal() 함수 추가
  2. macOS에서는 tmux가 있으면 `tmux split-window -h` 또는 `tmux new-window`로 세션 attach
  3. tmux가 없으면 기본 터미널 앱으로 새 창 열기: `open -a Terminal`
  4. openHeadlessDashboardTarget에서 macOS 분기 추가

## Shard: monitor-macos
- agent: codex
- files: tui/monitor.mjs
- prompt: |
  tui/monitor.mjs:149에서 wt.exe를 직접 spawn하여 에이전트를 연다.
  macOS에서는 tmux를 사용하도록 수정:
  1. process.platform !== "win32" 분기 추가
  2. macOS에서는 `tmux new-window -t <session> -n <title> <command>` 사용
  3. tmux 없으면 `open -a Terminal` fallback

## Shard: cli-macos-shell
- agent: codex
- files: bin/triflux.mjs
- prompt: |
  bin/triflux.mjs에서 macOS 관련 3개 수정:
  1. 줄 855: macOS에서 bash만 체크 → ["bash", "zsh"]로 변경
  2. 줄 525: `source ~/.bashrc` → macOS에서 zsh 감지 시 `source ~/.zshrc` 사용
  3. 줄 1164: psmux 설정이 win32 전용 → macOS에서 tmux 기본 셸 체크 추가 (tmux가 있으면 `tmux show-options -g default-shell`)

## Shard: env-detect-macos
- agent: codex
- files: hub/lib/env-detect.mjs
- prompt: |
  env-detect.mjs의 detectTerminal()에서 macOS 터미널 감지를 강화:
  현재 iTerm2와 Apple_Terminal만 감지한다. 추가:
  1. TERM_PROGRAM === "WarpTerminal" → { name: "warp", hasWt: false }
  2. TERM_PROGRAM === "Alacritty" → { name: "alacritty", hasWt: false }
  3. KITTY_WINDOW_ID 환경변수 존재 → { name: "kitty", hasWt: false }

## Shard: error-context-macos
- agent: codex
- files: hooks/error-context.mjs
- prompt: |
  error-context.mjs:19의 에러 힌트가 "Windows에서는 관리자 권한, Unix에서는 chmod/sudo를 확인하세요"로 되어 있다.
  macOS 구분을 추가:
  "권한 부족. macOS에서는 chmod/sudo, Windows에서는 관리자 권한을 확인하세요."
  process.platform === "darwin"이면 macOS 우선 표시, "win32"면 Windows 우선.

## Shard: tray-macos-guard
- agent: codex
- files: packages/remote/hub/tray.mjs
- prompt: |
  tray.mjs:357에서 macOS일 때 throw Error 대신 graceful 처리:
  1. IS_WINDOWS가 아니면 throw 대신 console.warn + `open <dashboard_url>` 실행으로 변경
  2. macOS에서 tray 대신 브라우저로 대시보드 열기
  3. openDashboard()에 macOS 분기 추가: `exec('open "${url}"')` 사용
