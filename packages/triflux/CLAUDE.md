# triflux — Claude Code 운영 가이드

<core-systems>
## 핵심 스킬 시스템 (항상 인지)

이 프로젝트는 3개의 스킬 시스템을 동시에 사용한다. 어떤 작업이든 해당 시스템의 스킬이 있는지 먼저 확인한다.

| 시스템 | 접두사 | 용도 | 스킬 수 |
|--------|--------|------|---------|
| **triflux** | `/tfx-*` | CLI 라우팅, 멀티모델 오케스트레이션, 스웜, 원격 실행 | ~40개 |
| **gstack** | `/` (접두사 없음) | QA, ship, investigate, design, review, checkpoint | ~35개 |
| **omc** | `/oh-my-claudecode:*` | autopilot, ralph, team, ultrawork, ccg | ~25개 |

스킬을 모르면 자연어 라우팅(`.claude/rules/tfx-routing.md`)으로 자동 매핑된다.
세션 종료 전 메모리 파일이 3개+ 변경됐으면 `/memory-hygiene` 제안을 검토한다.
</core-systems>

<psmux-wt>
## psmux/WT 규칙

> **이 섹션은 Windows 환경 한정.** macOS/Linux는 platform guard로 코드 레벨 no-op 처리되며 이 섹션 전체를 skip해도 됨. mac 인프라는 아래 `<macos-terminal>` 섹션 참조.

psmux 세션·WT 패인을 생성/조작/정리할 때 `tfx-psmux-rules` 스킬을 참조한다.
WT 프리징 방지: exit → sleep 2 → kill 순서. 바로 kill하지 않는다.

### wt.exe → wt-manager 경유

safety-guard가 `wt.exe`, `wt new-tab`, `wt split-pane`, `Start-Process wt`를 차단한다.
`hub/team/wt-manager.mjs`의 API를 사용한다.

| 용도 | API |
|------|-----|
| 새 탭 | `createTab({ title, command, profile, cwd })` |
| 패인 분할 | `splitPane({ direction: 'H'\|'V', title, command })` |
| 다중 배치 | `applySplitLayout([{ title, command, direction }])` |
| 탭 정리 | `closeTab(title)` / `closeStale({ olderThanMs, titlePattern })` |

차단과 대안은 항상 쌍으로 존재해야 한다. 차단만 추가하고 대안을 안 만들면 데드락.

### raw `psmux kill-session` → psmux wrapper 경유

safety-guard가 raw `psmux kill-session`을 차단한다.
세션 정리는 `hub/team/psmux.mjs` 공개 API 또는 internal wrapper로 우회한다.

| 용도 | API / 래퍼 |
|------|------------|
| 세션 조회 | `listSessions({ filterTitle?, olderThanMs? })` |
| title prefix / regex kill | `killSessionByTitle(titlePattern)` |
| stale idle 세션 정리 | `pruneStale({ olderThanMs, dryRun })` |
| Bash 훅 우회용 래퍼 | `node hub/team/psmux.mjs --internal kill-by-title <prefix\|/regex/>` |

### psmux에서 Codex 실행

| 방식 | 동작 | 이유 |
|------|------|------|
| `codex` (interactive) | 불가 | psmux에서 TTY를 못 잡음 |
| `codex < prompt.md` | 불가 | "stdin is not a terminal" |
| `codex exec "$(cat prompt.md)" -s danger-full-access --dangerously-bypass-approvals-and-sandbox` | 사용 | 유일한 안전 경로 |

`codex exec`는 config.toml `approval_mode`를 무시하므로 `--dangerously-bypass-approvals-and-sandbox` 필수.
`-s` 유효값: read-only, workspace-write, danger-full-access.
</psmux-wt>

<macos-terminal>
## macOS / Linux 터미널 처리

위 `<psmux-wt>` 룰셋은 Windows 전용이다. macOS/Linux 환경에서 triflux가 터미널/세션을 다루는 방식.

### terminal-opener.mjs 3단계 fallback (`hub/team/terminal-opener.mjs:124~149`)

`openCommand()` 가 순차 평가하는 분기:

| 우선순위 | 조건 | 동작 | API |
|---------|------|------|-----|
| 1 | `platform === "win32"` | wt-manager.createTab | `hub/team/wt-manager.mjs` |
| 2 | `isTmuxLikeMux(mux, platform)` (`detectMultiplexer()` → `getMultiplexerType()`/`hasMultiplexer()`/`hasTmux()` + literal psmux 검사) | `tmux new-window -n <title> <command>` | shell 직접 호출 |
| 3 | `platform === "darwin"` (fallback) | `open -a Terminal` | macOS `open` 명령 |
| — | Linux (mux 없음) | unsupported (return false) | — |

### 별도 mac 매니저 불필요

| 후보 | 필요성 | 이유 |
|------|--------|------|
| iTerm2 manager | **불필요** | `hub/lib/env-detect.mjs:96`이 `TERM_PROGRAM === "iTerm.app"` 감지하지만 별도 GUI 패인 조작은 tmux/psmux로 cover됨. 새 창 띄우기는 `open -a Terminal` fallback으로 충분 |
| tmux manager | **불필요** | psmux 자체가 tmux fork. `terminal-opener.mjs`가 `tmux new-window`로 직접 호출 |
| psmux manager | **이미 있음** | `hub/team/psmux.mjs` (`IS_WINDOWS`/`IS_MAC` 분기, cross-platform) |

참고 사례: OMC(`oh-my-claudecode`)도 OS-specific 매니저를 만들지 않고 Tmux Manager + Worktree Manager + Claude Launcher 3개 컴포넌트로 정리한다. 본 repo 결정의 외부 근거가 아니라 비교 참고로만 본다.

### platform guard 위치 (참고)

| 파일 | 라인 | guard |
|------|------|-------|
| `hub/team/wt-manager.mjs` | 199 | `if (platform() !== "win32") return createNonWindowsStubManager();` |
| `hub/team/headless.mjs` | 1725-1726 | `if (process.platform !== "win32") return false;` + `WT_SESSION` 체크 |
| `tfx-route.sh` | 86, 1662, 1681 | `case "$(uname -s)"` 분기 |

mac에서 위 코드가 호출돼도 early-return이라 dead code 실행 없음. **dead text(문서)만 inject되는 게 잔여 drift.**

### macOS notification (참고)

`hub/team/notify.mjs:221~234`이 `osascript`로 macOS 네이티브 알림 발송 (별도 의존성 없음).
</macos-terminal>

<codex-config>
## Codex config.toml

config.toml에 이미 설정된 값은 CLI 플래그로 중복 지정하지 않는다.

| config.toml에 있으면 | CLI에서 생략 |
|---------------------|-------------|
| `approval_mode = "auto"` | `-a`, `--full-auto` |
| `sandbox = "workspace-write"` | `-s`, `--full-auto` |

안전 패턴: config.toml에 기본값을 두고, CLI에서는 `--profile` 선택만 한다.
</codex-config>

<account-broker>
## AccountBroker (계정 브로커)

conductor, headless, swarm-hypervisor가 하나의 AccountBroker 싱글턴을 공유한다.

| 항목 | 설명 |
|------|------|
| 계정별 CircuitBreaker | 장애 격리 — 한 계정 오류가 다른 계정에 전파되지 않음 |
| busy 플래그 | 동일 계정 이중 임대(double-lease) 방지 |
| `/broker/reload` | 장시간 세션 중 accounts.json 핫리로드. active lease ownership은 reload 후에도 보존 |
| Adapter no-lease 정책 | headless adapter는 broker가 비활성/empty이면 기본 CLI auth path로 실행, broker가 enabled인데 lease가 없으면 `circuit_open` 실패 |
| Conductor no-lease 정책 | 로컬 Conductor 세션은 `broker_no_lease`를 event log에 남기고 spawn은 계속 진행. accountId가 없으므로 release는 호출하지 않음 |
| Public snapshot 정책 | `/broker/snapshot`과 dashboard는 `publicSnapshot()`만 사용. `env`, `authFile`, `profile`, `host`, 파일 경로, raw failure timestamp는 공개하지 않음 |
| Diagnostic 이벤트 | `securityViolation`, `authSyncError`는 hub가 redacted warn 로그(`broker.security_violation`, `broker.auth_sync_error`)로 처리 |
| EventEmitter 이벤트 | `lease`, `release`, `cooldown`, `tierFallback`, `circuitOpen`, `circuitClose`, `noAvailableAccounts` — HUD 연동용 |
</account-broker>

<remote>
## 원격 실행

### 스킬 구분

| 스킬 | 대상 | 방식 |
|------|------|------|
| tfx-codex-swarm | 로컬 전용 | 로컬 worktree + psmux |
| tfx-remote | Claude Code 원격 | SSH → Claude Code 세션 → 내부 tfx 라우팅 |
| tfx-remote-spawn | deprecated alias | tfx-remote로 통합됨; 직접 호출 금지 |

codex를 SSH 너머로 직접 실행하지 않는다. config.toml 충돌 + TTY 문제.
원격에서 codex가 필요하면: tfx-remote → Claude Code → Claude가 내부에서 codex 호출.

### SSH 패턴

hosts.json `os` 필드로 대상 셸을 판단한다. safety-guard도 이 필드를 참조.

| 대상 OS | 셸 | 패턴 |
|---------|-----|------|
| windows | PowerShell | scp + `pwsh -File` 필수. `$var` → `$env:VAR`, `2>/dev/null` → `2>$null` |
| darwin | zsh | 인라인 가능. brew PATH 주의 (`/opt/homebrew/bin`) |
| linux | bash | 인라인 가능. 표준 POSIX |

- `~` → `$HOME` 변환은 모든 OS 공통
</remote>

<headless-retrieval>
## Headless 결과 회수

background로 실행한 headless 결과는 **반드시 task-notification 완료 후** 읽는다.

| 패턴 | 올바름 | 이유 |
|------|--------|------|
| task-notification 후 output 파일 읽기 | YES | 프로세스 종료 = 워커 전부 완료 |
| task-notification 전 output 파일 tail | NO | 시작 메시지만 보이고 "실패"로 오진 |
| psmux capture-pane으로 중간 체크 | NO | 워커 진행 중이면 빈 화면일 수 있음 |

완료 마커: `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`
워커 상세: `$TMPDIR/tfx-headless/{sessionName}-worker-N.txt`
</headless-retrieval>

<native-bridge>
## native-bridge UI (claude agents 노출)

headless 워커는 default 로 `claude agents` 패널에 row 로 등장한다. opt-out 은 `--no-native-bridge-ui`.

| 모드 | default | row 가 보이는 위치 |
|------|---------|--------------------|
| `tfx-auto` / `tfx multi` (headless) | on | 로컬 `claude agents` |
| `tfx swarm` 로컬 shard | on | 로컬 `claude agents` (`Triflux swarm <shard-name>`) |
| `tfx swarm` 원격 shard | **skip + warn** | n/a — `registerSwarmShard()` 가 host!=local 일 때 `{ ok: true, skipped: true }` 반환하며 `"remote launcher must register on that host"` 만 경고. 원격 daemon 실제 등록은 후속 PRD. |
| interactive (tmux/wt) | off | n/a |

sentinel exit 즉시 daemon `sendKillBySessionId` 발사 → stale row 잔존 없음. PRD: `.triflux/plans/native-bridge-ui-default-expansion.md` (PR #323 으로 머지).
</native-bridge>

<cross-review>
## 교차 검증

- Claude 작성 코드 → Codex 리뷰
- Codex 작성 코드 → Claude 리뷰
- 동일 모델 self-approve 하지 않는다
- git commit 전 미검증 파일 감지 시 nudge
</cross-review>

<session-context>
## 맥락 이탈 판단

현재 세션 맥락과 무관한 요청이 감지되면 psmux 격리를 제안한다.

| 확신도 | 신호 | 행동 |
|--------|------|------|
| 확실 | "새 탭", "별도로", "새 세션" | 바로 psmux spawn |
| 높음 | 다른 프로젝트/스택 언급 | 분리 제안 |
| 중간 | 작업 유형 전환 | 분리 제안 + 현재 세션 옵션 |
| 낮음 | 현재 작업 연장 | 세션 유지 |
</session-context>

## 세부 규칙은 `.claude/rules/` 참조

| 파일 | 내용 |
|------|------|
| `.claude/rules/tfx-routing.md` | 자연어 → 스킬 라우팅, CLI 라우팅 Layer 1~3, 충돌 해소 |
| `.claude/rules/tfx-execution-skill-map.md` | tfx-auto / multi / swarm 실행 엔진 매핑, 격리 기준, 안티패턴 |
| `.claude/rules/tfx-autoplan-principles.md` | gstack autoplan의 6 decision principles, phase 우선순위, 충돌 해소 규칙 추출본 |
| `.claude/rules/tfx-update-logic.md` | triflux / OMC / gstack / Codex / Antigravity 업데이트 로직 |
| `.claude/rules/tfx-stack-coexistence.md` | gstack / superpowers / triflux 공존 원칙, 레이어 분리, 의존 방향, 충돌 해소 |
| `.claude/rules/tfx-mirror-policy.md` | packages/ 3-layer mirror 정책 (core 단순 cp / remote import 변환 / triflux byte-identical), tests 제외 룰, drift 차단 |

Claude Code는 `.claude/rules/*.md` 를 자동 로드한다. Codex CLI는 `@import` 미지원이므로 필요 시 `AGENTS.md` 를 독립 유지한다.

## GBrain Configuration (configured by /setup-gbrain)
- Engine: pglite
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-04-25
- MCP registered: yes (user scope, absolute path)
- Memory sync: artifacts-only (repo: github.com/tellang/gstack-brain-tellang)
- Current repo policy: read-write (github.com/tellang/triflux)
