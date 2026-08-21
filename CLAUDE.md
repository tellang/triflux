# triflux — Claude Code 운영 가이드

<core-systems>
## 핵심 스킬 시스템 (항상 인지)

이 프로젝트는 3개의 스킬 시스템을 동시에 사용한다. 어떤 작업이든 해당 시스템의 스킬이 있는지 먼저 확인한다.

| 시스템 | 접두사 | 용도 | 스킬 수 |
|--------|--------|------|---------|
| **triflux** | `/tfx-*` | CLI 라우팅·다중 모델 조정·스웜·원격 실행 | ~40개 |
| **gstack** | `/` (접두사 없음) | QA·출시·조사·설계·검토·점검 지점 | ~35개 |
| **omc** | `/oh-my-claudecode:*` | autopilot·ralph·team·ultrawork·ccg | ~25개 |

스킬을 모르면 자연어 라우팅(`.claude/rules/tfx-routing.md`)으로 자동 매핑된다.
세션 종료 전 메모리 파일이 3개+ 변경됐으면 `/memory-hygiene` 제안을 검토한다.
</core-systems>

<psmux-wt>
## psmux/WT 규칙 (Windows 한정)

macOS/Linux는 플랫폼 보호기가 아무 작업도 하지 않게 처리하므로 이 항목 자체를 건너뛰어도 된다. mac 인프라는
아래 `<macos-terminal>`을 참조한다. 정책·래퍼 API·Codex 호출 형태는 모두
`.claude/rules/tfx-psmux.md`의 규칙 1~8이 정본이며 Claude가 자동으로 불러온다.
</psmux-wt>

<macos-terminal>
## macOS / Linux 터미널 처리

위 `<psmux-wt>` 룰셋은 Windows 전용이다. macOS/Linux 환경에서 triflux가 터미널/세션을 다루는 방식.

### terminal-opener.mjs 3단계 대체 경로(`hub/team/terminal-opener.mjs:124~149`)

`openCommand()` 가 순차 평가하는 분기:

| 우선순위 | 조건 | 동작 | API |
|---------|------|------|-----|
| 1 | `platform === "win32"` | `wt-manager.createTab` | `hub/team/wt-manager.mjs` |
| 2 | `isTmuxLikeMux(mux, platform)` (`detectMultiplexer()` → `getMultiplexerType()`/`hasMultiplexer()`/`hasTmux()` + 리터럴 psmux 검사) | `tmux new-window -n <title> <command>` | 셸 직접 호출 |
| 3 | `platform === "darwin"` (대체 경로) | `open -a Terminal` | macOS `open` 명령 |
| — | Linux(멀티플렉서 없음) | 미지원(`false` 반환) | — |

### 별도 mac 매니저 불필요

| 후보 | 필요성 | 이유 |
|------|--------|------|
| iTerm2 관리자 | **불필요** | `hub/lib/env-detect.mjs:96`이 `TERM_PROGRAM === "iTerm.app"`을 감지하지만 별도 GUI 패인 조작은 tmux/psmux로 처리한다. 새 창은 `open -a Terminal` 대체 경로로 충분하다. |
| tmux 관리자 | **불필요** | psmux 자체가 tmux 포크다. `terminal-opener.mjs`가 `tmux new-window`로 직접 호출한다. |
| psmux 관리자 | **이미 있음** | `hub/team/psmux.mjs`가 `IS_WINDOWS`/`IS_MAC`으로 플랫폼을 분기한다. |

참고 사례: OMC(`oh-my-claudecode`)도 운영체제별 관리자를 만들지 않고 Tmux 관리자·워크트리 관리자·Claude 실행기 세 구성 요소로 정리한다. 이 저장소 결정의 외부 근거가 아니라 비교 참고로만 본다.

### 플랫폼 보호기 위치(참고)

| 파일 | 줄 | 보호기 |
|------|------|-------|
| `hub/team/wt-manager.mjs` | 199 | `if (platform() !== "win32") return createNonWindowsStubManager();` |
| `hub/team/headless.mjs` | 1725-1726 | `if (process.platform !== "win32") return false;` + `WT_SESSION` 체크 |
| `tfx-route.sh` | 86, 1662, 1681 | `case "$(uname -s)"` 분기 |

mac에서 위 코드가 호출돼도 일찍 반환하므로 실행되지 않는 코드가 동작하지 않는다. **실행되지 않는 문서만 주입되는 것이 남은 불일치다.**

### macOS 알림(참고)

`hub/team/notify.mjs:221~234`가 `osascript`로 macOS 기본 알림을 보낸다. 별도 의존성은 없다.
</macos-terminal>

<codex-config>
## Codex `config.toml`

`config.toml`에 이미 설정된 값은 CLI 플래그로 중복 지정하지 않는다.

| `config.toml`에 있으면 | CLI에서 생략 |
|---------------------|-------------|
| `approval_mode = "auto"` | `-a`, `--full-auto` |
| `sandbox = "workspace-write"` | `-s`, `--full-auto` |

안전한 방식: `config.toml`에 기본값을 두고 CLI에서는 `--profile`만 선택한다.
</codex-config>

<account-broker>
## AccountBroker (계정 브로커)

conductor·headless·swarm-hypervisor가 하나의 AccountBroker 단일 인스턴스를 공유한다.

| 항목 | 설명 |
|------|------|
| 계정별 회로 차단기 | 장애 격리 — 한 계정 오류가 다른 계정에 전파되지 않음 |
| 사용 중 플래그 | 동일 계정 이중 임대 방지 |
| `/broker/reload` | 장시간 세션 중 accounts.json을 다시 불러온다. 활성 임대 소유권은 다시 불러온 뒤에도 보존한다. |
| 어댑터의 임대 없음 정책 | headless 어댑터는 브로커가 비활성·비어 있음이면 기본 CLI 인증 경로로 실행하고, 브로커가 활성인데 임대가 없으면 `circuit_open`으로 실패한다. |
| Conductor의 임대 없음 정책 | 로컬 Conductor 세션은 `broker_no_lease`를 이벤트 로그에 남기고 생성을 계속한다. accountId가 없으므로 해제는 호출하지 않는다. |
| 공개 스냅숏 정책 | `/broker/snapshot`과 대시보드는 `publicSnapshot()`만 사용한다. `env`, `authFile`, `profile`, `host`, 파일 경로, 가공하지 않은 실패 시각은 공개하지 않는다. |
| 진단 이벤트 | `securityViolation`, `authSyncError`는 허브가 가린 경고 로그(`broker.security_violation`, `broker.auth_sync_error`)로 처리한다. |
| EventEmitter 이벤트 | `lease`, `release`, `cooldown`, `tierFallback`, `circuitOpen`, `circuitClose`, `noAvailableAccounts` — HUD 연동용 |
</account-broker>

<remote>
## 원격 실행

### 스킬 구분

| 스킬 | 대상 | 방식 |
|------|------|------|
| tfx-codex-swarm | 로컬 전용 | 로컬 워크트리 + psmux |
| tfx-remote | Claude Code 원격 | SSH → Claude Code 세션 → 내부 tfx 라우팅 |
| tfx-remote-spawn | 폐기된 별칭 | tfx-remote로 통합됨; 직접 호출 금지 |

Codex를 SSH 너머로 직접 실행하지 않는다. `config.toml` 충돌과 TTY 문제가 있다.
원격에서 Codex가 필요하면 tfx-remote → Claude Code → Claude가 내부에서 Codex를 호출한다.

### SSH 패턴

`hosts.json`의 `os` 필드로 대상 셸을 판단한다. `safety-guard`도 이 필드를 참조한다.

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
## 기본 연결 UI(`claude agents` 노출)

비대화식 워커는 기본적으로 `claude agents` 패널에 행으로 나타난다. 제외하려면 `--no-native-bridge-ui`를 쓴다.

| 모드 | 기본값 | 행이 보이는 위치 |
|------|---------|--------------------|
| `tfx-auto` / `tfx multi`(비대화식) | 켬 | 로컬 `claude agents` |
| `tfx swarm` 로컬 조각 | 켬 | 로컬 `claude agents`(`Triflux swarm <shard-name>`) |
| `tfx swarm` 원격 조각 | **건너뛰고 경고** | 해당 없음 — `registerSwarmShard()`가 host!=local일 때 `{ ok: true, skipped: true }`를 반환하고 `"remote launcher must register on that host"`만 경고한다. 원격 데몬 실제 등록은 후속 PRD다. |
| 대화식(tmux/wt) | 끔 | 해당 없음 |

감시자가 종료되면 즉시 데몬의 `sendKillBySessionId`를 실행해 오래된 행을 남기지 않는다. PRD: `.triflux/plans/native-bridge-ui-default-expansion.md`(PR #323으로 병합).
</native-bridge>

<cross-review>
## 교차 검증

- Claude 작성 코드 → Codex 리뷰
- Codex 작성 코드 → Claude 리뷰
- 동일 모델이 스스로 승인하지 않는다.
- git 커밋 전에 미검증 파일을 감지하면 알린다.
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
| `.claude/rules/tfx-routing.md` | 자연어 → 스킬 라우팅, CLI 라우팅 Layer 1~3, 충돌 해소 |
| `.claude/rules/tfx-execution-skill-map.md` | tfx-auto / multi / swarm 실행 엔진 매핑, 격리 기준, 안티패턴 |
| `.claude/rules/tfx-autoplan-principles.md` | gstack autoplan의 여섯 가지 결정 원칙·단계 우선순위·충돌 해소 규칙 추출본 |
| `.claude/rules/tfx-update-logic.md` | triflux / OMC / gstack / Codex / Antigravity 업데이트 로직 |
| `.claude/rules/tfx-stack-coexistence.md` | gstack / superpowers / triflux 공존 원칙, 레이어 분리, 의존 방향, 충돌 해소 |
| `.claude/rules/tfx-mirror-policy.md` | packages/ 3계층 미러 정책(핵심 단순 복사 / 원격 가져오기 변환 / triflux 바이트 동일), 테스트 제외 규칙, 불일치 차단 |

Claude Code는 `.claude/rules/*.md`를 자동으로 불러온다. Codex CLI는 `@import`를 지원하지 않으므로 필요하면 `AGENTS.md`를 독립적으로 유지한다.

## GBrain

설정 정본은 `~/Projects/CLAUDE.md` 한 곳이다. 여기 있던 사본은 `engine=pglite` /
`2026-04-25`로 오래되어 전역·Projects 블록과 서로 모순됐다(2026-07-26 제거).
실제 엔진은 postgres(Supabase), gbrain 0.42.51.0이다.

- 이 저장소 정책: 읽기·쓰기(github.com/tellang/triflux)
