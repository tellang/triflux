# triflux Claude Code 운영 가이드

<core-systems>
## 스킬 시스템

이 프로젝트는 3개의 스킬 시스템을 동시에 사용한다. 어떤 작업이든 해당 시스템의 스킬이 있는지 먼저 확인한다.

| 시스템 | 접두사 | 용도 | 스킬 수 |
|--------|--------|------|---------|
| **triflux** | `/tfx-*` | CLI 라우팅·다중 모델 조정·원격 실행 | 10개 |
| **gstack** | `/` (접두사 없음) | QA·출시·조사·설계·검토·점검 지점 | ~35개 |
| **omc** | `/oh-my-claudecode:*` | autopilot·ralph·team·execute·ultragoal | ~37개 |

필요한 스킬은 이름으로 호출한다.
</core-systems>

<code-principles>
## 코드 작성 원칙

코드는 간결하게 쓰고 의미 있는 이름을 쓴다. 주석은 이유만 짧게 한국어로 쓴다. 테스트는 회귀를 막는 핵심 경로만 최소한으로 둔다. 제거 여부는 해당 파일을 끝까지 직접 읽고 판단한다.
</code-principles>

<psmux-wt>
## psmux/WT 규칙 (Windows 한정)

macOS/Linux는 플랫폼 보호기가 아무 작업도 하지 않게 처리하므로 이 항목 자체를 건너뛰어도 된다. mac 인프라는
아래 `<macos-terminal>`을 참조한다. 정책·래퍼 API·Codex 호출 형태는 모두
`.claude/rules/tfx-psmux.md`의 규칙 1~8이 정본이며 Claude가 자동으로 불러온다.
</psmux-wt>

<macos-terminal>
## macOS / Linux 터미널 처리

위 `<psmux-wt>` 룰셋은 Windows 전용이다. macOS/Linux 환경에서 triflux가 터미널/세션을 다루는 방식.

### 터미널 실행 경로

`openCommand()` 가 순차 평가하는 분기:

| 우선순위 | 조건 | 동작 | API |
|---------|------|------|-----|
| 1 | `platform === "win32"` | `wt-manager.createTab` | `hub/team/wt-manager.mjs` |
| 2 | `isTmuxLikeMux(mux)` (`detectMultiplexer()` → `getMultiplexerType()`/`hasMultiplexer()`/`hasTmux()`) | `tmux new-window -n <title> <command>` | 셸 직접 호출 |
| 3 | `platform === "darwin"` (대체 경로) | `open -a Terminal` | macOS `open` 명령 |
| 없음 | Linux(멀티플렉서 없음) | 미지원(`false` 반환) | 없음 |

### 터미널 관리 방식

| 후보 | 필요성 | 이유 |
|------|--------|------|
| iTerm2 관리자 | **불필요** | `hub/lib/env-detect.mjs:96`이 `TERM_PROGRAM === "iTerm.app"`을 감지하지만 별도 GUI 패인 조작은 tmux로 처리한다. 새 창은 `open -a Terminal` 대체 경로로 충분하다. |
| tmux 관리자 | **불필요** | `terminal-opener.mjs`가 `tmux new-window`로 직접 호출한다. |
| psmux 관리자 | **이미 있음** | `hub/team/psmux.mjs`가 Windows에서는 psmux, macOS/Linux에서는 tmux를 사용한다. |

### 플랫폼 보호기

| 파일 | 함수 | 보호기 |
|------|------|-------|
| `hub/team/wt-manager.mjs` | `createWtManager` | `if (platform() !== "win32") return createNonWindowsStubManager();` |
| `hub/team/headless.mjs` | `autoAttachTerminal` | `if (process.platform !== "win32") return false;` + `WT_SESSION` 체크 |
| `scripts/tfx-route.sh` | `resolve_machine_profile_path`, `heartbeat_monitor` | `case "$(uname -s)"` 분기 |

Windows 전용 경로는 플랫폼과 `WT_SESSION` 조건을 확인한다.

### macOS 알림

`hub/team/notify.mjs`의 `sendToast`가 `osascript`로 macOS 기본 알림을 보낸다. 별도 의존성은 없다.
</macos-terminal>

<codex-config>
## Codex `config.toml`

`config.toml`에 이미 설정된 값은 CLI 플래그로 중복 지정하지 않는다.

| `config.toml` 키 | 같은 뜻의 CLI 플래그 |
|---|---|
| `approval_policy` (`on-request` / `never` / granular) | `--dangerously-bypass-approvals-and-sandbox` |
| `sandbox_mode` (`read-only` / `workspace-write` / `danger-full-access`) | `-s`, `--sandbox` |

`--full-auto` 는 Codex 0.147 에서 제거되었다. 안전한 방식: `config.toml`에 기본값을 두고 CLI에서는 `--profile`만 선택한다.
프로필은 `$CODEX_HOME/<이름>.config.toml` 파일이다(인라인 `[profiles.*]` 아님).
</codex-config>

<account-broker>
## AccountBroker (계정 브로커)

headless 워커는 AccountBroker를 사용한다.

| 항목 | 설명 |
|------|------|
| 계정별 회로 차단기 | 장애 격리: 한 계정 오류가 다른 계정에 전파되지 않음 |
| 사용 중 플래그 | 동일 계정 이중 임대 방지 |
| `/broker/reload` | 장시간 세션 중 accounts.json을 다시 불러온다. 활성 임대 소유권은 다시 불러온 뒤에도 보존한다. |
| 어댑터의 임대 없음 정책 | headless 어댑터는 브로커가 비활성·비어 있음이면 기본 CLI 인증 경로로 실행하고, 브로커가 활성인데 임대가 없으면 `circuit_open`으로 실패한다. |
| 공개 스냅숏 정책 | `/broker/snapshot`과 대시보드는 `publicSnapshot()`만 사용한다. `env`, `authFile`, `profile`, `host`, 파일 경로, 가공하지 않은 실패 시각은 공개하지 않는다. |
| 진단 이벤트 | `securityViolation`, `authSyncError`는 허브가 가린 경고 로그(`broker.security_violation`, `broker.auth_sync_error`)로 처리한다. |
| EventEmitter 이벤트 | `lease`, `release`, `cooldown`, `tierFallback`, `circuitOpen`, `circuitClose`, `noAvailableAccounts`: HUD 연동용 |
</account-broker>

<remote>
## 원격 실행

### 스킬 구분

| 스킬 | 대상 | 방식 |
|------|------|------|
| tfx-remote | Claude Code 원격 | SSH → Claude Code 세션 → 내부 tfx 라우팅 |

Codex를 SSH 너머로 직접 실행하지 않는다. `config.toml` 충돌과 TTY 문제가 있다.
원격에서 Codex가 필요하면 tfx-remote → Claude Code → Claude가 내부에서 Codex를 호출한다.

### SSH 패턴

`hosts.json`의 `os` 필드로 대상 셸을 판단한다.

| 대상 OS | 셸 | 패턴 |
|---------|-----|------|
| windows | PowerShell | scp + `pwsh -File` 필수. `$var` → `$env:VAR`, `2>/dev/null` → `2>$null` |
| darwin | zsh | 인라인 가능. brew의 `PATH`에 주의한다(`/opt/homebrew/bin`). |
| linux | bash | 인라인 가능. 표준 POSIX |

- `~` → `$HOME` 변환은 모든 OS 공통
</remote>

<headless-retrieval>
## 비대화식 결과 회수

백그라운드로 실행한 비대화식 결과는 **반드시 작업 알림 완료 후** 읽는다.

| 패턴 | 올바름 | 이유 |
|------|--------|------|
| 작업 알림 뒤 출력 파일 읽기 | 예 | 프로세스 종료 = 워커 전부 완료 |
| 작업 알림 전 출력 파일 끝부분 읽기 | 아니요 | 시작 메시지만 보이고 "실패"로 오진 |
| `psmux capture-pane`으로 중간 확인 | 아니요 | 워커 진행 중이면 빈 화면일 수 있음 |

완료 마커: `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`
워커 상세: `$TMPDIR/tfx-headless/{sessionName}-worker-N.txt`
</headless-retrieval>

<native-bridge>
## 팀 실행 모드

`tfx multi`는 tmux/psmux와 headless를 지원한다. in-process와 WT 팀 모드는 지원하지 않는다.
headless 워커도 tmux/psmux 방에서 돈다. 멀티플렉서가 없으면 모드와 관계없이 설치 안내 오류로 끝난다.
Windows Terminal의 독립 탭 열기는 유지한다.

## 기본 연결 UI(`claude agents` 노출)

워커는 tmux 방에서 돌고, `claude agents` 행은 그 방에 붙는 attach client다. 행에서 Enter를 누르면
워커가 도는 tmux pane이 열린다. 행은 공식 `claude --bg --exec`로 만든다(macOS/Linux).

| 대상 | 기본값 | 행에서 할 수 있는 것 |
|------|--------|----------------------|
| `tfx-auto` / `tfx multi` headless 워커 | 켬, `--no-native-bridge-ui`로 끔 | 읽기 전용 관찰 |
| `tfx-live start` 로 띄운 Claude 외 세션 | 켬 | 입력 가능. python3가 없으면 읽기 전용이고 행 이름에 `[read-only]`가 붙음 |
| 대화형 `tfx multi`(tmux/psmux) | 끔 | 해당 없음 |

- 행을 닫거나 Ctrl+Z로 목록에 돌아가도 워커는 계속 돈다.
- headless 워커 여럿이 한 방을 나눠 쓰면 행마다 방 전체가 보이고, 활성 pane은 행끼리 공유한다.
- 방이 사라지면 행이 스스로 지워진다. headless 실행은 끝날 때 자기가 연 행을 직접 지운다.
- 바깥 터미널의 질의 응답이 방 입력으로 새지 않게, 읽기 전용 attach 또는 `hub/team/agents-row-attach.py` 중계를 쓴다.
- 행 생성에는 cwd가 Claude에서 trust 된 워크스페이스여야 한다. 실패하면 워커는 그대로 돌고 경고만 남는다.

근거: [ADR-0026](docs/adr/0026-agents-row-tmux-attach.md).
</native-bridge>

<cross-review>
## 교차 검증

- Claude 작성 코드 → Codex 리뷰
- Codex 작성 코드 → Claude 리뷰
- 동일 모델이 스스로 승인하지 않는다.
</cross-review>

<session-context>
## 맥락 이탈 판단

현재 세션 맥락과 무관한 요청이 감지되면 psmux 격리를 제안한다.

| 확신도 | 신호 | 행동 |
|--------|------|------|
| 확실 | "새 탭", "별도로", "새 세션" | 바로 psmux 세션 생성 |
| 높음 | 다른 프로젝트/스택 언급 | 분리 제안 |
| 중간 | 작업 유형 전환 | 분리 제안 + 현재 세션 옵션 |
| 낮음 | 현재 작업 연장 | 세션 유지 |
</session-context>

## 세부 규칙은 `.claude/rules/` 참조

| 파일 | 내용 |
|------|------|
| `.claude/rules/tfx-execution-skill-map.md` | tfx-auto / multi 실행 경로와 코드 변경 병렬 작업의 worktree 격리 기준 |
| `.claude/rules/tfx-update-logic.md` | triflux / OMC / gstack / Codex / Antigravity 업데이트 로직 |
| `.claude/rules/tfx-stack-coexistence.md` | gstack / superpowers / triflux 공존 원칙, 레이어 분리, 의존 방향, 충돌 해소 |
| `.claude/rules/tfx-mirror-policy.md` | packages/ 3계층 미러 정책(핵심 단순 복사 / 원격 가져오기 변환 / triflux 바이트 동일), 테스트 제외 규칙, 불일치 차단 |
| `.claude/rules/tfx-cto-hub-boundary.md` | CTO 조회 표면과 Hub 소유권 경계 |
| `.claude/rules/tfx-doc-governance.md` | 실행 규칙, ADR, 설계, 계획 문서의 배치 |
| `.claude/rules/tfx-escalation-chain.md` | 자동 재시도와 CLI 전환 체인 |
| `.claude/rules/tfx-machine-profile.md` | 기기 프로필 우선순위와 실행 정책 |
| `.claude/rules/tfx-psmux.md` | Windows psmux와 WT 실행 규칙 |
| `.claude/rules/tfx-routing.md` | 역할별 CLI 라우팅과 직접 호출 제한 |
| `.claude/rules/tfx-skill-authoring.md` | 스킬 frontmatter, 프로필 표기, 검증 규약 |

Claude Code는 `.claude/rules/*.md`를 자동으로 불러온다. Codex CLI는 `@import`를 지원하지 않으므로 필요하면 `AGENTS.md`를 독립적으로 유지한다.

## GBrain

설정 정본은 `~/Projects/CLAUDE.md`다.

- 이 저장소 정책: 읽기·쓰기(github.com/tellang/triflux)
