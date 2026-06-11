# Changelog

All notable changes to triflux will be documented in this file.

## [10.35.0] - 2026-06-11

### Added
- **[#390]** agy 인터랙티브 세션 hub 자동등록 훅 (PR #406) — PreInvocation 단일 이벤트, invocationNum 게이트, `~/.gemini/config/hooks.json` idempotent installer
- tfx-live daemon/caller provenance + config-dir resolution 단일화 (PR #382)
- cto: synapse 세션 repoRoot 파생 grouping — `live_session_groups` additive 키 (PR #405)

### Fixed
- **[#394]** swarm redundant winner를 clean commit evidence로 게이트 (PR #399)
- **[#401]** antigravity-family swarm/team 워커 host HOME 보존 — OAuth keyring 단절 해소
- **[#402]** prompt-guide P1: tfx-route 절대경로 앵커 + swarm worker 완료 계약 강화 + headless handoff grounding
- **[#306]** antigravity readiness gate stale OAuth 차단 + Keychain raw-token 수용 (PR #410)
- daemon control-key를 attach/ask/interrupt/kill 경로에 배선 — tfx-live ask EAUTH 해소 (PR #404)
- **[#379]** agy HUD Keychain-first quota + 만료 파일 토큰 fallback
- hud: 비-darwin에서 Antigravity Keychain `security` spawn 차단 (PR #403)
- **[#391]** mcp: serena를 CORE_SERVERS 강제 enable에서 제거 (PR #400)
- win32 daemon launcher homedir fallback (HOME 미수용)

### Tests
- worktree-cwd full npm test hermetic화 — `TFX_HUB_PID_DIR`/`TFX_HUB_STATE_DIR` seam + test-lock mkdtemp 격리, 4278 tests 0 fail (PR #412)
- cross-platform Keychain 커버리지 — `TFX_HUD_KEYCHAIN_FORCE` seam

### Changed
- GEMINI.md에 gstack 스킬 라우팅/health stack 규칙 추가

## [Unreleased]

## [10.34.0] - 2026-06-10

### Fixed
- **[#395]** codex-hooks: serialize hooks.state in the codex canonical table-header form with an idempotent convergence check — every Claude SessionStart re-appended the inline form next to codex 0.137+'s table form, producing a TOML duplicate key that killed every codex invocation; manual repair was undone on the next session start
- **[#396]** native-bridge: present the daemon control-key on dispatch and preserve the daemon rejection reason — worker registration to the claude agents panel failed with EAUTH on every swarm/multi run
- swarm hub hygiene: expire clean (no dirty files) stale synapse sessions sooner instead of holding everything 24h — dirty-file sessions keep the 24h guard window, clean ones default to a short expire (`TFX_SYNAPSE_CLEAN_EXPIRE_MS`)
- tray: dedupe mac tray processes machine-wide (worktree copies and other clones reap as the same tray) and suppress tray auto-spawn from worktree/ephemeral hub contexts — both sides of the duplicate menubar icon incident
- hub: lifecycle observability guards — SIGKILL failures are no longer silent, polluted `TFX_HUB_PORT` is guarded before forwarding
- **[#393]** claude integration: refresh claude cwd projections, warn on runtime compatibility flags, normalize agent json rows, drop duplicate runtime imports
- **[#392]** v10.33.1 follow-ups: route integration tests use a no-op hub-ensure stub (no more canonical 27888 binds from isolated HOME), test-lock drains with a bounded loop so real failures stop masking as exit 0, packages/core hooks join the mirror gate, hub-auth assertions match the non-canonical-port token design, and 4 hub-restart route cases unskip behind `TFX_HUB_ALLOW_EPHEMERAL_PORT=1`

### Changed
- skill-hygiene: drop frontmatter `triggers` and duplicated Telemetry blocks across 22 active skills, diet descriptions (activation phrases preserved), 3-way mirrors byte-identical
- mcp-registry: remove the serena entry
- routing docs: drop stale gpt-5.3-codex and `--cli gemini` alias wording

### Added
- jsconfig for editor type-checking over hub/scripts/tests

### Tests
- stabilize hub port cwd assumptions (worktree-clamp no longer fails the suite from a worktree cwd)
- update tray singleton expectations to machine-wide semantics; drop the stale frontmatter-triggers assertion; biome formatting catch-ups surfaced by the new CI lint step


## [10.33.1] - 2026-06-09

### Added

- **`feat(hub)` Stop-hook interactive 세션 heartbeat.** Claude는 UserPromptSubmit 에서만 heartbeat 해서, 열어둔 채 매 분 새 프롬프트를 안 보내는 세션이 5분 interactive TTL 을 넘겨 `stale` 로 떨어져 `cto status` live_sessions / tray 에서 사라졌다(다음 프롬프트가 재활성화하기 전까지 미등록처럼 보임). `hook-orchestrator` 가 Stop 이벤트(어시스턴트 턴 종료)마다 synapse heartbeat 를 추가 발사(UserPromptSubmit 과 동일한 fire-and-forget + bounded drain). 진짜 완전 idle(턴 자체가 없음)은 여전히 TTL 후 stale — 의도된 dead 신호. packages/{triflux,core} 미러. (loopback-hub orchestrator 테스트로 Stop 시 `/synapse/heartbeat` POST 도달 검증)
- **`feat(mirror-gate)`** `check-packages-mirror` 에 packages/remote 구조 검증 추가. 기존엔 triflux/core 만 byte-비교하고 remote(=pack 이 core import 를 `@triflux/core/*` 로 rewrite, byte 비교 불가)는 전혀 검증 안 해 두 드리프트가 무성하게 출하됐다 — core-only 모듈로의 깨진 상대 import(standalone 설치 시 Cannot find module)와 stale non-JS asset(tray UI). remote .mjs 의 모든 import 해석 가능(상대→remote, `@triflux/core/X`→core) + non-.mjs 의 root byte-동일을 검증. JSDoc 사용 예시 오탐 방지 위해 import 스캔 전 주석 제거.
- **`feat(claude169 compat)`** Claude Code 2.1.169 호환 3트랙. `claude agents --json` mixed/daemon row 정규화(`state||status`, `id/short`, `sessionId/session_id`), `tfx doctor --json` 에 `CLAUDE_CODE_SAFE_MODE`/disabled bundled skills/managed MCP policy 경고, `/cd` `CwdChanged` 이벤트로 native-bridge 세션 projection cwd 갱신. packages/{triflux,core,remote} 미러.

### Fixed

- **`fix(mirror)` packages/remote 깨진 import 복구.** v10.33.0 의 `packages/remote/hub/server.mjs`·`scripts/lib/env-probe.mjs` 가 remote 에 존재하지 않는 core 모듈을 상대 경로(`./account-broker.mjs`, `../../hub/platform.mjs` 등)로 import 해 in-workspace 에서만 우연히 해석되고 standalone `@triflux/remote` 설치에선 깨졌다. core 소유 모듈은 `@triflux/core/*` 로 복구, remote-local(hub-lifecycle/mac-focus)은 상대 유지. core/triflux 사전존재 미러 드리프트도 root 와 정합.
- **`fix(hub)` reaper kill 실패 관측성 + startHubDaemon 포트 정규화 (FU3).** ① startup reaper 가 `failed[]`(SIGKILL 불가 orphan, EPERM/defunct)를 버려 로그 신호 0으로 생존하던 갭 → `hub.startup_reaper_failed` warn 으로 표면화. ② `startHubDaemon` 이 오염된 `TFX_HUB_PORT` 를 그대로 forward 하고 `getDefaultHubPort()` 로 probe 해 worktree/ephemeral 에서 daemon 이 binding 하지 않는 포트를 probe 할 수 있던 문제 → `resolveHubPortForContext` 로 canonical 포트를 child env·probe 양쪽에 적용(방어심도). packages/{triflux,remote} 미러.
- **`fix(codex-hook)`** register/heartbeat 부수효과가 내뿜는 stray stdout(`[mcp-sync]` 등)이 codex 훅의 stdout 계약(JSON-only)을 오염시키던 문제 → `runHookSideEffectsWithStdoutSuppressed` 로 감싸 `{}` 페이로드만 stdout 도달, finally 에서 복원. packages/{core,triflux} 미러.

### Changed

- **`feat(tray)`** macOS tray Sessions 탭 리디자인. cramped 320x520 2-컬럼 CTO/Workers drawer → 460x720 단일 컬럼 Prompt→Agents. KPI 카드(Live/Active/Idle/Stale), runtime progress bar → Agent Mix chips, Projects/CTO/Workers → Workspaces(라벨 chip). workspace 경로 trailing-slash 정규화로 동일 디렉토리 분할 방지. 460x720 라이브 검증(스크린샷+DOM). packages/triflux 미러.
- **`chore`** 누적 biome import-sort/format 드리프트 정리(CI lint 미실행으로 invisible 누적분), remote tray 미러 동기(v10.33.0 출하 누락분), tray scratch 파일 제거 + `.superpowers/` ignore, Codex fallback docs 의 근거 없는 정량치 제거.

### Tests

- route-smoke `runBash` spawnSync 에 per-call timeout(동기 spawnSync hang → 스위트 전체 hang 방지), hook-orchestrator Stop heartbeat 테스트, mirror-core fixture 에 claude-agent-session-normalizer 추가(claude169 가 source CORE_FILE_MIRRORS 만 갱신하고 fixture 누락 → 3 fail).

## [10.33.0] - 2026-06-09

### Added

- **`feat(hub)`** macOS 네이티브 tray. Swift `mac-tray.swift` 팝오버 + `tray.html` 드롭다운 UI, `/api/tray-state`·`/api/focus-session` 엔드포인트, `tray-lifecycle`/`tray-runtime`/`tray-state` 모듈 분리. `reapExistingMacTrayProcesses`로 기동 시 stale tray 프로세스 정리. packages/{triflux,remote} 미러.

### Fixed

- **`fix(hub)` hub 고아 프로세스 누수.** 워커 worktree가 env에 실린 비표준 `TFX_HUB_PORT`로 전용 hub를 detached spawn하고 회수되지 않아 ~24h에 다수(실측 48개/~1.4GB) 누적되던 결함. ① `resolveHubPortForContext`가 worktree/ephemeral 컨텍스트(cwd `.claude/worktrees`·`.worktrees`·`.codex-swarm/wt-` 또는 `TFX_WORKER_*`/`TFX_TEAM_*`/`TFX_EPHEMERAL` env)에서 canonical 포트 27888을 강제 — server bootstrap·hub-ensure·tray-lifecycle·env-probe·tfx-route 모든 spawn 경로에 적용해 워커가 비표준 포트 hub를 새로 띄우지 않고 27888 primary를 재사용/대기. 비-worktree 커스텀 `TFX_HUB_PORT`는 그대로 honor(회귀 없음, PR #158/#197 27888 안정화 불변). ② `reapExistingHubProcesses`가 canonical hub(27888) 기동 성공 시 비표준 포트 고아 hub를 일괄 정리(self·pidfile pid·27888 listener는 보존, 나머지 SIGTERM→SIGKILL). ③ 비-canonical hub는 idle 30분 후 자동 종료(`HUB_IDLE_TIMEOUT_DEFAULT_MS` 포트조건부, primary는 영구). ④ pidfile/token 파일은 소유 hub만 삭제(`cleanupOwnedPidFile`/`cleanupOwnedTokenFile`). packages/{triflux,remote} 미러.
- **`fix(native-bridge)`** claude-native worker adoption harness가 production Triflux native bridge에 attach할 때 `~/.claude/daemon/control.key`를 제시(`buildDaemonControlAuth`) — control-key 인증을 강제하는 daemon에서도 attach 성공.
- **`fix(hub, tray)`** mac-tray 앱 활성화 정책으로 입력·포커스 문제 해결, `tray.html` 코드리뷰 버그 수정, `/api/focus-session` JSON body 파싱/구조분해 수정.

### Tests

- hub-lifecycle / tray-lifecycle / tray-runtime / tray-state / tray-singleton / tray-html / mac-focus / pack-remote 단위테스트 신규, env-probe·hub-server-port·hub-ensure-port-cascade·packages-sync·tfx-route-bash-node-parity 확장. (hub 누수 fix: server-boundary 포트 가드·reaper 보존 로직·token 소유권 회귀 테스트 포함)

## [10.32.0] - 2026-06-08

### Added

- **`feat(codex)`** Codex 인터랙티브 세션을 시작 시 tfx-hub synapse 레지스트리에 자동 등록하는 lean 훅. Claude의 `registerInteractiveSession`을 codex 평면에서 미러 — `hooks/codex-session-hook.mjs`(argv 모드 `register`/`heartbeat`)가 허브가 꺼져있으면 hub-ensure로 켜고 register/heartbeat 후 drain, 항상 exit 0(세션 비차단). `scripts/ensure-codex-hooks.mjs`가 `~/.codex/hooks.json`(PascalCase)에 SessionStart/UserPromptSubmit 훅을 멱등 등록 + `config.toml [hooks.state] trusted_hash` 사전주입(codex 0.137 알고리즘 역공학, oh-my-codex 실제 해시와 byte-match 검증 → 인터랙티브 `/hooks` 승인 불필요). 기존 oh-my-codex/superpowers 엔트리 보존(merge only). `scripts/setup.mjs`가 `ensureCodexProfiles` 후 배선. 범위 = 인터랙티브 codex 세션(codex exec worker는 MCP roster 추적). packages/{core,triflux} 미러.
- **`feat(cto)`** 같은 프로젝트에서 2개 이상 live 세션이 감지되면 CTO lake collect를 자동 실행. `hub/team/cto-auto-collect.mjs`가 `synapse.session.started`에서 `querySessions`로 동일 cwd/worktree peer를 확인해 peer≥1이면 debounced `runCollect`로 `.triflux/lake/current.md`를 갱신 → north-star brief가 협업 시점에만 활성화. env `TFX_CTO_AUTO_COLLECT` opt-out, fresh-lake skip, non-blocking. Codex 자동등록과 결합해 Codex+Claude 멀티세션까지 감지. packages/{triflux,remote} 미러(remote는 lazy `triflux/cto/collect.mjs` import).

### Tests

- **(codex 등록 훅 + CTO 트리거)** 3 hermetic 단위테스트(mkdtemp/seam): codex-session-hook(register/heartbeat/casing fallback/error 흡수), ensure-codex-hooks(PascalCase merge/no-clobber/idempotent/trusted_hash 골든 + oh-my-codex 실해시 교차검증), cto-auto-collect(peer 게이트/debounce/fresh-lake/opt-out). 전체 4116 pass / 0 fail, biome + lint:skills clean.

## [10.31.0] - 2026-06-08

### Added

- **`feat(tfx-route)` (PR #387)** codex/agy 워커 프롬프트에 등록 스킬을 주입하는 opt-in 프레임워크. `--skill <name>`(env `TFX_INJECT_SKILL`)으로 `skills/<name>/SKILL.md` 본문을 codex/agy 프롬프트 앞에 prepend(`prepend_skill`, CLI-agnostic). 미지정 시 no-op로 현행 동작 무변경. `printf`/`cat` temp-file 전달이라 codex `$`·agy `₩`/백슬래시 특수문자를 셸 재확장 없이 리터럴 보존(argv `--` 뒤 / stdin `printf %s`). skill name path-traversal 가드 포함. 네이티브 CLI 스킬(`/name` 슬래시)은 TUI 전용이라 headless에서 호출 불가 → prose 주입 채택(omc 레퍼런스도 동일). packages/triflux 미러 동반.
- **`feat(tfx-route)` (PR #387)** agy(Gemini 3.x) 레인 anti-overclaim 규율 블록(`append_agy_anti_overclaim`, env `TFX_AGY_ANTI_OVERCLAIM` 기본 on). Gemini 3.x 과신(AA-Omniscience 실측: 정확도 53-56% 대비 환각률 88-91%) 대응 — fresh 증거 없는 완료 주장 금지 + grounded abstention("No Info") 규율을 프롬프트 END에 append(Gemini 3 공식 가이드의 부정제약-END 배치, blanket "do not guess" 회피).

### Fixed

- **`fix(synapse)` (PR #388)** bg/interactive 세션이 synapse registry에서 사라지고 dead 세션이 무한 누적되던 두 결함 수정. `pruneExpired()`가 stale/expired 세션을 `expireTimeoutMs`(기본 24h) 초과 시 제거하되 live(active/idle)는 보존(git-preflight dirty-file 가드 의존). heartbeat self-heal — 미등록 세션이 locator(worktreePath/cwd) 있는 heartbeat를 보내면 register로 복구(SessionStart register POST drop 회복). self-heal 세션은 명시 sessionKind 없으면 interactive로 본다(headless 기본값의 30s timeout→즉시 stale 재현 방지). `hub/server.mjs`에 60초 주기 prune sweep + shutdown clear. packages/{triflux,remote} 미러 동반.

### Tests

- **(PR #387)** tfx-route 스킬 주입 9 단위테스트(`$`/`₩`/백슬래시/`--flag` parse-safety, path-traversal 거부, anti-overclaim, 레인 wiring). north-star 회귀 5/5 무손상.
- **(PR #388)** synapse-registry 회귀 가드(pruneExpired live 보존/explicit olderThanMs, self-heal 발동/미발동/UserPromptSubmit interactive 보존).

## [10.30.1] - 2026-06-08

### Fixed

- **`fix(codex)` (PR #386)** codex 0.137이 Codex MCP tool 스키마에서 `profile` 필드를 폐기해 default codex 레인이 `unknown field \`profile\``로 즉사하던 회귀를 수정. `hub/workers/codex-mcp.mjs:buildCodexArguments`가 더 이상 `args.profile`을 tool 인자로 보내지 않고, effort 프로필을 SSOT `~/.codex/<profile>.config.toml`에서 `model` + `config.model_reasoning_effort`로 해석한다(inline-comment tolerant TOML 파싱 + name-suffix fallback). CLI `exec --profile` 플래그는 0.137에서 정상이라 영향 없음. packages/{triflux,remote} 미러 동반.
- **`fix(tests)` (PR #386)** 통합 테스트(team-bridge/hub-restart/quota)가 full `tfx-route.sh`(minimal profile)로 실제 `~/.codex/config.toml`을 config-swap하다 `--test-concurrency` 레이스로 손상시키던 non-hermetic 버그 격리. `scripts/tfx-route.sh`에 `TFX_CODEX_CONFIG` override seam(미설정 시 실제 경로 default)을 추가하고, per-file throwaway config fixture(`tests/helpers/codex-config-fixture.mjs`)로 격리.
- **`fix(skills)` (PR #385)** tfx-goal-clarify Step 1의 route.sh signature 정정.

### Added

- **`feat(skills)` (PR #385)** tfx-goal-clarify 스킬을 repo 본체로 promote — 자연어 아이디어를 Claude Code `/goal` 명령 블록으로 변환하는 clarifier.

## [10.30.0] - 2026-06-04

### Added

- **`feat(cto)` (PR #380)** triflux CTO lake console — `tfx cto collect/status/dashboard` authority 레이어. 기존 durable surface(git/tfx_hub/tfx_swarm/tfx_synapse/ultragoal/handoffs)만 읽어 ignored `.triflux/lake/*` runtime 파일로 집계하는 thin repo-local 레이어다(신규 daemon/scheduler/memory engine 없음). north-star brief 를 Claude(SessionStart/UserPromptSubmit hook → `additionalContext`)와 Codex(`tfx-route.sh` route seam prepend)에 주입하고, 항상 켜진 HUD north-star row + `status --json` pull surface + AGENTS.md 포인터를 제공한다. `TFX_CTO_NORTH_STAR=0` opt-out. packages 3-layer mirror 동반.

### Fixed

- **`fix(cto)` (PR #384)** CTO efficacy 갭 2건 해소. (작업 A) `scripts/tfx-route.sh` antigravity lane 에 north-star prepend 를 추가해 codex 만 받던 brief 를 agy 워커도 수신한다(sentinel probe 통과). (작업 B) interactive 세션 live 추적 — SessionStart/주기 heartbeat 로 synapse registry 를 갱신 유지하고, `cto/status.mjs` `active_shards` 를 하드코딩 `[]` 에서 실제 swarm shard derive 로 교체하며, `cto/collect.mjs` 가 swarm lock object map 을 `workerId` 별 shard row 로 환원한다. packages 3-layer mirror 동반.
- **`fix(synapse)` (commits `27c4fc57`, `8f3be4c7`)** CI synapse drain 안정화 — `drainPendingSynapse()` timeout 을 ref 유지해 await 중인 drain 이 process exit 에 취소되지 않게 하고, in-flight POST 가 먼저 settle 하면 ref 된 타이머를 정리해 자연 종료가 지연되지 않게 한다.
- **`fix(cto)` (commits `e66b189b`, `8e728aa4`)** lake contract 강화(strict `current.json`/`ledger_tail` 검증 + malformed ledger 필터)와 north-star delimiter(`--- END CTO NORTH STAR ---`)가 hook cap 이후에도 보존되도록 inner brief 를 wrap 전에 cap 처리.

### Changed

- **`revert(hud)` (PR #383)** Claude HUD 에서 Sonnet/Opus 주간 분리 표시(`Sn:`/`Op:` 배지)를 제거하고 통합 `5h:`/`1w:` 2-게이지 구조로 환원한다. v10.29.0(`792399eb`)이 도입한 모델별 분리는 독립 한도가 아니라 all-models nested 가드레일이라 혼란을 줘 운영 요청으로 되돌린다. Keychain configDir 스코프 토큰 읽기·주간 버킷 파싱·`User-Agent` 헤더·`[stale]` 배지 등 토큰-빔 버그 수정은 그대로 유지. packages 3-layer mirror 동반.

### Tests

- **`test(cto)`** `cto-collect-swarm`, `cto-status`, north-star route smoke, HUD ambient `.triflux/lake` 격리, session-start synapse, hook-orchestrator heartbeat 테스트 추가/보강.
- **`test(hud)`** Sonnet/Opus 분리 제거에 맞춰 `hud-claude-parse`/`credentials`/`backoff` 조정(통합 5h/1w 유지, Keychain/주간/UA/stale 케이스 보존).

## [10.29.0] - 2026-06-02

### Added

- **`feat(hud)` (commit `792399eb`)** Claude 신규 주간 사용량 버킷(Sonnet/Opus) 보조 표시. `/api/oauth/usage` 응답의 `seven_day_sonnet`/`seven_day_opus` 를 조건부 파싱(null 버킷 키 생략)하고, 독립 한도가 아닌 all-models nested 가드레일이므로 값>0 일 때만 `Sn:`/`Op:` 보조 셀로 노출(3-bucket 동등 나열 아님). compact/full tier 에 노출, nano/micro 는 폭상 생략.
- **`feat(hub)` (commit `e4a5684f`)** Synapse Registry 기반 interactive session peer-discovery.

### Fixed

- **`fix(hud)` (commit `792399eb`)** Claude 토큰 게이지가 비던 근본 원인 해결. Keychain service-name 을 `CLAUDE_CONFIG_DIR` 의 sha256(raw 값) 으로 분리(`Claude Code-credentials-<hash8>`)하고 account=username 우선 + 미만료 우선으로 선택해, 격리 세션(`~/.claude/.omc-launch`)에서 만료된 default 항목을 골라 401 로 빈칸이 되던 문제를 잡는다. 추가로 429/에러 시 `readClaudeUsageSnapshot` 의 `isStale` 플래그를 렌더까지 전파하고 compact/full tier 에 `[stale]` 배지를 노출하며, `/api/oauth/usage` 및 token refresh 요청에 `User-Agent` 헤더를 추가(헤더 누락 시 aggressive 429 무한 버킷 회피). packages/{core,triflux} 3-layer mirror 동반.
- **`fix(hub)` (commits `05a38e3c`, `2eb48208`, `bf9e4c0d`, `991be2fa`)** session peer-discovery 보강: re-register 시 stale/expired row revive(resume 세션 재노출), `getActive()` 가 idle interactive 세션도 포함(git-preflight 가 live peer 인식), SessionStart Synapse register 를 종료 전 flush + raw 세션 라우트 loopback-gate, Codex 리뷰 결함 수정.
- **`fix(packages)` (commits `dded022d`, `3c1dc50a`, `9098c0d6`)** packages/core/hud 및 claude daemon helper mirror drift 동기화 + `check-mirror` 가드 강화.

### Changed

- **`refactor(jsonrpc)` (commit `5bf4c9a9`)** 공유 `JsonRpcDispatchBase` 추출.

### Tests

- HUD: `parseClaudeUsageResponse` 신규 Sonnet/Opus 버킷(null 생략 포함), Keychain configDir/account 선택, `isStale` 배지 케이스 추가.
- packages-sync: UDS + jsonrpc-core 파일 mirror drift 가드.

## [10.28.1] - 2026-06-01

### Fixed

- **`fix(test-lock)` (commit `e1dcf591`)** release 테스트가 `npm test`/`release:prepare` 실행 중 부모 `scripts/test-lock.mjs` 래퍼가 점유한 repo 루트 `.test-lock/pid.lock`(동시 실행 싱글톤 락)을 삭제하던 비-hermetic 회귀를 막는다. 두 벡터: (1) `release-prepare-testlock.test.mjs` 가 실제 락을 직접 쓰고 지웠고, (2) 지배적으로 `prepareRelease()` 의 preflight `cleanupStaleTestLock()` 이 모듈 상수 `STALE_LOCK` 을 지워, temp `rootDir` 를 넘긴 `release-governance`/`completes-all-steps` 테스트들이 매 호출(런당 5회+)마다 살아있는 락을 삭제 → 동시 실행 가드 무력화(락이 막으려던 ConPTY/RAM 폭발 재노출). fix: `cleanupStaleTestLock(lockPath = STALE_LOCK)` DI 추가 + `prepareRelease()` 가 `join(rootDir, ".test-lock", "pid.lock")` 로 락 경로를 유도한다(프로덕션 동작 불변). 결정적 재현으로 가드 무력화/복구를 확인했다. packages/triflux 미러 byte-identical.

### Tests

- **`test(test-lock)`** `release-prepare-testlock.test.mjs` 를 `mkdtemp` 락으로 hermetic 화하고 실제 repo 락 무접촉을 단언한다. `release-prepare-completes-all-steps.test.mjs` 에 `prepareRelease({ rootDir: tmp })` 가 rootDir 의 락만 지우고 실제 repo 락은 건드리지 않는지 검증하는 회귀 가드를 추가한다.

## [10.28.0] - 2026-05-29

### Added

- **`feat(native-bridge)` (PR #369, commit `ef81c135`)** interactive native worker 를 `claude agents` 패널에 노출한다 — daemon exec dispatch(Option A)로 전환해 daemon 이 pty 를 소유하고 visible row 를 만든다. 신규 `hub/team/daemon-pty-tmux-bridge.mjs` 가 daemon-owned pty(자기 stdin/stdout)를 tmux transport 에 역방향 배선한다(stdin→`send-keys`, `pipe-pane`→stdout, SIGWINCH→`resize-window`). `launchAdoptedInteractiveWorker` 는 roster-only 채택 경로를 폐기하고 공유 `dispatchClaudeDaemonJob`/`teardownClaudeDaemonJob` 헬퍼로 dispatch/teardown 한다.

### Changed

- **`refactor(mcp-gateway)` (PR #362, commit `a6042e22`/`4a2700cd`)** 로컬 MCP gateway 를 SSE 싱글톤에서 stateful Streamable HTTP `/mcp` 로 이관한다 — daemon/registry SSOT 를 보존하면서 SSE reconnect crash 를 제거하고, `codex-mcp-gateway-sync --enable` 이 stale `/sse` URL 을 `/mcp` 로 강제 마이그레이션한다. health-check mirror 도 완성한다.
- **`chore(routing)` (PR #363, commit `02268ebf`)** Opus 4.8 와 ultracode 를 routing / escalation chain / HUD 전반에 반영한다 — escalation 2단계 head 를 opus-4-8 로 bump 하고 ultracode depth-modifier 와 1M context HUD 를 정합한다.
- **`refactor(daemon)` (PR #364, commit `629c4c01`/`893ea199`)** 공유 Claude daemon dispatch 헬퍼(`dispatchClaudeDaemonJob`/`teardownClaudeDaemonJob`)를 `hub/team/claude-daemon-control.mjs` 로 추출하고 path/proc owner 를 단일화한다 — 루트 dispatch 2곳(headless / native-bridge swarm)을 onto 해 4번째 dispatch 구현을 막는다. UDS orchestration(PR #366)도 이 공유 control 을 채택한다.

### Fixed

- **`fix(session-stale-cleanup)` (PR #365, commit `67822227`)** POSIX treeKill 이 bare pid 가 아니라 process group 을 reap 하도록 고친다 — orphan 백엔드 프로세스 잔존을 막는다.
- **`fix(native-bridge)` (PR #369, commit `ddfd4bc6`)** interactive dispatch 가 pid 할당 후 실패(bridge-session resolve / projection write)할 때 daemon job 을 teardown 해 pty/tmux 누수를 막는다.
- **`fix(uds-orchestration)` (PR #366, commit `0bb5b116`/`d585b500`)** createClaudeUdsEndpoint 가 공유 dispatch/teardown 을 사용하도록 포팅한다 (P2: dispatch ok-fail throw, transcript marker noise 필터) 그리고 `buildClaudePromptDispatchPayload` 를 root/core/triflux/remote 미러에 정합한다.
- **`fix(packages)` (PR #364, commit `d06def5c`)** `@triflux/core` daemon-control 미러에 누락된 `claude-session-projection` 을 추가한다 — 발행된 `@triflux/core` 소비자의 `ERR_MODULE_NOT_FOUND` 를 막고 mirror checker 에 등록한다.

### Chore

- **`chore(native-bridge)` (PR #368, commit `9953bb33`)** UDS local-dev smoke harness + 단위테스트(hermetic, 6 tests)와 2026-05-28 stale audit 문서를 추적하고, 휘발성 `*-latest-report.json` 을 gitignore 한다.

## [10.27.0] - 2026-05-28

### Added

- **`feat(cli)`** `tfx auto` 서브커맨드 추가 — tfx-auto 라우팅 결정을 실행 없이 미리보기/직렬화한다 (`--cli codex|antigravity|claude`, `--mode`, `--parallel`, `--json`). 실행 skill front door 와 동일한 flag surface 를 CLI 에 노출한다.

### Fixed

- **`fix(cli)`** `tfx update --help` 가 도움말 대신 실제 update 를 실행하던 side-effect 를 차단한다 — `cmdUpdate(args)` 가 help 인자 감지 시 install 탐지/실행 전에 early return 한다.
- **`fix(swarm)` (PR #360, commit `d1ef1b29`)** redundant worker 의 invalid/failed 완료를 redundant preemption 전에 검증한다 — failed redundant worker 가 healthy primary 를 preempt 하던 correctness 결함을 막는다. invalid payload 시 hypervisor 가 해당 redundant 등록을 삭제하고 native-bridge 등록을 failed 로 닫은 뒤 shard 완료·`redundant_wins`·`primary.shutdown("redundant_completed_first")` 전에 return 한다. primary lock 은 해제하지 않는다 (primary 소유).
- **`fix(native-bridge)` (PR #359, commit `772bcbcd`)** facade socket 의 unhandled peer-disconnect(EPIPE) 에러를 guard 한다.

### Changed

- **`chore(docs)`** README / README.ko / package README 를 전면 stale 정리한다 — Mermaid 렌더 오류 수정, skill count 갱신(34), Codex/Gemini/Claude → Codex/Antigravity/Claude 표기 통일, 한국어 폴리싱. demo/architecture/social/consensus/deep asset 을 재생성한다.
- **`chore(cli)`** tfx CLI help/schema/completion 의 stale·정합성 문제를 수정한다 — schema 에 auto/update/tray/codex-team/notion-read/review/monitor 추가, completions 에서 미존재 top-level(codex/gemini) 제거, `--cli gemini` 를 deprecated alias → antigravity 로 정규화, Codex profile TUI/setup 을 gpt55_* 기준으로 정리한다.
- **`chore(pkg)`** npm 패키지 self-containment 를 보강한다 — docs/assets + tui + README.ko.md 를 packages/triflux 에 포함하고, mirror check 가 tui 누락도 감지하도록 확장한다.

### Tests

- **`test(cli)`** tfx auto 미리보기, `tfx update --help` no-side-effect, schema 신규 커맨드, `--cli gemini`→antigravity 정규화에 대한 회귀 테스트를 추가한다.
- **`test(native-bridge)` (PR #359, commit `da3ff864`)** interactive-attach kind-0 round-trip 의 opt-in real-tmux E2E 를 추가한다 (`TFX_NATIVE_BRIDGE_E2E=1` 일 때만 실행, 기본 npm test 는 skip).

### Docs

- **`docs(native-bridge)` (PR #361, commit `01dc4679`)** native-bridge daemon-adoption gap PRD 를 기록한다 — 남은 gap 은 socket-location-only 변경이 아니라 daemon dispatch/adoption 임을 확정한다.

## [10.26.0] - 2026-05-28

### Added

- **`feat(native-bridge)` (PR #355, PR #358, commits `405e2373`, `865a95c0`, `903842e9`)** Claude Agents 패널에서 Codex interactive worker 를 attach 하는 native-bridge **interactive-attach** 모드. `headless.mjs` 에 `interactive-attach` nativeBridgeMode 분기 + swarm `registerSwarmShard` interactive 옵션(shard worktree cwd)을 추가하고, facade ptySock kind-0 inbound 을 interactive worker 일 때만 tmux transport `writeInput` 으로 라우팅한다(headless worker 는 기존 echo 유지). 신규 socket/protocol 없이 기존 ptySock + `daemon-interrupt` verb 재사용 (PRD §11 B2).
- **`feat(live)` (commits `092fcc2b`, `97ac98c7`)** live Claude↔Codex daemon relay 를 Triflux 본체로 promote 한다. tmux-only coupling 없이 daemon relay 가 동작한다.
- **`feat(retry)` (PR #356, PR #358, commits `4869f83a`, `696836a7`, `9124276c`)** escalation-chain profile 을 end-to-end 로 작동시킨다. 2-stage 체인(codex→claude) + profile 필드를 bridge `cliInvocation.argv` 로 노출하고, `scripts/tfx-route.sh` 가 retry-snapshot 입력으로 `--profile` 를 codex 호출에 plumbing 한다(snapshot 없으면 no-op).
- **`feat(skills)` (PR #356, commit `5ee02498`)** skill-authoring SSOT + `lint-skills` guard 를 추가하고 `.tmpl` 생성 파이프라인을 deprecate 한다. `SKILL.md` 가 단일 정본.

### Changed

- **`perf(native-bridge)` (PR #358, commit `795ba1dc`)** interactive-tui-transport 출력 회수를 capture-pane 전체화면 폴링(깜빡임)에서 tmux `pipe-pane` 증분 byte stream 으로 전환한다. 공개 인터페이스(`{start,writeInput,resize,stop}` + `onData`) 보존, pipe-pane 미지원 환경 capture-pane fallback 유지.
- **`chore(skills)` (PR #358, commit `998564cf`)** deprecated `.tmpl` 파이프라인을 물리 제거한다 — 30개 `skills/**/SKILL.md.tmpl` + `gen-skill-docs.mjs`/`convert-to-tmpl.mjs` + dead test. 실제 `SKILL.md` 는 무변경(SSOT 보존).
- **`refactor(codex)` (commits `2eb8dbc1`, `bfe27d29`, `ff658b70`, `1ec70a26`)** Codex 0.134 separate-file profile 포맷으로 마이그레이션한다 (inline `[profiles.NAME]` → `~/.codex/NAME.config.toml`). setup/tui/doctor/preview 전체 정렬 + custom profile 포함.
- **`refactor(headless)` (PR #356, commit `c3946b61`)** UI displayName 을 agent role 필드에서 분리한다(worker-N role 오염 제거).

### Fixed

- **`fix(swarm-preflight)` (PR #356, commits `b01b8fe9`, `a88847e2`)** `AGENT_COMMANDS` 가 antigravity/agy agent 를 agy 바이너리로 매핑하도록 정렬한다 — `agent:antigravity` preflight 거짓 차단을 해소한다.
- **`fix(test-lock)` (PR #356, commit `d4388292`)** `--test-force-exit` 실패 시 non-zero exit code 를 전파해 release/CI 게이트 신뢰성을 확보한다.
- **`fix(swarm)` (PR #356, commit `e39723bb`)** worker acceptance lint 을 changed/lease 파일로 한정한다 — pre-existing drift 의 lease escape 를 차단한다.
- **`fix(native)` (PR #356, commits `2b3cd027`, `f1a35823`)** slim-wrapper 와 route agent 를 agent-map allowlist 로 검증한다.
- **`fix(retry)` (PR #356, commit `0519255c`)** escalation override `JSON.parse` 를 problem+cause+fix 에러로 guard 한다.
- **`fix(live)` (commits `50233b94`, `de414538`, `621b82c3`, `62fd681d`, `b68b1b2b`)** daemon attach fidelity 를 terminal repaint/soft-wrap 너머로 보존하고 live relay capture 를 완전하고 interruptible 하게 안정화한다.

### Docs

- **`docs(report)` (PR #358, commit `e34dca71`)** main lint 출처 진단 문서(`.triflux/reports/main-lint-source.md`)를 추가한다 — drift isolation 용.

## [10.25.1] - 2026-05-21

### Added

- **`feat(doctor)` (PR #313, commit `14e6fc2d`)** `tfx doctor` 에 "MCP Gateway Health" 진단 섹션 추가. `~/.local/state/triflux/mcp-gateway.out.log` 의 skipped/missing-env 패턴을 false-positive 없이 해석하고, `secrets.env` 및 service restart 힌트를 노출한다.
- **`feat(doctor)` (PR #317, commit `2941b177`)** MCP gateway wrapper 가 `secrets.env` 를 실제 source 하는지 정적 검증한다. PR #313 의 runtime log-parser 만으로는 잡히지 않는 startup wrapper 설정 gap 을 release 전 진단 가능하게 했다.
- **`feat(native-bridge)` (commit `6f741364`)** Triflux headless/swarm shards 를 Claude native bridge row 로 노출해 stale agent rows 없이 worker 상태를 사용자-facing surface 에 표시한다.
- **`ci(release)` (PR #330, commit `ad75ade3`)** release workflow 에 `release:check-mirror` 와 `release:check-sync` fast-fail gate 를 추가해 mirror/version drift 를 pack/publish 전 차단한다.

### Fixed

- **`fix(mcp)` (PR #312, commit `98507f47`)** MCP gateway startup wrapper/systemd `EnvironmentFile` 후보에 표준 `~/.config/triflux/secrets.env` 를 포함해 BRAVE_API_KEY 등 secret 누락으로 MCP server 가 skip 되는 회귀를 수정한다.
- **`fix(swarm)` (PR #320, commit `a105942f`)** sub-worktree 에서 Codex worker 가 boot 되지 않는 회귀를 수정한다. main checkout 전제에 묶인 경로/환경 계산을 정렬해 Issue #315 재발을 막는다.
- **`fix(macos)` (PR #319, commit `154e60db`)** Windows Terminal 전용 규칙이 macOS 문서/doctor surface 로 새어 나오는 drift 를 제거하고 platform guard 설명을 맞춘다.
- **`fix(release)` (PR #322, commit `e642e1de`)** `release:check-packages-mirror` auto-compare 범위에 hooks/skills 를 포함한다.
- **`fix(release)` (PR #325, commit `f8348d51`)** mirror gate 범위에 HUD/config surface 를 포함한다.
- **`fix(release)` (PR #327, commit `8555b5c1`)** tfx-ship, verify, npm-publish, packages/triflux dependency sync 가 같은 package mirror 범위를 보도록 release packaging/check path 를 정렬한다.
- **`fix(release)` (PR #328, commit `7bddd936`)** npm publish files 목록에 config surface 를 포함해 설치 package 에 필요한 config 파일이 누락되는 배포 회귀를 막는다.
- **`fix(team)` (commit `a3815e84`)** macOS team dispatch 가 psmux-only capability check 때문에 tmux 환경을 놓치지 않도록 tmux route 를 유지한다.
- **`fix(route)` (PR #332, commit `35fb8f3e`)** deprecated Gemini route 를 Antigravity-ready 환경에서는 `agy --print` path 로 redirect 하되, Antigravity 미준비 환경의 legacy Gemini fallback 은 보존한다. native-bridge default-on 및 release mirror/sync gate 를 최신 main 기준으로 다시 포함해 stale-branch 회귀를 막았다.
- **`fix(route)` (PR #336, commit `25602e94`)** macOS route smoke fixture 의 intentionally tiny `config.toml` 이 production small-config corruption guard 에 막히지 않도록 test-only opt-in 을 추가하고, stale inherited `_TFX_MCP_DEGRADED` 를 current invocation preflight 전에 정리한다.
- **`fix(swarm)` (PR #335, commit `804b1451`)** native bridge / swarm display row 를 run identity 기준으로 group 하도록 정리한다.

### Changed

- **`chore(packages)` (PR #314, commit `7671123f`)** `packages/core` 와 `packages/remote` 를 v10.25.0 baseline 및 Phase 1 mirror staging 상태로 catch-up 한다.
- **`chore(deps)` (PR #324, commit `ded33c8c`)** `better-sqlite3` remote dependency 를 Node 26 환경에 맞춰 정렬한다.
- **`chore/lint` (PR #331, commit `7dfdb8a3`)** Biome cleanup 으로 `bin/` 과 `scripts/` 의 stale lint drift 를 제거한다.
- **`chore(psmux)` (commit `4b858658`)** psmux mirrored rule block 의 sync-hash integrity 를 보존한다.
- **`test(agy)` (PR #334, commit `2d032c90`)** real Antigravity OAuth smoke 를 opt-in gate 로 묶어 기본 CI/release path 에서 credential-cost 회귀를 만들지 않도록 정리한다.

### Docs

- **`docs(mirror-policy)` (PR #316, commit `fda2c8de`)** mirror policy table 에 `packages/remote/scripts/lib` 범위를 추가한다.
- **`docs/plans` (PR #318, commit `563752c5`)** macOS WT-rule leakage 증상과 수정 계획을 plans 문서로 수집한다.
- **`docs/tfx-setup` (PR #321, commit `dee38b4b`)** macOS-aware setup guidance 를 추가한다.
- **`docs(native-bridge)` (PR #333, commit `a6a40948`)** headless native bridge UI default-on policy 와 `--no-native-bridge-ui` opt-out routing 을 문서화한다.
- **`docs(mirror-policy)` (PR #326, commit `f06f56eb`)** packages mirror mesh 와 `packages/core/hub/team` minimal mirror policy 를 문서화한다.
- **`docs(prompt-hygiene)` (commit `bb3662dd`)** Gemini-to-Antigravity migration wording 을 적용한다.

### Notes

- `v10.25.1` 은 `v10.25.0` 이후 macOS WT/psmux leakage, native bridge visibility, Antigravity migration, release mirror/package gates, and route-smoke release blockers 를 함께 정리하는 patch release 이다.
- Triflux headless workers now appear in Claude agents by default. Opt-out: `--no-native-bridge-ui`.

## [10.25.0] - 2026-05-21

### Added

- **`feat(native-bridge)` (PR #311, commit `2a6d592c`)** Claude agents 목록에서 Triflux native bridge workers 를 사용자에게 직접 노출하는 UI 통합. 40 files, +5834/-182 의 user-facing native bridge surface 확장.
- **`feat(mcp)` (commit `19d7daec`)** MCP gateway startup auto-install script 추가로 gateway startup 경로의 초기 설치/복구 흐름을 자동화.
- **`feat(routing)` (PR #305, commit `a5c02313`)** `tfx-route` Node single entry Phase 0 PoC + Phase 1 cross-cutting migration 통합.
- **`feat(mcp)` (PR #304, commit `a30503fc`)** portable gateway + `sync --all-projects` 지원 추가.
- **`feat(mcp)` (PR #303, commit `72717ccf`)** MCP registry policy 가 client sync 를 주도하도록 registry/client 동기화 경로 정렬.
- **`feat(mcp)` (PR #294, commit `769238ad`)** exa/brave/tavily MCP integration 과 Antigravity client target 통합.
- **`feat(routing)` (commit `09169b6d`)** Antigravity lane Tier 1 dual-lane 운영 기반 추가.
- **`ci(workflow)` (PR #293, commit `f63d75fb`)** npm trusted publishing OIDC workflow 추가.

### Fixed

- **`fix(startup)` (commit `0665d189`)** systemd + macOS startup path rendering 을 shell-injection safe 하게 강화.
- **`fix(security)` (commit `d1cc8bbb`)** secret config chmod window race 를 닫아 permission hardening.
- **`fix(ci)` (commit `424d18e3`)** Antigravity CI 를 prompt-file contract 에 고정해 inline prompt drift 방지.
- **`fix(routing)` (PR #296, commit `b97773a7`)** Antigravity stdin pipe + tri-lane fallback 회귀 수정.
- **`fix(ci)` (commit `4019e3d9`)** Node 24 CI 경로에서 npm self-upgrade fail path 제거.

### Changed

- **`chore(registry)` (commit `642a13eb`)** registry driven gateway client sync 로 registry/client 동기화 책임을 정리.

### Security

- **`security(mcp)` (PR #295, commit `b41ca335`)** plaintext Gemini header sync 경로 hardening.

### Tests

- **`test(integration)` (PR #297, commit `c4600522`)** Antigravity `agy --print` 5종 prompt-passing regression coverage 추가.

### Docs

- **`docs(rules)` (commit `517a99eb`)** Antigravity CLI migration policy memo 추가.
- **`docs` (PR #301, commit `e2856c60`)** Tier 2 follow-up rule corrections, Antigravity subagents PRD, Node CLI PRD 정리.

### Notes

- PR #311 native bridge UI 가 이번 release 의 주요 user-facing 변경이다.
- 3-way consensus review (codex + agy + gemini -> Claude) 에서 확인된 P1 1건 + P2 4건 fix 를 모두 포함한다.
- Commit/tag 메시지에는 AI attribution trailer 를 포함하지 않는다.

## [10.24.0] - 2026-05-19

### Added

- **`feat(routing)` (PR #289, Issue #281 closed, commit `b295c32f`)** `tfx-auto` 자동 swarm dispatch — staged + unstaged + untracked 변경 파일 자동 감지 후 2+ 태스크 + 코드 변경 ≥ 1건 시 swarm escalate. 사용자 명시 `--parallel N` override 시 warning + 사용자 결정 존중. 신규 helper `hub/lib/staged-file-detect.mjs` (`detectChangedFiles()` + `hasCodeChange()` export, CRLF 대응, non-git cwd graceful). 신규 router 함수 `hub/lib/tfx-route-args.mjs::decideDispatchMode()` (4 분기 + injectable detector + countTasks/normalizeParallel helpers). `bin/triflux.mjs` 의 tfx-auto entry 에 `applyAutoDispatchDecision()` 추가 — warning stderr + escalation `.omc/state/auto-escalation.log` JSON append (graceful skip). 4-layer mirror byte-identical (root + packages/{core,triflux}, packages/remote 무영향). 회귀 가드 3 case (`tests/integration/tfx-auto-routing.test.mjs`) + 단위 6 case (`tests/unit/staged-file-detect.test.mjs`) + 5 case (`tests/unit/tfx-route-args.test.mjs`). Closes #87 + #281.

### Docs

- **`docs(plans)` (PR #286, commit `4069d656`)** Issue #281 auto router swarm dispatch PRD bundle — index + 3 shard PRD (A staged-file-detect helper / B router escalate / C integration test + SSOT docs + 4-layer mirror).
- **`docs(plans)` (PR #287, commit `8c63fa5e`)** Issue #281 swarm CLI 전용 PRD (`## Shard:` format) — swarm-planner parser 호환 single-file. parseShards 3 shards 인식 검증.
- **`fix(plans)` (PR #288, commit `9c6bf060`)** Issue #281 swarm PRD 인프라 회피 — `mcp: implement` 제거 (codex `mcp_servers.implement` 미정의 → `invalid transport` exit 1) + `critical: false` (redundancy gemini auto-spawn 회피).

### Changed

- **SSOT** `.claude/rules/tfx-execution-skill-map.md` L44 안티패턴 / L48-49 핵심 룰 / L57-59 알려진 한계 (→ "해결됨") 3개 라인 갱신 — `tfx-auto` 자동 swarm escalate 정식화 톤 적용. `.claude/rules/tfx-routing.md` "충돌 해소" 섹션에 `tfx-auto 자동 swarm escalate` 1줄 추가.

### Notes

- Issue #281 본체 작업 자체가 `/tfx-auto --parallel swarm --isolation worktree --cli codex` 로 dogfooding — Codex worker 3 shards (A → B → C 의존) 가 cherry-pick 통합 후 단일 PR #289 로 머지. swarm CLI 인프라 갭 4건 (mcp manifest abstraction / redundancy default / CODEX_HOME auto-preserve / codex_apps MCP init) 은 별도 [Issue #290](https://github.com/tellang/triflux/issues/290) 으로 추적.
- 본 release 는 feat + 신규 public API (`detectChangedFiles`, `hasCodeChange`, `decideDispatchMode` export) 추가 = semver minor.

## [10.23.0] - 2026-05-19

### Added

- **`feat(doctor)` (PR #284, commit `340160f3`, S4 follow-up)** macOS process lifecycle audit S4 통합: P4b SessionEnd hook output schema 를 Claude Code universal hook spec 에 정렬해 "Invalid input" warning 0 (`hooks/session-end-cleanup.mjs::buildOutput()` 갱신). P4 detached tmux 보고서 확장 (`age`, `cwd`, `command`, `memory_estimate_mb` 필드). `bin/triflux.mjs doctor` 에 detached tmux sessions 섹션 추가 + 신규 CLI `tfx doctor --cleanup-stale-tmux --prefix tfx-* [--age-min N] [--dry-run|--apply]`. packages/triflux + packages/core mirror. 회귀 테스트: `tests/unit/session-end-cleanup.test.mjs` 확장 (schema + 새 필드) + `tests/unit/doctor-cleanup-stale-hubs.test.mjs` 신규 (active healthy hub 보존 케이스 + stale-only 정리 케이스 분리).

### Fixed

- **`fix(doctor)` (PR #284, commit `340160f3`, S4 cleanup-stale-hubs 회귀)** `tfx doctor --cleanup-stale-hubs --apply` 가 ESTABLISHED ≥ 1 active healthy hub (실측: PID 84365) 도 정리하던 회귀 — PR #274 PRD §"cleanup excludes active healthy hub" 위반. fix: active connection 가진 hub 는 정리 후보에서 제외 (`bin/triflux.mjs::cleanupStaleHubs` active hub 판정 로직 강화), `--dry-run` 출력에 healthy/stale 구분 명시. 회귀 테스트로 영구 가드.
- **`fix(hooks)` (PR #280, commit `e734c76c`, hub-token guard)** PostToolUse compact nudge + pipeline-stop context guard 가 `~/.claude/cache/tfx-hub/context-monitor.json` 의 hub token monitor snapshot (long-lived MCP tools/list traffic 누적으로 200K limit 에서 100% 채워짐) 을 Claude session context 로 오인해 compact nudge 강제. fix: `isHubTokenMonitorSnapshot()` 가드 추가 (requestTokens/responseTokens/totalUpdates/byTool 시그니처 매칭). `hooks/hook-orchestrator.mjs` + `hooks/pipeline-stop.mjs` 양쪽 가드 적용 + 4-layer mirror. 회귀 테스트 추가 (hub-token shape -> context guard 트리거 안 함 / 일반 cache shape -> 정상 트리거).
- **`fix(terminal-opener)` (PR #285, commit `e65b0c5e`, Issue #277+#278+#279)** macos-lifecycle ultrareview verified follow-up 3건 통합. #277: `hub/team/session.mjs` 의 nested `process.platform === "win32" &&` redundant guard 제거 (Windows-only branch 안 평가 의미 없음). #278: `hub/team/terminal-opener.mjs::defaultPsmuxBinaryExists` 가 stderr-only 응답 누락 케이스 -> `getCommandVersion` 패턴 (spawnSync + stdout+stderr concat) 통일. #279: Windows openSession 분기에 symmetric `psmuxBinaryExists` 가드 추가 (POSIX 분기와 같은 검증). 4-layer mirror (root + packages/{core,triflux,remote}; remote 는 Edit only `@triflux/core` import 보존). 회귀 테스트 3 case.

### Docs

- **`docs(routing)` (PR #282, commit `179323aa`, D1 + D2)** 라우팅 SSOT audit (tfx-harness) drift fix 2건 통합. D1: `.claude/rules/tfx-execution-skill-map.md` + `CLAUDE.md` 의 정식 표기 `tfx-remote-spawn` -> `tfx-remote` 통일 + `tfx-codex-swarm` 스타일 미러로 `tfx-remote-spawn DEPRECATED` 마커 추가. D2: 안티패턴 섹션에 `--parallel swarm --isolation worktree` 명시 강제 라인 + 핵심 룰 MANDATORY 라인 (Issue #87 미해결 갭 가이드).
- **`docs(routing)` (PR #283, commit `9a9065dd`, D3)** `.claude/rules/tfx-routing.md` 의 "## 충돌 해소" 섹션에 `ralph` 의미 통일 1줄 추가 — `--retry ralph` mode 만 지칭, persist 스킬 동일, `--retry auto-escalate` 와 동시 사용 불가 (escalation-chain.md 규약).

### Notes

- macos-lifecycle S4 follow-up 의 P4 tmux cleanup + P4b SessionEnd hook schema 가 본 release 에 포함 (이전 v10.22.0 에서 미포함이었던 잔여 작업). 4 shards (S4 + Issue #277/#278/#279 + cleanup-stale-hubs 회귀) 가 tfx-swarm 격리 worktree 병렬 실행으로 2 PRs (#284 + #285) 통합 발행됨.
- 라우팅 audit (tfx-harness) D2 장기 follow-up 은 별도 Issue [#281](https://github.com/tellang/triflux/issues/281) 등록 (label `routing,tier:high`) — `tfx-auto` 가 staged code change 자동 감지 후 swarm dispatch 로 escalate 하는 라우터 강화 작업. 회귀 테스트 3 case body 명시.
- packages mirror 정합: `hub/`, `scripts/`, `hooks/`, `bin/` -> `packages/triflux/` byte-identical, `hub/lib/` + `scripts/lib/` -> `packages/core/` byte-identical, `packages/remote/hub/team/*` -> `@triflux/core/*` import 경로 보존. PR #284 / #285 각 PR diff 에서 4-layer 검증 통과.
- `tfx-harness` 라우팅 audit 정적 일관성 검증 (escalation chain 1~4단계 / dynamic routing fallback `codex-default` / `TRIFLUX_DYNAMIC_ROUTING` env gate 기본 false) 통과. 동적 라우팅 wire-up (PR #266~#270) 과 SSOT 정합 확인.


## [10.22.0] - 2026-05-19

### Fixed

- **`fix(macos)` (PR #275, commit `98f46851`, P1 mux identity)** `hub/team/session.mjs::detectMultiplexer()` 가 darwin tmux-only 환경에서 `"psmux"` 를 반환하던 문제 — `hasPsmux()` alias 의존 제거, `psmux.mjs::getMultiplexerType()` literal resolver 사용. `hub/team/terminal-opener.mjs::buildAttachCommand` 에 `PSMUX_BIN` env + 바이너리 존재 검증 추가. Windows primary 는 `"psmux"` 유지. packages/triflux + packages/remote mirror (`@triflux/core/*` import 보존). 회귀 테스트: `tests/unit/multiplexer-resolution.test.mjs` (4 assertions) + `tests/unit/terminal-opener.test.mjs` (2 assertions). ultrareview cloud multi-agent 검토 통과 (severity=critical 0).
- **`fix(test-lock)` (PR #276, commit `aeb1e64b`, P2 supervisor)** `scripts/test-lock.mjs` 가 concurrent start 만 막고 child lifetime owning 부재 — 결과: `node --test --test-force-exit` 가 parent 종료 후 orphan (PPID=1) 으로 살아남아 누적 GB-급 memory pressure 발생. fix: env `TEST_LOCK_TIMEOUT_MS` (default 10min) timeout, SIGINT/SIGTERM/SIGHUP child forward, parent shutdown 시 `child.kill('SIGTERM')` → 5s grace → SIGKILL, lock metadata 에 `parent_pid` + `child_pid` + `started_at` + `timeout_ms` 추가, stale lock + live child PID 시 actionable diagnostic + non-zero exit (lock 보존), stale lock + dead child PID 시 cleanup + 정상 진행. packages/triflux/scripts/test-lock.mjs mirror. 회귀 테스트: `tests/unit/test-lock.test.mjs` (5 assertions, 신규).
- **`fix(hub)` (PR #274, commit `6d92d536`, P3a stale retirement + P3b version drift)** `scripts/hub-ensure.mjs` 가 pid file 신뢰만 하고 live process / port / version 검증 부재 — 결과: 옛 version hub 가 `:27888` 점유 시 새 version 이 random port cascade, pid file 은 새 version 가리키지만 traffic 은 옛 version 으로 흐름 (실측: v10.21.0 새 hub PID 86156 → `:29196` cascade → 죽음, 옛 v10.20.2 PID 61463 `:27888` 살아남음). fix: startup 시 pid file PID alive 확인 (`process.kill(pid, 0)`) + cmdline 매칭 (`hub/server.mjs` 인지) + port 일치 + `/health` version 일치, 불일치 시 명시 warn + retire 시도 (SIGTERM → 5s grace → SIGKILL). `bin/triflux.mjs doctor` 에 stale hub diagnostic 추가 (PPID=1 hub/server.mjs 목록 + PID + version + uptime + port + ESTABLISHED count + RSS). opt-in cleanup CLI: `tfx doctor --cleanup-stale-hubs --dry-run|--apply` (active healthy hub 명시 제외). packages/triflux mirror. 회귀 테스트: `tests/integration/hub-singleton.test.mjs` 확장 (3 assertions) + `tests/unit/hub-ensure-version-drift.test.mjs` (3 assertions, 신규) + `tests/unit/doctor-stale-hubs.test.mjs` (2 assertions, 신규).

### Added

- **`docs(research)` (PR #273, commit `43d48294`)** macOS process lifecycle leak audit report (`docs/research/macos-process-lifecycle-leak-report-2026-05-18.md`) — 4 결함 분류: P1 mux identity (compatibility regression), P2 test-lock supervisor (lifecycle design bug), P3a hub stale retirement (lifecycle design bug), P4 tmux cleanup (policy gap). 작업 중 추가 발견: P3b version drift (port-collision cascade) + P4b SessionEnd hook JSON schema mismatch.

### Notes

- 보고서가 정의한 P4 (tmux cleanup policy + SessionEnd hook schema) shard 는 본 release 에 포함되지 않음 (swarm worker token 소진으로 commit 전 종료). follow-up shard 로 별도 진행 예정.
- ultrareview cloud multi-agent 검토는 PR #275 (가장 위험한 macOS edge case) 에만 1회 사용. severity=critical 0건. yellow finding 3건은 cosmetic / edge-case / pre-existing — Issues #277 (dead win32 guards) / #278 (defaultPsmuxBinaryExists stderr asymmetry) / #279 (Windows openSession lacks psmux binary check, pre-existing) 로 follow-up 등록.
- packages mirror 정합: `hub/`, `scripts/`, `hooks/` → `packages/triflux/` byte-identical (PR 별 diff 확인됨), `hub/team/*` → `packages/remote/` 에서 `@triflux/core/*` import 경로 보존.

## [10.21.0] - 2026-05-16

### Added

- **`feat(routing)` (PR #263, commit `da70034d`, D-1)** Phase 1 dynamic routing caller-friendly facade — `createDynamicRouter(opts)` factory + `routeRequest(request, opts)` top-level + opt-in env `TRIFLUX_DYNAMIC_ROUTING=1|true` gating. env 미설정 시 null-router (항상 fallback decision 반환). policy/snapshot/snapshotProvider/nowFn 주입 가능 (pure-fn 결정 테스트)
- **`feat(routing)` (PR #264, commit `d03182c3`, D-2)** routing-snapshot Phase 1 in-process cache — `getDefaultSnapshot({forceRefresh, maxAgeMs, now, builder})` shortcut, `DEFAULT_CACHE_TTL_MS = 900_000` (policy `freshness.max_snapshot_age_ms` 와 정합), `resetSnapshotCache()` 테스트 격리, `__internal__.getCacheStateForTest`/`setCacheForTest`
- **`feat(routing)` (PR #266, commit `e8506c55`, Wire-up 1)** `conductor.spawnSession` sync dynamic routing override. 설계 정합: PRD 의사 코드는 `await router.routeRequest(...)` 를 가정했지만 broker.lease atomic 인변량 (commit 761fb7a8 — "leased account = executing account") 보존 위해 sync path 만 사용. `hub/routing-snapshot.mjs` 에 `tryGetCachedSnapshot({maxAgeMs, now})` sync getter 신규 export (cache fresh 면 snapshot, 아니면 null — builder IO 없음). eventLog `dynamic_route_override`/`dynamic_route_error` 가시화. opt-in env 미설정/`config.remote`/`config.agent` 빈 값 시 skip
- **`feat(routing)` (PR #268, commit `b901556f`, Wire-up 2)** `swarm-hypervisor.launch` plan-time async dynamic routing. `launch()` 가 이미 async 라 D-1 facade 의 `await routeRequest` 그대로 사용 (sync invariant 충돌 없음). `team_size = plan.shards.length` 매핑은 PRD §6 S5 leaseMany 시나리오 정합. `decision.shards[i].cli !== plan.shards[i].agent` 일 때만 1:1 override. eventLog `dynamic_route_plan_decision`/`dynamic_route_plan_overrides`/`dynamic_route_plan_error`. `accountId` 은 기록만 (broker.lease 시그니처 미수용 — Phase 4 leaseMany 와 함께 확장)
- **`feat(routing)` (PR #269, commit `5f6d7528`, Wire-up 3)** `scripts/tfx-route.sh` sh-path dynamic routing. `scripts/lib/dynamic-route-cli.mjs` helper 신규 — 기본 출력 `shards[0].cli` 한 단어 (sh `$(...)` 친화), `--json` / `--field <name>` / silent no-op (env 미설정 시) / fail-closed (error 시 stderr + exit 0) contract. `apply_dynamic_routing_override()` 함수 + main flow 호출 (`apply_verifier_override` 다음). `set -u` safe default value 패턴. 지원하는 cli (codex/gemini/claude) 만 적용
- **`feat(doctor)` (PR #270, commit `c2ae219a`, Wire-up 4)** `tfx doctor --dynamic-routing` 진단 옵션. `scripts/doctor-dynamic-routing.mjs` helper 신규. 텍스트 모드: enabled / policy loaded (scenario 수) / snapshot cache hit/miss + age / preview decision (scenario·mode·lane·shards[0].cli). `--json` 으로 구조화 출력 (decisionId·scenario·mode·lane·shards·snapshotAgeMs·confidence)

### Fixed

- **`fix(conductor)` (PR #259, commit `ca5cc880`, #116-C)** codex headless prompt 를 stdin transport 로 분리 — `hub/team/execution-mode.mjs` 의 `resolveStdinPromptMode(explicit, envSource)` helper 신규 (default ON, env `TFX_CODEX_STDIN_PROMPT=0` opt-out). `buildSpawnSpecForMode` 가 args 에서 prompt 빼고 `{stdinPrompt:true, prompt}` 로 분리. `conductor.respawnSession` 이 `spec.stdinPrompt && spec.prompt` 일 때 `child.stdin.write(prompt)` 후 `end()`. argv-inline 회귀 가드 강화 (`conductor-windows-quote-regression.test.mjs` — prompt 가 args 에 아예 없음 검증)
- **`fix(check-codex-config)` (PR #260, commit `f1f1e2fa`, #193)** `[hooks.state.*]` section whitelist — `splitTomlSections(raw)` / `classifySectionDiff(before, after) → {hooksStateOnly, changedSections}` / `describeChange` helper 신규. hooks.state-only mutation 은 informational warning + exit 0, 그 외는 기존대로 mutation 메시지 + exit 2
- **`fix(routing)` (PR #261, commit `c328b2a7`)** tfx-multi magic keyword 을 deprecated skill 대신 tfx-auto 로 redirect (`hooks/keyword-rules.json:27` skill 값 변경, `tfx-codex`/`tfx-gemini` 와 동일 패턴)
- **`fix(psmux-info)` (PR #262, commit `8456eaf0`)** mac/Linux 환경 OS-aware 설치 안내 — `PSMUX_INSTALL_COMMANDS_DARWIN` (brew + cargo) / `_LINUX` (cargo only) / `_FALLBACK_NOTE_DARWIN/LINUX` (tmux + native teams fallback) / `getPsmuxInstallCommandsFor` / `formatPsmuxInstallGuidance(platform)`. Windows 메시지 (winget/scoop/choco) 변경 없음

### Notes

- **`test(dynamic-routing)` (PR #265, commit `e5cf25d9`)** D-1 facade + D-2 cache end-to-end integration 가드 9 케이스 — env-off fallback, cache hit, S1~S6 시나리오, isDynamicRoutingEnabled env gating. D-1/D-2 export 부재 시 graceful skip
- Phase 1 wire-up 1/2/3/4 모두 opt-in (`TRIFLUX_DYNAMIC_ROUTING=1|true`). 기본 동작은 v10.20.2 와 동일 (codex-default fallback)
- broker.lease atomic 인변량 (`commit 761fb7a8` — "leased account = executing account") 은 본 release 에서 명문화되었고, 모든 wire-up 이 이 인변량을 보존하도록 설계됨. conductor wire-up 은 sync path, swarm/sh wire-up 은 plan-time path 로 분리 처리
- 후속: `accountId` hint 적용 (Phase 4 `leaseMany` 와 함께), wire-up 결과를 eventLog 체계로 통합 (sh path 는 현재 stderr 만)

## [10.20.2] - 2026-05-14

### Fixed

- **`fix(broker)` (commits `7c3faa3f` + `616bd335` + `b85768ef` + `3c7ae61b`, #206 stabilization)** AccountBroker HTTP 서피스의 정보 누출 차단:
  - `publicSnapshot()` helper 신규 — 외부 노출용으로 redacted state 만 반환 (env, authFile, profile, host, raw failure timestamp 비공개)
  - `/broker/snapshot` 과 HUD 가 `publicSnapshot()` 만 사용하도록 제한
  - `securityViolation` / `authSyncError` diagnostic 이벤트는 hub 에서 redacted warn 로그 (`broker.security_violation`, `broker.auth_sync_error`) 로 처리, raw credential 절대 비기록
  - **no-lease 동작 contract 명문화** — broker 비활성/empty 시 default CLI auth path, enabled but no lease 면 `circuit_open` 반환. Conductor 는 `broker_no_lease` 이벤트 기록 후 spawn 진행 (accountId 없으므로 release 미호출)
- **`fix(broker)` (commit `761fb7a8`, #206 1차)** AccountBroker auth lease stabilization — `reloadBroker()` 에서 activeLeases() 보존, Codex auth sync 의 shared source lock, atomic 쓰기 (`temp + rename + 0600`), source/cache account_id 검증, auth-mode lease fail-closed (isolated runtime `tfx-hub/codex-home/<account>/auth.json`)
- **`fix(broker)` (commit `5853d628`, #206 후속)** refreshed runtime auth propagation 보강
- **`fix(worker)` (commit `f32c3ad4`, Closes #189)** local worker HOME/APPDATA sandbox — `hub/team/worker-sandbox.mjs` helper 신규, conductor/delegator/native supervisor 의 local worker spawn 이 mutable CLI user-state 를 `.triflux/worker-home` 아래로 격리. explicit `CODEX_HOME` 보존, `TFX_WORKER_SANDBOX=0` debug opt-out
- **`fix(swarm)` (commit `64283a0a`, Closes #188)** `tfx swarm preflight <prd>` GO/NO-GO gate — non-dry-run 직전 PRD 유효성, lease 충돌, missing hosts, local CLI 부재, MCP 호환성 검사. dry-run/plan 는 preview-only 유지
- **`fix(swarm)` (commit `9641e3dc`, Closes #191)** swarm integration 경로 명시 — `merge --ff-only` 우선 후 divergent 일 때 cherry-pick fallback (shard branch ref 보존). 실패한 shard 는 recovery patch path 와 함께 row 출력
- **`fix(hooks)` (commit `bb97aeb2`, #245 selective adoption)** hook lifecycle 적응 1차 — `PermissionRequest:Bash` allow-only (read-only git/list/search + explicit `node scripts/test-lock.mjs`), `SubagentStart`/`SubagentStop` paired tracking (lock dir + JSON state), `SessionEnd` report-only (`TFX_SESSION_END_CLEANUP=1` 으로 실제 pruning enable)
- **`fix(hooks)` (commit `0d62f930`, #245 후속)** `hooks/post-tool-tips.mjs` — opt-in (`TFX_POST_TOOL_TIPS=1`) PostToolUse rules injector. high-impact path (hook lifecycle, package hook mirrors, team runtime, MCP surface, instruction sources) 만 reminder 출력, realpath dedupe + 1200-char cap
- **`fix(hooks)` (commit `e9bba8d4`, #245 후속)** Stop context guard retry cap — 기존 `tfx-pipeline-stop` Stop hook 확장. context 사용량 높을 때 reminder 최대 2회/세션. context-limit 과 user abort/cancel/interrupt 시 항상 pass-through. critical usage 면 fail open. state I/O 실패는 guard 만 fail open, active-pipeline evaluation 은 계속

### Changed

- **`chore(skills)` (commit `38a05ee8`, Closes #112)** public skill surface 정리 — measurable surface = `internal: true` / `deprecated: true` 제외 core skills. 현재 13 public + 11 compatibility alias + 9 internal helpers. `deprecated` / `superseded-by` metadata 가 `skill.json` 에 보존되어 stale description resurrection 차단

### Notes

- prepare commit `d753e9f7` 가 `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` + `package.json` + `package-lock.json` + `packages/triflux/package.json` 5개 metadata bump
- v11 까지는 legacy skill directory 물리 삭제 보류 (compatibility alias 의 alias-usage logging + zero-usage evidence 수집 단계)

## [10.20.1] - 2026-05-12

### Fixed

- **`fix(swarm)` (commit `106f8cd6`)** bounded lifecycle 과 swarm visibility 갭 해소 — v10.20.0 POSIX gateway 도입 이후 발견된 long-running worker lifecycle bound 누락과 swarm dashboard surface 불일치를 함께 정리
- **`chore(session)` (commit `20f5076e`)** session cleanup 시 fsmonitor buildup 감시 — `git fsmonitor--daemon` 누적 시 다음 세션 시작 nudge

## [10.20.0] - 2026-05-11

### Added

- `mcp-gateway` now supports macOS and Linux hosts with detached POSIX process management, so stdio MCP servers can run through the local gateway outside Windows.
- `tfx-research` now recognizes Korean question-pattern prompts more reliably, improving routing for Korean research requests.

### Fixed

- Worker integration tests now clean up temporary `.tmp-home-route-*` home-isolation fixture directories after execution, with a `.gitignore` guard for interrupted runs.

## [10.19.0] - 2026-05-11

### Added

- **`chore(mcp)` (commit 5fc102e9)** Upstash Context7 HTTP MCP 엔트리 추가 (`config/mcp-registry.json`) — API key 불필요. 라이브러리 문서 / 코드 컨텍스트 접근. 3 CLI (claude/gemini/codex) 공통. packages/triflux 미러는 누락된 `policy_notes` / `sync_denylist` 도 함께 보강하여 root 와 byte-identical 정합 회복
- **`chore(tfx-route)` (PR #249)** `TFX_GEMINI_DEFAULT_PROFILE` env 도입 + pro31 → pro25 default. `scripts/tfx-route.sh:943-945` 의 Node inline + shell fallback 2 위치 변경. 4-case env override 검증 (`unset → pro25`, `pro31`, `flash25`, `invalid → pro25 fallback`)
- **`chore` (PR #246)** AI CLI ignore templates — `.claudeignore`, `.codexignore`, `.geminiignore` 추가. 각 CLI 가 자기 작업 결과물을 무시하도록 기본 패턴 제공
- **`fix(skills)` (commit 57d9f5c0, Closes #248)** `tfx-wt` skill 신규 — b313c648 (4/11) PR 누락된 SKILL.md 복원. `wt-cli.mjs` 호출 가이드 + `wt-manager` API 매핑 (createTab/splitPane/list/close/rename) + psmux 통합 패턴 (`.claude/rules/tfx-psmux.md` RULE 5-3 인용) + Windows 전용 분리 정신 (PR #236, PR #241). packages/triflux 미러 byte-identical

### Fixed

- **`fix(wt-manager)` (PR #241)** macOS/Linux 에서 `createWtManager()` 가 stub 반환 + `autoAttachTerminal` OS guard. v10.18.2 회귀 (`tfx multi --teammate-mode headless` 가 macOS 에서 `wt-manager.mjs is Windows-only` throw 로 crash) 수정. 8 호출 사이트 모두 OS-aware 동작
- **`fix(cli-adapter-base)` (PR #240)** `runProcess` resultFile size/mtime 을 progress signal 로 인정 (Codex Tier 1 강건성). silent CLI 가 stall 잡히지 않던 회귀 fix
- **`fix(codex-mcp)` (PR #242, Closes #234)** `worker.stop` 을 `closeWithin` 으로 bounded — P1 root fix. shutdown 시 client.close 가 settle 안 되어도 awaited timeout 으로 transport.close 진행
- **`fix(tfx-route-worker)` (PR #243)** async stream stdin read 로 Node v25 EAGAIN race 회피

### Changed

- **`chore(pr236-followup)` (PR #247)** PR #236 lake-bundle cleanup — A1 dead code drop + F2/S1/T2/M1/M2/A2 후속 정리

### Tests

- **신규** `tests/unit/keyword-rules-skill-targets.test.mjs` (commit 57d9f5c0) — 3 mirror keyword-rules.json 의 모든 `skill` 타깃이 실재 skill 디렉토리 또는 known external gstack alias 인지 자동 검증. 4 케이스 (3 mirror skill target + 1 byte-identical) 회귀 가드

## [10.18.2] - 2026-05-07

### Fixed

- **`fix(macos)` (PR #233)** macOS 환경 두 회귀 해결:
  - **#231**: `hooks/hook-registry.json`의 `ext-session-vault-{start,export}` 가 `enabled: true`로 박혀 doctor `--fix` 실행 시 source 디렉토리 부재 여부 검사 없이 settings.json 에 무조건 등록됐다. 이제 두 항목은 `enabled: false` + `requires: "$HOME/Desktop/Projects/tools/session-vault"` 로 마킹되고, 등록 로직이 `requires` 경로 부재 시 silent skip 한다. 외부 통합 hook 일반 패턴으로도 재사용 가능. (Closes #231)
  - **#232**: `scripts/tfx-route.sh:368` 의 `local text="${prompt,,}"` 가 bash 4+ 전용 case-conversion syntax 라 macOS 디폴트 `/bin/bash 3.2.57` 환경에서 `bad substitution` 으로 dispatch 자체가 실패했다. portable `tr '[:upper:]' '[:lower:]'` 로 교체. 추가로 코드베이스 전반에 동일 패턴 sweep — 단일 occurrence 였음을 확인. (Closes #232)

### Tests

- 신규: `tests/unit/setup-sync.test.mjs` (PR #233) — `requires` gating 회귀 가드 (경로 부재/존재/필드 없음 3개 시나리오)
- 신규: `tests/unit/tfx-route-duration.test.mjs` (PR #233) — `estimate_expected_duration_sec` 가 bash 3.2 호환임을 직접 검증

## [10.18.1] - 2026-05-07

### Fixed

- **`fix(hud)` (PR #230)** macOS Keychain OAuth credentials 지원 — `hud/providers/claude.mjs:readClaudeCredentials()` 가 `~/.claude/.credentials.json` 파일만 읽던 동작에 macOS `security find-generic-password -s "Claude Code-credentials"` fallback 추가. npm 단독/Keychain 환경에서 HUD `c:` 라인이 `--%`/`n/a` 로 굳던 회귀 해결. `writeBackClaudeCredentials()` 도 대칭적으로 Keychain 쓰기 지원해 토큰 갱신 시 file/Keychain drift 방지. (Closes #226)
- **`fix(setup)` (PR #229)** macOS npm-only install 환경의 hook & recovery sync 회귀 해결: `scripts/lib/*.sh` 도 sync 매니페스트 포함되어 `codex-recovery.sh` 누락 차단; `tfx-route.sh` 의 `codex-recovery.sh` source 를 file-exists 가드로 변경; `triflux doctor` 에 macOS `timeout`/`gtimeout` 검사 + `coreutils` 안내·대화형 설치 추가; settings.json hook command 에 `${PLUGIN_ROOT:-<package-root>}` fallback 적용해 plugin marketplace 미등록 환경에서 hook 이 `/hooks/...` 로 붕괴되던 silent fail 차단; `doctor` 가 붕괴된 hook 경로 자동 감지/수정. (Closes #227, Closes #228)
- **`fix(hud)` (PR #225)** Opus 4.7 pricing 정정 ($15/$75 → $5/$25, 3× 과대계상 해결)
- **`fix(release)` (PR #221)** `prepare.mjs` npm-test step 의 npm wrapper 우회 (#192 F3)

### Changed

- **`chore(rules)` (PR #223)** `tfx-mirror-policy.md` — packages/ 3-layer mirror 정책 명문화

### Tests

- **`test(regression)` (PR #220)** `release:prepare` step sequence completeness guard 추가
- 신규: `tests/unit/hud-claude-credentials.test.mjs` (PR #230) — file-only / Keychain fallback / null-fallback 시나리오
- 보강: `tests/unit/setup-sync.test.mjs` (PR #229) — `SYNC_MAP` 이 `scripts/lib/*.sh` 포함하는지 회귀 가드
- 신규: `tests/unit/tfx-route-codex-recovery.test.mjs` (PR #229) — optional source 가드 회귀 보호
- 신규: `tests/unit/doctor-macos-hooks.test.mjs` (PR #229) — `${PLUGIN_ROOT}` fallback 자동 적용 회귀 보호

### Docs

- **`chore(docs)` (PR #224)** issue #192 silent EXIT 0 분석 + 재현 방법론

### Chore

- **`chore(lint)` (PR #222)** baseline cleanup — biome auto-fix + dedup mcp-registry policy_notes
- **`chore(packages)` (PR #219)** packages/{core,remote} mirror 동기화 (v10.18.0 hub state)

## [10.18.0] - 2026-04-30

### Added

- **`feat(hub/mcp)` (PR #218)** Step 1 lifecycle trace + per-CLI label + `/status?include_metrics` opt-in (merge commit 6613219)
  - 신규 `hub/lib/trace-recorder.mjs` (153 lines) — reservoir sample 1000, p50/p95/p99 percentile, `category × client × phase` bucketing
  - X-TFX-Client header 기반 per-CLI 식별 (request span 에 client 라벨 부착)
  - `transports` map 에 `client` / `createdAt` 필드 추가
  - `createMcpForSession(clientRef)` closure 로 ListTools/CallTool span 자동 부착
  - `/bridge/{register,publish,deregister}` worker span 기록 (성공한 register 만 발화)
  - `/status` default 응답 14 baseline fields IRON RULE 100% 보존 — metrics 는 `?include_metrics=1` 쿼리 파라미터로만 노출

### Tests

- Added regression coverage for `/status` 14 baseline fields preservation (`tests/regression/status-include-metrics.test.mjs`)
- Added integration coverage for X-TFX-Client header binding, bucket separation, invalid duration silent ignore (`tests/integration/mcp-trace-lifecycle.test.mjs`)
- Realigned `tests/unit/hub-mcp-session-close.test.mjs` boundary marker patterns to track new `createMcpForSession(clientRef)` signature

### Docs

- TODOS.md — PRD B Tier 2 followups 추가 (MCP hub Option C cleanup ownership, Q1 benchmark harness real-client lifecycle)

## [10.17.3] - 2026-04-27

### Fixed

- Prevented tfx-hub from crashing with `RangeError: Maximum call stack size exceeded` when MCP Streamable HTTP sessions close. Transport `onclose` now goes through a guarded close path instead of recursively calling `mcp.close()` through the SDK close chain.

### Tests

- Added regression coverage for MCP session close lifecycle guards.

## [10.17.2] - 2026-04-27

### Fixed

- Protected live Claude Code/Codex CLI wrapper processes from orphan cleanup. The hub and SessionStart stale PID cleanup now skip a `node.exe`/`cmd.exe` wrapper when a live `claude.exe` or `codex.exe` exists anywhere in its descendant tree, preventing session disconnects when the wrapper parent looks stale.

### Tests

- Added regression coverage for node wrappers that own live Claude/Codex child processes.

## [10.17.1] - 2026-04-27

### Fixed

- Prevented the hub orphan-process cleanup from terminating active Claude Code or Codex sessions. The periodic cleanup now treats live `claude.exe` and `codex.exe` processes as protected session roots, while still reclaiming narrow legacy runtime leftovers.
- Added `TFX_DISABLE_ORPHAN_CLEANUP=1` as an emergency gate for hub orphan cleanup and expanded cleanup logs with killed process details so future incidents show the exact PID, process name, command line, and caller.
- Extended hub runtime cleanup to remove orphaned duplicate `bun ... gbrain/src/cli.ts serve` processes while preserving the live `gbrain` runtime under the active Claude/Codex session.
- Disabled the broad Stop-hook MCP cleanup by default. `mcp-cleanup.ps1` is now opt-in via `TFX_ENABLE_STOP_MCP_CLEANUP=1`, preventing normal Claude Code response-stop events from killing live MCP runtimes.
- Hardened SessionStart stale PID cleanup against Windows PID reuse and live Claude/Codex ancestor chains, so stale `tfx-route-*-pids` files cannot kill runtime children from the current session.
- Cleaned up stray SS3 cursor escape fragments such as `[O[` from routed CLI output.

### Tests

- Added regression coverage for active Claude/Codex session protection, MCP child process protection under those roots, stale PID cleanup safety, Stop-hook MCP cleanup safety, and SS3 cursor artifact cleanup.

## [10.17.0] - 2026-04-26

### Fixed

- **`fix(test)` (PR #199, Phase 1)** tfx-route-smoke fake CLI fixture 안정화 (5d0edaf) — Linux ubuntu-latest CI 의 `codex --version` not-found 로 tfx-route.sh 가 `claude-native` fallback path 진입 → `tests/integration/tfx-route-smoke.test.mjs` 의 `resolved_profile=executor` regex mismatch (45 fail). `tests/fixtures/bin/{codex,gemini,timeout}` 의 Linux executable bit 활성화 + `tests/fixtures/fake-codex.mjs`/`fake-gemini-cli.mjs` 의 `--version` 응답 보강 + 테스트의 fallback resolved_profile 인식 path 추가. **결과**: 45 fail cascade 제거, CI Linux 에서 fake CLI 사용으로 codex 인증 의존 제거.
- **`test(ci)` (PR #199, Phase 2)** codex-app-server-worker AC-1 initialize timeout 안정화 (3768b4f) — `tests/unit/codex-app-server-worker.test.mjs:307` 의 AC-1 30ms bootstrap budget + `unref()` timer 가 Linux CI test runner 의 이벤트 루프 종료로 35건 cancelledByParent cascade 유발. Fake JSON-RPC client timer 를 ref 로 변경 + bootstrap timeout 500ms 로 상향 → `CodexAppServerTransportError` rejection 경로 안정 관측. **결과**: 36 fail cascade 제거.
- **`fix(test)` (PR #199, Phase 3)** worktree-lifecycle Linux path portability (50a95d1) — `tests/unit/worktree-lifecycle.test.mjs` 가 `ensureWorktree()` 의 forward-slash 반환을 무조건 Windows `\` 로 변환 → Linux CI 에서 `\tmp\...` ≠ `/tmp/...` 로 `existsSync` 실패, W-08/W-10/W-09 cwd cascade. 플랫폼 skip 대신 반환 계약 그대로 fs/cwd 에 넘기도록 정렬. **결과**: 13 fail cascade 제거.
- **`fix(test)` (PR #199, Phase 4)** 잔여 카테고리 cascade 일괄 해소 (c16f411, 28 files) — Linux CI 잔여 fail 제거.
  - **Ref/unref timer cancellation root**: `hub/workers/worker-utils.mjs`, `hub/cli-adapter-base.mjs`, `hub/workers/lib/jsonrpc-stdio.mjs`, `hub/router.mjs` — awaited retry/timeout timers 를 ref 로 유지해 Node test runner 가 cancelledByParent 선언하지 않도록.
  - **Codex CLI absent command-shape cascade**: `hub/cli-adapter-base.mjs`, `bin/triflux.mjs` — version detection fallback 을 modern `codex exec --color never` 계약으로 고정. Hub start 가 codex binary 유무와 무관하게 `~/.codex/config.json` 의 tfx-hub entry 보장.
  - **Codex review fixture determinism**: `hub/team/codex-review.mjs`, `tests/unit/codex-review.test.mjs` — oversized gate 의 실제 git diff 의존을 dependency injection fixture 로 교체.
  - **CI memory-doctor force fixtures**: `tests/unit/memory-doctor.test.mjs` — autofix 검증 케이스에 `{ force: true }` 적용.
  - **Linux git identity + psmux regex**: `hub/team/worktree-lifecycle.mjs`, `hub/team/psmux.mjs` — cherry-pick commit 작성용 deterministic fallback identity, orphan MCP cleanup regex 의 session boundary class 정렬.
  - **결과**: router 18 / retry 12 / codex-review 12 / hub-restart 10 / memory-doctor 9 / jsonrpc-stdio 8 / routing-qa 5 / rebase-branch-safety 4 / hub-start-codex-config 4 / session-fingerprint 3 / pane 3 / backend 3 / gemini-adapter 1 / codex-adapter 1 등 ~62 fail/cancelled 일괄 해소.
- **`fix(test)` (PR #199, Phase 7)** Phase 1-4 후 잔여 ~14 fail 추가 해소 (bd9605c, 965fb88, d54e2c3) — codex-app-server cleanup timer drain (965fb88), conductor shutdown cleanup 안정화 (d54e2c3), 그 외 phase 7 residuals (bd9605c) 일괄. `tests/unit/conductor.test.mjs:432` waitFor 3000ms timeout 회귀 fix 포함.
- **`fix(config)` (PR #199, Phase 8)** codex MCP sync test env guard 추가 (b85046b) — Phase 4 의 hub start 자동 sync 가 npm test 중 `~/.codex/config.toml` mutate 해 Issue #193 회귀 가드 trigger. `isProtectedCodexConfigMutationEnv()` (NODE_ENV=test / CI / TFX_TEST / TRIFLUX_TEST_HOME) 가드 적용 + `tests/unit/sync-hub-mcp-settings.test.mjs` 추가.
- **`fix(test)` (PR #199, Phase 9)** 잔여 codex config mutation paths 차단 + hub-idle-timeout 안정화 (9bb3270, 76d9a04) — Phase 8 후에도 mutation 잔존 (size -14B trim) → `scripts/codex-mcp-gateway-sync.mjs`, `scripts/lib/mcp-guard-engine.mjs`, `hub/server.mjs`, `scripts/setup.mjs` 모든 writer 에 env guard 적용. `tests/integration/hub-idle-timeout.test.mjs` 의 random port 28100-28299 collision 을 `getUnusedPort()` (OS 할당) 로 deterministic 대체. setup integration test 가 `TFX_CODEX_CONFIG_SYNC=1` 로 가드 우회 (76d9a04).
- **`fix(hosts-compat)` (PR #198)** nested `ssh.user` shape 정규화 (460f5c6) — Windows `references/hosts.json` 의 `{ ssh: { user: "..." } }` 를 capability/resources selector 가 인식하도록 정규화.
- **`fix(test)` (PR #198)** routing-qa + intent fixtures 의 PR #184 model mapping 동기화 (c698869).
- **`fix(keyword-rules)` (PR #198)** tfx-unified rule 에 `병렬`/`점검`/`계속` 패턴 추가 (3c2aca8).

### Changed

- **`chore(ci)`** `continue-on-error: true` guard 영구 제거 (8bdc00e, Phase 5) — `cec9124` 가 임시 우회로 추가한 `Codex config stability guard` step 의 `continue-on-error: true` + 주석 7줄 제거. **결과**: strict regression gate 회복 — 다음 push 부터 guard step fail 이 workflow status=failure 로 직결되어 회귀를 즉시 차단. `cec9124` 의 임시 unblock 이후 후속 수정 (Phase 1-4 + 7-9) 으로 baseline 56 fail → 0 fail 100% 해소.

### Tests

- 56 baseline fail → 0 fail / 0 cancelled (PR #198 CI run 24946484889 → PR #199 final run 24948670562)
- pass count: 3084 → 3195 (97.6% → 100% pass rate)
- continue-on-error 영구 제거 후에도 CI green 유지

## [10.16.0] - 2026-04-26

### Added

- **`feat(snapshot)` (#196, shard E)** codex/gemini state auto-snapshot watcher (76e709e) — Hub `ensure` 경로에서 24h threshold 기준으로 `~/.codex/`, `~/.gemini/` 의 config·skills·agents·plugin·state 를 best-effort rolling 10 archive 로 백업한다. config-wipe 회귀와 update-time state loss 로부터 사용자 환경을 보호. **Constraint**: hub-ensure 동기 차단 금지 → detached wrapper (`scripts/snapshot-watcher.mjs`) 로 spawn. **Constraint**: snapshot 은 binary 라 git history 외부 (`~/.codex-backups/`, `~/.gemini-backups/`) 로 분리. `tests/unit/state-snapshot.test.mjs` + `tests/unit/hub-ensure-port-cascade.test.mjs` PASS. `npm run snapshot:codex` / `npm run snapshot:gemini` 수동 진입점도 추가.
- **`feat(swarm)` (#197, shard C)** WorkerSignalChannel — shard lifecycle signal channel (a26114e) — append-only 파일 기반 shard lifecycle signal 을 worker-signals state tree (`~/.claude/cache/tfx-swarm/worker-signals/`) 에 기록한다. callback 기반 listening + stale heartbeat detection 을 포함한다. **Constraint**: 본 shard 는 infrastructure 만 — full hypervisor/planner 통합은 후속 shard. **Rejected**: file-lease state directory 공유 → worker signal 은 lease 와 별개 lifecycle 이라 contention 회피 위해 분리. `tests/unit/worker-signal.test.mjs` PASS.

### Fixed

- **`fix(hub)` (#197, shard A)** codex config.toml MCP port auto-mutation 차단 (ff6aff5, BUG-D/E regression family) — Hub startup 이 `TFX_HUB_PORT` 또는 default `27888` 을 유일한 port source 로 취급하고, codex MCP sync 가 runtime port 가 아닌 canonical `27888` URL 로 `~/.codex/config.toml` 을 안정화한다. PR #158 single-source 정책을 hub start/reuse 결정 경로까지 전파. **Rejected**: sticky live pid port reuse 보존 → BUG-D/E port cascade 가 codex config.toml 로 재진입하는 회귀 trigger. `tests/regression/codex-config-port-stable.test.mjs`, `tests/unit/hub-server-port.test.mjs`, `tests/unit/state.test.mjs`, `tests/unit/mcp-singleton.test.mjs`, `tests/unit/sync-hub-mcp-settings.test.mjs`, `scripts/__tests__/mcp-guard-engine.test.mjs`, `tests/unit/packages-mirror.test.mjs`, `tests/unit/setup-home-resolution.test.mjs` PASS. `node bin/triflux.mjs hub start --port 27888` 3회 반복 후 `~/.codex/config.toml` mtime 불변 + `url=http://127.0.0.1:27888/mcp` 검증.
- **`fix(mcp)` (#197, shard B)** child stdin EOF 닫기 — MCP bootstrap/profile-filter hang 차단 (1b31a63, #192 hang 카테고리) — non-interactive route helper process 의 stdin 을 닫고 non-TTY heartbeat stdio 를 detach 해 Git Bash sleep child 가 caller pipe 를 hang 상태로 잡지 못하도록 한다. Codex MCP bootstrap 이 transport 조기 종료를 방지하도록 가드 + bootstrap transport 실패 코드를 transport exit code 로 매핑해 tfx-route auto fallback 이 동작. **Constraint**: interactive TTY heartbeat output 보존, non-TTY route 만 stderr log 로 진단 출력. **Rejected**: heartbeat 전역 비활성화 → interactive progress signal 손실 (UX 회귀). `tests/regression/mcp-bootstrap-no-hang.test.mjs`, `tests/unit/codex-mcp-worker.test.mjs`, `tests/integration/triflux-cli.test.mjs --test-name-pattern=MCP` PASS. `npm test` 99s 종료 (잔존 fail 은 fixture/host-config 카테고리 — #192 deferred shard).
- **`fix(config)` (#193, #194)** HOME/USERPROFILE swap 존중으로 test fixture 격리 (5dad109) — Windows `os.homedir()` 가 `USERPROFILE` 만 보고 `process.env.HOME` swap 을 무시 → integration test 의 spawn child (setup.mjs / sync-hub-mcp-settings.mjs) 가 fixture homeDir 을 무시하고 production `~/.codex/config.toml` 을 mutate 하던 회귀 (#193). 우선순위: `TRIFLUX_TEST_HOME` > `HOME` > `USERPROFILE` > `os.homedir()`. PR #194 codex review 반영으로 platform-aware home resolution + 회귀 test (`tests/unit/setup-home-resolution.test.mjs`) + `scripts/check-codex-config-stable.mjs` 가드 wrapper + `npm script test:guard-codex-config` 추가. **회귀 영향**: Windows 일반 사용자 (HOME unset) 동작 변화 없음, Windows + Git Bash (HOME set) 도 USERPROFILE 우선으로 기존 `homedir()` 와 동일, POSIX (HOME set) 기존 동작 그대로.
- **`chore` (#195)** `.mcp.json.bak-*` atomic write backup ignore (e195d1a) — `writeTextAtomic` rollback 실패 시 보존되는 `.mcp.json.bak-<pid>-<ts>` 파일이 프로젝트 root 에 untracked noise 로 노출되는 문제 차단. 정상 흐름은 finally 에서 정리 (`sync-hub-mcp-settings.mjs:147`), rollback 자체 실패 시에만 수동 복구용으로 보존되도록 설계 (line 130-141). PR #183 의 `references/hosts.json.bak.*` 패턴 옆에 인접 배치.

### Changed

- **`fix(swarm-cli)` (#116-C policy reversal)** non-TTY 환경 fail-fast → warn-and-proceed (3d881fc) — `assertTtyForSwarm` 이 양측 stdout/stdin non-TTY 시 더 이상 차단하지 않고 warning 출력 후 진행. **이유**: 기존 fail-fast 는 첫 사용자에게 묻기 효과 (실제 user terminal 은 TTY 인데 Claude Code `run_in_background` 같은 spawn 환경에서 child stdio 만 non-TTY) → 다른 사용자도 동일 마찰. **신설**: `TFX_BLOCK_NON_TTY_SWARM=1` opt-out env (안전 망 — 실제 hang 환경에서 차단). 기존 `TFX_ALLOW_NON_TTY_SWARM=1` 은 silent OK 호환 유지 (warning suppress). main + `packages/{triflux,remote}` mirror 3개 byte-equal 동기화.
- **`chore(scripts)` (#197, shard D)** `release:bump --write` 누락 시 warning + codex-config guard CI 통합 (99742c5) — release bump 가 `--write` 플래그 없이 호출되면 dry-run 임을 명시 stderr 경고. `.github/workflows/ci.yml` 에 codex-config guard step 추가 (production `~/.codex/config.toml` mutation 회귀 가드). **Constraint**: PRD 가 CI 통합만 선택 → husky 는 본 shard 에서 documentation-only 유지. `tests/unit/bump-version-warning.test.mjs` + `scripts/__tests__/release-governance.test.mjs` + `npx js-yaml .github/workflows/ci.yml` PASS.
- **`chore(gitignore)`** `references/{codex,gemini}-snapshots/` 제외 (0d8f41c) — manual codex state snapshot (141MB) 이 GitHub 100MB 제한 초과 → `~/.codex-backups/codex-state-20260426-092115.tar.gz` 외부 이동. shard E 의 auto-snapshot watcher 도 동일 path 사용 → git tracking 시 repo size 폭증 방지.
- **`chore(hub)`** spawn stdio 를 log file 로 redirect (abcd4de) — `bin/triflux.mjs:5043` + `:5231` 의 hub server spawn 이 `stdio: "ignore"` 사용 → stdout/stderr 가 어디로도 가지 않아 crash root cause 추적 불가. `openHubLogFd()` helper 추가, `~/.claude/cache/tfx-hub/hub.log` 에 fd 열어 두 spawn 위치 모두 적용. `tfx hub start` startup `errFd` 는 keep (#102 패턴) 하면서 runtime stderr 도 hub.log fallback 으로 캡처.
- **`chore(test-lock)`** spawn stdio 분리 + stdin close (4f8076e) — `scripts/test-lock.mjs` spawn 이 stdin 을 열린 채 두던 패턴 → child 가 stdin EOF 받지 못하면 hang. stdin close 로 robustness 개선.
- **`chore(release)`** `runCommand` maxBuffer floor + per-step override (4c36be4) — release prepare 가 npm test/lint 출력 OOM 으로 silent fail 하던 패턴 차단. floor 값 + 단계별 override 가능.

### CI / Build

- **`ci`** npm ci fallback to `npm install` on lock sync mismatch (063c144) — PR #196 (shard E) 가 `package.json` 추가 시 lock 파일 갱신 없이 머지 → main 에 push 후 `npm ci` 가 `@emnapi/core`/`@emnapi/runtime` peer dep 누락으로 fail. workflow 에서 `npm ci || npm install --no-audit --no-fund` fallback 으로 임시 mitigation. 후속: 다음 PR 들도 같은 패턴 발생 가능 → release-checklist 에 lock sync 단계 강조.
- **`ci`** `continue-on-error: true` for codex-config-guard step (f47eb52, 임시) — `tests/**/*.test.mjs` glob 이 Linux bash 에서 literal 로 전달되어 `test-lock.mjs` 가 자체 glob expand 안 함 → guard step fail. **임시**: continue-on-error 로 PR 머지 차단 회피. **Follow-up (다음 ship 전 P1)**: `scripts/test-lock.mjs` 자체 glob expand (bun glob / fast-glob) 또는 `package.json` test script 를 explicit list 로 변환 후 continue-on-error 제거.
- **`chore(deps)`** package-lock.json sync after PR #196 머지 (2046474) — 위 npm ci fallback 의 근본 sync.

### Docs

- **`docs(tfx-ship)`** `--write` + `--allow-dirty` 를 mandatory 로 명시 (5465822) — 두 플래그 누락 시 silent dry-run / `Working tree is dirty` reject 로 후속 step 이 모두 이전 버전으로 진행되는 silent failure 발생. SKILL.md Step 3/5 에 mandatory 라벨 추가.
- **`docs(release)`** `prepare.mjs` npm-test 주석을 #192 root cause 로 갱신 (d66d954).
- **`docs(prd)`** worker signaling consolidation 4-channel ground truth (ec34b06).

### Tests

- **+1 file** `tests/unit/state-snapshot.test.mjs` (shard E)
- **+1 file** `tests/unit/worker-signal.test.mjs` (shard C)
- **+1 file** `tests/regression/codex-config-port-stable.test.mjs` (shard A)
- **+1 file** `tests/regression/mcp-bootstrap-no-hang.test.mjs` (shard B)
- **+1 file** `tests/unit/setup-home-resolution.test.mjs` (#193, #194)
- **+1 file** `tests/unit/bump-version-warning.test.mjs` (shard D)
- **`tests/unit/swarm-cli.test.mjs`** — `assertTtyForSwarm` 7 시나리오 갱신: stdout/stdin TTY silent OK, 양측 non-TTY 기본 warn-proceed, `TFX_ALLOW_NON_TTY_SWARM=1` silent compat, non-'1' 값에서도 default warn, `TFX_BLOCK_NON_TTY_SWARM=1` fail-fast, opt-out > opt-in 우선순위. 12/12 pass.

## [10.15.0] - 2026-04-25

### Fixed

- **`fix(codex-mcp)` (#185)** 0.124.0 silent-success 회귀 detect + exec fallback 트리거 (75c0532) — codex MCP 가 `exitCode=0` + 빈 `output` 을 반환하는 0.124.0 회귀 케이스를 감지해 `CODEX_MCP_TRANSPORT_EXIT_CODE` 로 승격, wrapper 의 codex exec fallback 을 트리거한다. `tfx-route.sh` sync 모드에서 `STDOUT_LOG=0 byte` 를 success 로 오판해 caller 가 결과 못 받던 silent-flush 경로 차단. **변경**: `hub/workers/codex-mcp.mjs` + mirror 에 `hasOutput = result.output.trim().length > 0` 검사 추가 — 빈 output + exit 0 → exitCode 승격 + stderr WARNING. `tests/fixtures/fake-codex.mjs` `mcp-empty` 모드 신설 (silent-flush 시뮬레이션) + `tests/unit/codex-mcp-worker.test.mjs` reproduction case 추가 (5 → 6 tests). codex 0.124.0 silent flush 는 codex CLI 자체 동작이라 wrapper layer 만 detect/fallback 가능. 후속 worker signaling 통합 PR (issue #176 + 메타 B/E) 의 family 첫 단계.
- **`fix(headless-guard)` (#186)** `$()`/eval 휴리스틱 `.*` 좁혀 grep 인자 오탐 방지 (b42cf5c) — `scripts/headless-guard.mjs` 의 2차 휴리스틱 `\$[({].*\b(codex\s+exec)\b` 와 `\beval\b.*\b(codex\s+exec)\b` 의 `.*` 가 너무 넓어 `result=$(grep "codex exec" file)` 같은 grep 인자 패턴까지 codex 직접 호출로 차단 → 코드베이스 탐색조차 막는 오탐. **수정**: `.*` → `\s*` 로 좁혀 command substitution / eval 의 *첫 명령* 만 검사하도록 변경. 진짜 위협 (`$(codex exec ...)`, `eval "codex exec ..."`) 은 그대로 차단. main + `packages/triflux` mirror 동기. 회귀 보존 케이스 그대로 deny + 오탐 방지 unit test 3건 추가 (`$()` 안 grep, `$()` 안 파이프된 grep, `eval "$(grep ...)"`). 68/68 pass, biome lint clean.
- **`fix(swarm)` (#184)** lease-outside validate guard + 모델-직무 매핑 개편 (89f9ad2) — `swarm-locks.validateChanges` 가 cross-lease 침범만 검사해 lease 외 file 의 신규/수정/삭제를 모두 통과시키던 4개월 만의 회귀 (#115, #34 후속). 2026-04-25 #178 작업 중 core-compat recovery patch 안에 `.claude-plugin/{marketplace,plugin}.json` 의 `+++ /dev/null` (삭제) 시도가 들어왔으나 lease-only 검사로 detect 불가 → 만약 worker 가 commit 했다면 distribution 깨짐. **Fix**: `validateChanges(workerId, changedFiles, options?)` 에 `ownLease` + `sensitiveDeny` 옵션 추가 (옵션 미제공 시 기존 동작 유지 — backward compat). `ownLease` 가 명시되면 lease 외 file 이 distribution-critical path (`.claude-plugin/`, `bin/`, `.github/workflows/`, `package.json`, `.gitignore`) 에 해당하면 violation `kind="sensitive-out-of-lease"` 로 보고. `swarm-hypervisor.validateResult` 가 `plan.leaseMap[shardName]` 을 ownLease 로 전달. 105/105 기존 테스트 + 신규 5 case (sensitive guard) green. **추가**: 모델-직무 매핑 개편 — gpt-5.5 메인 (코드/리뷰/추론, fast tier 가능), gpt-5.4-mini 자잘/부가 (cleanup, fast tier), gpt-5.3-codex escalation 가성비 중간 (Plus/free OK), gpt-5.4 (mini 외) 폐기 → 5.5 격상. 직무별 매핑: executor/implement → gpt55_high, debugger → gpt55_xhigh, build-fixer → gpt55_low, cleanup/deslop → mini54_med (신규), analyze/design/architect/critic → gpt55_xhigh, code-reviewer/security-reviewer/scientist → gpt55_high. Escalation chain (`tfx-escalation-chain.md`): 1) codex:gpt-5.4-mini 2) **codex:gpt-5.3-codex** (신규 가성비 중간) 3) codex:gpt-5.5 4) claude:opus-4-7. sonnet-4-6 단계 제거 (gpt-5.5 가 코드/추론/비용 모두 우위).
- **`fix(#178)` (#183)** hosts.json user-state 경로 이전 (lazy migration + source-tree fallback) (deabe8d) — hosts.json 정식 경로를 source-tree → user-state (`~/.config/triflux/hosts.json` POSIX, `%APPDATA%\triflux\hosts.json` Windows) 로 이전. **변경**: `userStateHostsPath()` 신설 — `TFX_HOSTS_USER_STATE` override + `TFX_HOSTS_USER_STATE_DISABLE=1` escape hatch 지원. `migrateLegacyHosts()` — `readHosts()` 첫 호출 시 source-tree `references/hosts.json` 을 user-state 경로로 lazy 비파괴 복사. 권한/path 실패는 throw 하지 않고 source-tree fallback. `candidatePaths()` 가 user-state path 를 source-tree 후보 앞에 prepend. `tui-remote-adapter` 가 `hostsJsonPath` 옵션 대신 `readHosts()` 경유로 통일 (3개 미러 동기화). 기존 matrix test 는 `TFX_HOSTS_USER_STATE_DISABLE=1` 로 source-tree 전용 흐름 보존, 신규 test suite 는 `TFX_HOSTS_USER_STATE` 로 sandbox. Constraint: hosts.json 은 repo 외부에 위치. Source-tree fan-out (drift-prone) 은 reject.
- **`fix(#161)` (#182)** hub-autostart /Query 실패 구분 + /TR 262자 사전 검증 (7eb0383) — Windows hub-autostart 등록 상태 진단 정확도 개선. **P2**: `getWindowsHubAutostartStatus` 가 stderr ignore + catch 후 항상 `registered:false` 반환 → Access Denied 같은 해결 가능한 문제가 "미등록" 으로 묻혀 사용자가 원인 파악 불가. `classifySchtasksStderr` 신설 → `not_registered` (영문 "cannot find the file" / 한글 "지정된 파일") / `access_denied` (영문 "access is denied" / 한글 "액세스가 거부") / `unknown` 분류. 반환 타입에 `reason` + `stderr` 필드 추가 (기존 boolean 필드 유지). **P3**: `ensureWindowsHubAutostart` 가 schtasks `/TR` 262자 제한을 사전 검증 (Windows 내부는 wide-char 문자 수 기준이라 `command.length` UTF-16 code units 사용 — Codex Round 1 P1 finding 반영, 한글 경로 218자 = 578 bytes 오차단 회귀 방지). `validateSchtasksTrLength` 공용 helper 로 추출해 실제 실행 경로와 테스트가 동일 검증 함수 공유 (Codex Round 2 P2). schtasks `/Create` 실패 시 stderr 를 error.message 에 포함. 11/11 pass, lint clean.
- **`fix(#164)` (#181)** sync-hub writeTextAtomic backup-based rename + TOML 유효성 검증 (433a397) — PR #160 축 3 Codex 리뷰 MEDIUM 2건 해결. **MEDIUM 1**: rename 실패 시 `rm(filePath)` → `rename(tmpPath, filePath)` 순서로 처리하던 비원자 패턴 → 2차 rename 실패 / 프로세스 중단 시 원본 유실 위험. backup 경로로 원본 rename 후 `tmp→dest` 시도, 실패 시 backup 을 다시 dest 로 복원해 원자성 보장. Windows EEXIST/EPERM/EACCES fallback 도 backup 보존 상태에서 안전 재시도. **MEDIUM 2**: `nextRaw` 가 깨진 TOML 이어도 filesystem 반영 + `kind:"updated"` 성공 처리 → `validateCodexTomlPayload` helper 추가 (섹션 헤더 + url 키 최소 구조 확인). write 직전 validation → 실패 시 `kind:"error"` 반환. **Codex Round 1 P1**: rollback rename 실패 시 finally 가 backup 도 삭제해 양쪽 모두 손실 가능 → backup 복원 성공 시에만 cleanup 허용, 복원 실패 시 backup 보존 + console.warn 으로 수동 복구 경로 안내. 26/26 pass, lint clean.
- **`fix(test)` (#174)** quota 테스트 `doesNotMatch` 범위 좁혀 graceful degradation 경고와 분리 (7a35b5e) — quota 한도 도달 메시지가 graceful degradation 경고와 매칭되어 false negative 발생하던 회귀 차단.

### Added

- **`feat(probe)` (#173, #168)** L2 hub /health checker default on (4317091) — L2 hub `/health` checker 가 default 활성. probe accuracy 향상으로 dead/healthy 판정 정확도 강화.

### Changed

- **`chore(lint)` (#177)** baseline 6 warnings cleanup — unused imports / dynamic namespace access (aef93bf) — `check-mcp-hub.test.mjs` `beforeEach`, `setup-codex-profiles.test.mjs` `ensureCodexProfiles`, `setup-sync.test.mjs` `PLUGIN_ROOT`/`CLAUDE_DIR` unused destructure 제거. `shared.test.mjs` dynamic namespace access 에 biome-ignore + 로컬 변수 바인딩. 모두 test 파일, 실제 동작 변경 없음. lint 6 warnings → 0 warnings, 52/52 pass.
- **`docs`** gbrain 섹션 + tfx-remote hosts.json fan-out 임시 패치 안내 (bab31e0) — `CLAUDE.md` `/setup-gbrain` 결과 설정 블록 (engine=pglite, user scope MCP, artifacts-only sync) 추가. `skills/tfx-remote/SKILL.md` 에 hosts.json 수정 시 source-tree fan-out 필요 명시 (임시 — 근본 해결은 PR #183).
- **`chore`** references/hosts.json* 을 .gitignore 에 추가 (#187, 7ffbc14) — user-data (Tailscale IP / SSH user) 의 public repo 노출 방지. PR #183 의 user-state 이전 후속. 패턴: `**/references/hosts.json` (root + packages/triflux mirror) + `**/references/hosts.json.bak.*` (timestamp suffix 도 cover — 기존 `*.bak` 룰은 `.bak` 으로 끝나는 파일만 매칭해 `hosts.json.bak.20260425_040814` 같은 형태는 미커버).

### Tests

- **`test(tfx-route)` (#180)** estimate_expected_duration_sec 한글/영어 키워드 회귀 방지 unit test 추가 (a4926310, fixes #163) — PR #160 Codex 리뷰 LOW 이슈 (한글 regex `(분석|리서치|리팩터|테스트|mcp)` 회귀 방지 부재) 보완. 커버리지: agent 기본값 매핑 6건, profile bump 4건, 한글 키워드 10건 (분석/리서치/조사/전체/싹다/리팩터/마이그레이션/대규모/검증/테스트), 영어 키워드 7건 (deep/research/analyze/refactor/migration/test/mcp), 조합 규칙 3건 (최대값 우선), 상호작용 3건, 경계/빈 프롬프트 2건. 35/35 pass.

## [10.14.3] - 2026-04-25

### Fixed

- **`fix(mcp-guard-engine)` (#166, #172)** resolveHubUrl pid port cascade 제거 (3c1df54) — PR #158 (`21dca5e`) 이 `hub-ensure.resolveHubTarget()` 에서만 pid port cascade 를 제거하고 "env = single source of truth" 정책을 도입했지만 `scripts/lib/mcp-guard-engine.mjs` 의 `resolveHubUrl()` 은 legacy cascade (envPort 없으면 pidPort 로 target.port 덮어씀) 를 유지 → 두 함수 정책 drift. `TFX_HUB_PORT=27888` 이 shell 에 설정된 환경에서 기존 테스트가 env unset 없이 실행 → pidPort (30123/29991) 가 envPort (27888) 에 밀려 assertion fail 하던 회귀. **Fix**: production 경로에서 pid port cascade 전면 제거 — envPort (또는 default 27888) 만 사용하고 `hub.pid` 는 host hint 로만 참조. PR #158 정책을 mcp-guard-engine 까지 propagate. `scripts/lib/mcp-guard-engine.mjs` 원본 + `packages/{core,remote,triflux}/scripts/lib/mcp-guard-engine.mjs` 3 사본 Edit 동기화 (cp 금지 룰 준수). `resolveHubUrl()` 의 downstream `buildDesiredServerRecord()` → MCP 설정 파일 hub URL 생성 경로에서 의도치 않은 부작용 없음 확인.

### Tests

- **+1 / 기존 2 갱신** `scripts/__tests__/mcp-guard-engine.test.mjs` + `packages/triflux/scripts/__tests__/mcp-guard-engine.test.mjs` — 기존 2 fail 케이스를 "env=single source" 의도로 갱신 + 신규 회귀 가드 `ignores hub.pid port (pid is host hint only, PR #158 policy)` 추가. env 설정/미설정 양쪽에서 pid port 재유입 시 fail 하도록 설계. 6/6 PASS.

## [10.14.2] - 2026-04-25

### Fixed

- **`fix(probe)` (#162, #167)** atomic write + stop()→start() race + drain 보장 + Windows backup-then-swap (04d08a3) — health-probe.mjs 의 state file write 가 reader (heartbeat sed) 의 부분 파일 read race 를 야기하던 문제를 atomic tmp+rename 으로 해결. 추가로 PR #167 Codex 교차 리뷰 P0/P1 finding 반영: (P0) `runEpoch` 가드 — `start()` 마다 `++`, `probe()` 시작 시 epoch 캡처, `writeState(result, probeEpoch)` 가 epoch !== runEpoch 면 stale 로 판정 skip → stop()→start() 재호출 시 old run 의 in-flight probe 가 새 run 의 state 를 덮는 race 차단. (P1-1) 단일 `inFlightProbe` 변수 → `inFlightProbes` Set. add/finally→delete 패턴. `stopAndDrain()` 가 `Promise.allSettled(Array.from(inFlightProbes))` 로 전체 drain. setInterval 이 빠른 환경에서 N+1 이 N 끝나기 전에 시작되어 N 이 누락되던 회귀 차단. (P1-2) Windows EPERM/EACCES `unlinkSync→renameSync` 비원자 패턴 → backup-then-swap. `stateFile→backupPath` rename 후 `tmpPath→stateFile`, 2차 실패 시 backup 복구로 기존 파일 보존.

### Added

- **`feat(probe)` (#165, #169)** STALL_KILL classify mode + probe state default on (03b8e45) — `TFX_STALL_KILL` 세 모드 도입: `kill` (alias `1|on`) / `classify` (default) / `off` (alias `0|disabled`). default `classify` 는 kill 안 함 + `STALL_CLASSIFY` 로그로 evidence 노출 (PR #160 의 stopgap default `0` 의 false-kill 방지는 유지하면서 진단 가치 회복). unknown 값은 warning + classify fallback. `TFX_PROBE_WRITE_STATE` default off → on 으로 전환 — atomic write (#167) 로 race 제거됐으므로 안전. opt-out 은 `=0` 명시 (`!== "0"` 패턴). conductor 의 writeStateFile 분기가 default-on 으로 동작 → heartbeat grace (mcp_initializing/input_wait) 가 5-state evidence 를 실전에서 받게 됨.

### Tests

- **+5** `tests/unit/health-probe.test.mjs` — P0 stop()→start() epoch isolation (실제 race 시뮬) + P1-1 3 개 동시 in-flight probe drain + P1-2 backup-then-swap source 패턴 + 옛 unlink→rename 회귀 가드 + P0 source 의 runEpoch 가드 + P1-1 source 의 Set + 옛 단일 var 회귀. 28/28 pass (기존 23 + 신규 5).
- **+9** `tests/unit/tfx-route-stall-kill.test.mjs` — classify default shape assertion + classify mode integration + kill mode integration. 7/7 pass (기존 4 + 신규 3, bash file 경유 — Windows Git Bash EOF race 회피).
- **+2** `tests/unit/conductor-probe-default.test.mjs` — `!== "0"` 패턴 + mirror drift guard. 2/2 pass.

## [10.14.1] - 2026-04-25

### Fixed

- **`fix(tfx-route)` (#170, #171)** MCP graceful degradation default — all-dead 시 stall 방지 (208ca66) — `TFX_MCP_ALLOW_ALL_DEAD=1` 가 preflight check 만 우회 → swap 은 fail-safe 로 스킵 → CODEX_CONFIG_FLAGS 클리어 후에도 transport=auto 분기는 `run_codex_mcp` 호출 → codex-mcp.mjs worker 가 dead MCP (context7/brave-search) 와 connect 시도 → quiet stall 250s+ → STALL_KILL 회귀. **Fix**: `_mcp_preflight_filter_dead` default 동작을 early-fail (#148, rc=78) → graceful degradation (rc=0 + `_TFX_MCP_DEGRADED=1` export) 로 전환. 옛 동작은 `TFX_MCP_FAIL_ON_ALL_DEAD=1` 명시 opt-in 으로만 활성. `TFX_MCP_ALLOW_ALL_DEAD=1` 호환 alias 유지. `run_codex_mcp` 분기에서 `_TFX_MCP_DEGRADED=1` 보면 `TFX_CODEX_TRANSPORT="exec"` 강제 (transport=mcp 명시 시 warning) + `FULL_PROMPT="$PROMPT"` 로 MCP_HINT 제거. 추가 P1 fix: `remaining_alive` 카운트 정규식 `[^.]+` → `.+` 로 dotted alive 서버도 카운트 (PR #171 Codex 교차 리뷰 finding 반영). 사용자 요구 ("MCP 있으면 쓰고 없으면 알아서") 와 일치하는 default 동작.

### Tests

- **+9** `tests/unit/tfx-route-preflight-all-dead.test.mjs` — graceful default rc=0 + `TFX_MCP_FAIL_ON_ALL_DEAD=1` opt-in + `TFX_MCP_ALLOW_ALL_DEAD=1` legacy alias + dotted server graceful + dotted alive survivor (P1-1 회귀 가드) + degraded transport=mcp 강제 (P1-2 회귀 가드) + source 분기 회귀 가드 + mirror byte-identical. 20/20 pass. `tfx-route-args/config-swap/stall-kill` 32/32 pass — 회귀 없음.

## [10.14.0] - 2026-04-24

### Added

- **`feat(tfx-route)`** dead MCP preflight with health probe + TTL cache (9298fd6) — codex 호출 직전에 모든 MCP 서버에 initialize JSON-RPC probe 를 보내 응답 없는 서버를 감지하고 `enabled=true` flag 를 자동 제거. dead 서버 때문에 Codex 가 -32000 으로 죽던 패턴을 차단. probe 결과는 `~/.codex/mcp-health-cache.json` 에 TTL 5분 캐시. opt-out: `TFX_MCP_HEALTH_CHECK=0`. 후속 PR 들 (#147, #148, #149, #152, #153, #154, #155) 이 정확도와 안정성을 점진적으로 강화.
- **`feat(codex-profiles)`** gpt-5.5 main 전환 + escalation chain 갱신 (4f26c24) — OpenAI gpt-5.5 출시 반영. `setup.mjs` 의 top-level model 기본값을 `gpt-5.4` → `gpt-5.5` 로 전환하고 `gpt55_xhigh` / `gpt55_high` / `gpt55_med` / `gpt55_low` 4 tier 프로필을 자동 주입한다. auto-escalate 체인은 step 1 `codex:gpt-5.4-mini`, step 2 `codex:gpt-5.5` 로 갱신. 5.5 mini 변종 부재로 mini 계층은 5.4-mini 유지. 기존 `gpt54_*`, `codex53_*`, `spark53_*`, `mini54_*` 프로필은 보존 (사용자 호환성).

### Fixed

- **`fix(tfx-route)` (#153)** preflight 정규식이 dotted server 이름 허용 (83b03fb) — `_mcp_preflight_filter_dead` 의 candidate 추출 정규식이 `[^.]+` 로 첫 dot 에서 끊어, `[mcp_servers.foo.bar]` 같은 dotted 서버는 probe/filter 대상에서 통째로 누락되던 문제. `(.+)\.enabled=true$` 로 변경해 end anchor 활용한 정확한 캡처. mcp-health.mjs 파서 (`[a-zA-Z0-9_.-]+`) 와 일관성 회복. drop 루프는 이미 prefix 매칭이라 dead 이름 그대로 받아 모든 override 제거.
- **`fix(mcp-health)` (#149, #154)** binary fingerprint cache key + atomic cache write (02b792d) — (#149) 기존 cache 가 configMtime + TTL 만으로 fresh 판정해 `npm i -g <mcp-bin>` 설치/제거를 5분간 감지 못하던 문제. 서버별 fingerprint (resolved binary path+mtime+size 또는 url) 을 cache 에 포함하고 일치할 때만 hit 으로 판정. legacy cache (fingerprint 없음) 는 stale → 자동 migration. (#154) `writeCache` 가 비원자적 `writeFileSync` 라 swarm/병렬 실행 시 reader 가 partial JSON → null 받아 cache 효용 손실. tmp (`pid.timestamp` 이름) + `renameSync` atomic write 로 변경.
- **`fix(tfx-route)` (#148)** all-dead preflight 조기 실패 (50ec35f) — profile-allowed MCP 가 전부 dead 일 때 BUG-H (#132) fail-safe 가 swap 을 skip → 원본 config.toml 전체가 Codex 에 전달되어 비필요 MCP 다수까지 spawn 되는 역효과. preflight 끝에서 남은 `enabled=true` 개수 검사 → 0 이면 `exit 78` 조기 실패. opt-in escape: `TFX_MCP_ALLOW_ALL_DEAD=1`.
- **`fix(mcp-sync)` (#152)** support root-level `.mcp.json` alongside `.claude/mcp.json` (657771a) — Claude Code 는 두 경로 모두 읽지만 과거 sync 는 `.claude/mcp.json` 만 처리해 root-only 레이아웃 (research-fold7-terminal 등) 은 sync 가 작동하지 않았음. 이제 둘 다 처리.
- **`fix(mcp-health)`** tighten preflight accuracy — multiline TOML args + HTTP validation (1f8d508) — (A1) 멀티라인 array 값 (`args = [\n  "run",\n  "server.js"\n]`) 을 single-line 파서가 `"["` 문자열로 오인해 정상 서버를 dead 로 오탐. bracket depth tracker 로 `]` 까지 누적해 array 로 파싱. (A2) HTTP probe 가 status 2xx-4xx 전부 alive 로 취급해 404/401 HTML 페이지를 healthy 로 오판. 200 + JSON-RPC envelope (id 일치, result|error 존재) 둘 다 검증.
- **`fix(mcp-sync)`** project mcp.json type 필드도 rewrite (legacy url→http) (50b5f0d) — Claude Code 현재 스키마는 `type: "http"` 만 허용. 과거 `type: "url"` 는 parse 실패로 MCP 전체 단절. url 일치만으로 skip 하면 legacy 가 영원히 안 고쳐지던 문제. 이제 type 필드도 함께 rewrite.
- **`fix(tfx-route)`** preflight env + codex MCP exec fallback (923aa1a) — preflight env 변수 누락 + codex MCP exec fallback 경로 보강.

### Tests

- **`test(sync-hub-mcp-settings)` (#155)** 부분 실패 격리 + 2회 idempotent regression (4b643e0) — `syncProjectMcpJson` 이 `.claude/mcp.json` 과 `.mcp.json` 두 경로를 for-of 루프 + per-file try/catch 로 처리하는 격리 동작과 2회 연속 idempotent 동작을 회귀 방어 테스트로 고정. (case 7) 한 경로 invalid JSON 이어도 다른 경로 정상 처리, (case 8) 두 경로 모두 canonical 상태에서 연속 호출 시 byte-for-byte 동일.

## [10.13.10] - 2026-04-23

### Changed

- **`chore(#112)`** Legacy alias deprecation logging 표준화 — Phase 5 (v11) 물리 삭제 게이트 활성화. 11개 DEPRECATED alias (tfx-autopilot / tfx-consensus / tfx-debate / tfx-fullcycle / tfx-multi / tfx-panel / tfx-persist / tfx-swarm / tfx-remote-setup / tfx-remote-spawn / tfx-psmux-rules) SKILL.md 에 **실행 가능한 bash 블록** 을 일관된 형식으로 주입: (1) stderr 에 `[deprecated] {name} -> use: {canonical}` 경고, (2) stdout 에 `[DEPRECATED] {name} — see {canonical}` 마커, (3) `.omc/state/alias-usage.log` 에 `ISO8601 {name} -> {canonical}` append (mkdir -p 선행). 이전에는 consensus/debate/panel 3개만 textual 3단계 절차를 가졌고 bash 실행문이 없었음. 나머지 8개는 stderr 경고 한 줄만 있거나 logging 규약 자체가 부재 → Phase 5 zero-usage 게이트가 측정 불가능한 상태였다. 이제 11개 전부 동일 패턴 + 측정 가능. 7일 누적 `alias-usage.log` 가 zero 이면 해당 alias 파일 물리 삭제 가능.

### Tests

- **+55** `tests/unit/legacy-alias-logging.test.mjs` (신규) — 11개 legacy SKILL.md 각각 5개 assertion (alias-usage.log append / stderr [deprecated] echo / stdout [DEPRECATED] marker echo / canonical entrypoint 언급 / mkdir -p .omc/state 선행). 회귀 시 Phase 5 게이트가 끊기는 것을 즉시 감지.

## [10.13.9] - 2026-04-23

### Fixed

- **`fix(cli)`** `tfx swarm run <prd>` alias + `tfx --help` Commands 블록 누락 (#109) — v10.13.7 에서 `tfx swarm --help` sub-help 와 `tfx swarm` 한 줄 surface 는 추가했으나 (1) `tfx swarm run <prd>` verb alias 가 여전히 `run` 을 PRD 경로로 해석하고 (`PRD file not found: .../run`), (2) `tfx --help` Commands 블록에 `synapse` / `why` 가 누락된 채로 남아있던 3증상 중 2증상 잔존. `bin/triflux.mjs` swarm dispatch 에 `if (sub === "run") cmdSwarmRun(cmdArgs.slice(1))` 분기 추가 + `CLI_COMMAND_SCHEMAS.swarm.subcommands.run` 문서화 + sub-help Subcommands 블록 맨 위에 `tfx swarm run <prd>` 렌더 + Commands 블록에 `tfx synapse` / `tfx why` 두 줄 추가. `tfx swarm` 설명도 `(run/plan/list)` 힌트 포함.

### Tests

- **+3** `tests/unit/triflux-help-output.test.mjs` — Commands 블록 `tfx synapse` / `tfx why` 검증 2건 + sub-help `tfx swarm run` 검증 1건. 5/5 pass.

## [10.13.8] - 2026-04-22

### Fixed

- **`fix(swarm)`** `tfx swarm` non-TTY background hang (#116-C) — `run_in_background`, nohup, CI 러너 등 stdout/stdin 둘 다 non-TTY 환경에서 `cmdSwarmRun` 이 planning 까지만 성공하고 codex worker spawn 단계에서 무한 hang 하던 경로 (umbrella #116 의 마지막 sub-issue, v10.13.7 까지 잔존). `hub/team/swarm-cli.mjs` 에 pure function `assertTtyForSwarm()` 을 신설하고 `cmdSwarmRun` 의 planning 직후 / `hyper.launch()` 직전 gate 로 호출. non-TTY 감지 시 즉시 throw + 복구 경로 3안 안내 (터미널 직접 실행 / `tfx multi --teammate-mode tmux` / `TFX_ALLOW_NON_TTY_SWARM=1` opt-in). opt-in 경로는 경고만 출력하고 기존 launch 흐름 유지. `--dry-run` / `cmdSwarmPlan` 은 gate 이전에 return 하므로 영향 없음.

### Tests

- **+5** `tests/unit/swarm-cli.test.mjs` — `assertTtyForSwarm` pure function 커버리지 (stdout TTY pass / stdin TTY pass / 양측 non-TTY fail with #116-C guidance / opt-in env `=1` pass + warn / opt-in env 비 `1` 값은 fail). swarm-cli 전체 10/10 pass.

## [10.13.7] - 2026-04-22

### Fixed

- **`fix(hud)`** `buildContextUsageView` limit priority regression — stdin 이 명시한 `context_window_size` 가 modelHint fallback (DEFAULT 200K) 에 의해 override 되어 `600/1K (60%)` 기대값 대신 `600/200K (0%)` 로 떨어지던 lake4-integration 실패. stdin > (modelId present ? `Math.max(monitor,hint)` : `monitor||hint`) 우선순위로 재정렬. Opus 4.7 warn/critical 분류가 modelHint 우선 로직에 의존하므로 modelId 존재 여부로 분기 (opus-duplicate-status 3 cases + lake4-integration 2 cases 동시 만족). `hud/context-monitor.mjs` + packages mirror.
- **`fix(release)`** `prepare.mjs` preflight stale test-lock cleanup — 이전 `release:prepare` 실행이 남긴 `.test-lock/pid.lock` 으로 인한 반복 실패 (MEMORY `feedback_test_lock_stale.md` 재확인, v10.13.6 ship 시 수동 `rm -f` 우회 필요했던 패턴). `prepareRelease()` 진입 직후 exported `cleanupStaleTestLock()` 호출로 lockfile 자동 제거. `rmSync` 실패 시 warn fallback (prepare 진행은 유지). `scripts/release/prepare.mjs` + packages mirror.

### Added

- **`feat(cli)`** `tfx swarm` CLI help surface (#109) — `tfx --help` Commands 섹션에 `tfx swarm` 한 줄 노출 + `tfx swarm --help` / `tfx swarm help` sub-help 렌더링 (description / usage / subcommands / options 를 `CLI_COMMAND_SCHEMAS.swarm` 스키마 기반으로 출력). `checkHubRunning()` 이전에 help 분기를 두어 hub 미실행 환경에서도 help 접근 가능. `bin/triflux.mjs` + packages mirror.

### Chore

- **`chore(gitignore)`** `tests/.tmp-setup-version-cache/` 추가 — setup-version cache 테스트 부산물이 매 실행마다 untracked 로 잡히던 노이즈 제거.

### Tests

- **+2** `tests/unit/hud-context-view.test.mjs` (신규) — stdin limit > modelHint 우선순위 회귀 케이스 2건
- **+1** `tests/unit/release-prepare-testlock.test.mjs` (신규) — stale lock preflight cleanup 검증
- **+2** `tests/unit/triflux-help-output.test.mjs` (신규) — `tfx --help` swarm surface + `tfx swarm --help` sub-help 검증

### Housekeeping

- GitHub 이슈 정리 (6건 closed): **#66** (Codex exec non-TTY stall, 24b7229 + `scripts/tfx-route.sh` MCP approval auto-swap 로 해결), **#110** (swarm-hypervisor 2 hang, v10.10.0 mock conductor 보강), **#111** (swarm shard blind run, `hub/team/swarm-cli.mjs` 이벤트 핸들러 구현), **#114** (teammate-mode non-TTY codex 즉시 종료, e0eeba0 `resolveEffectiveMode()` auto-fallback to headless), **#121** (workdir-dependent codex config delta, triflux side 감지 완료 + 수정은 codex/oh-my-codex upstream scope), **#122** (MCP approval drift, #66 duplicate). umbrella **#116** 은 sub-issue 전이 노트 추가 + #116-C (bg hang) 1건만 open 유지.

## [10.13.6] - 2026-04-22

### Fixed

- **`fix(hud)`** `parseClaudeUsageResponse` — Claude OAuth Usage API 응답에서 `five_hour` 또는 `seven_day` 키 자체가 부재할 때 `?? 0` 으로 collapse 되어 `fiveHourPercent: 0` 으로 표시되던 결함. utilization=null (사용량 없음) 과 키 부재 (API 응답 이상) 가 구분 안 돼 가짜 0% 가 표시됨. 키 존재 여부를 따로 검사해 부재 시 `null` 반환 → HUD 렌더러가 `--%` placeholder 표시. utilization=null 인 정상 케이스는 기존대로 0% 유지. `hud/providers/claude.mjs` + packages mirror.
- **`fix(hud)`** Codex `classifyBucket` weekly window 임계 — `>= 1440min(24h)` 의 헐거운 lower bound 가 향후 24h/48h 등 중간 버킷 도입 시 모두 weekly 로 silent 오분류할 위험. 10080min(7d) 외 단일 weekly 값을 emit 하지 않는 현재 Codex 동작에 맞춰 `>= 7000min(~5d)` 로 좁힘. 알 수 없는 shape 는 `null` (미분류) 로 떨어져 slot 오할당 차단. `hud/providers/codex.mjs` + packages mirror.

### Tests

- **+6** `tests/unit/hud-claude-parse.test.mjs` (신규) — 키 부재 vs utilization=null vs clamping 6 케이스
- **+2** `tests/unit/hud-codex-bucket.test.mjs` — 7000min lower bound + 1440min/6999min rejection (1440min weekly assertion 제거)

## [10.13.5] - 2026-04-22

### Fixed

- **`fix(tfx-route)`** STALL_KILL orphan child — `heartbeat_monitor` 가 SIGTERM 으로 wrapper(bash) 를 종료한 뒤 `kill -0 $pid` 가 false 면 `taskkill /T /F` 분기를 skip 해 Codex 자식 프로세스가 별도 Win32 process 로 **orphan 생존**하던 결함. 사용자 보고(2026-04-22 세션): "tfx-route 래퍼 프로세스 exit 이후에도 실제 Codex 자식은 계속 running, stderr 191KB 까지 누적". SIGTERM 이전에 `_find_fork_pids` 로 자식 PID 스냅샷을 떠놓고, wrapper 정리 후 orphan sweep 루프로 살아있는 자식을 taskkill /T /F (Windows) / kill -KILL (POSIX) 로 tree kill. `scripts/tfx-route.sh` + packages mirror 동시 갱신.
- **`fix(hud)`** `advanceToNextCycle` exact-cycle boundary glitch — `elapsed` 가 `cycleMs` 의 정수배일 때 `Math.ceil(elapsed/cycleMs)*cycleMs` 가 `target=now` 를 반환해 `diff=0` → `formatResetRemaining*` 이 빈 문자열 → HUD 5h/1w 컬럼이 정확한 reset 순간에 `n/a` 로 깜빡이던 결함. `Math.floor(elapsed/cycleMs)+1` 로 항상 다음 사이클을 가리키도록 교정. 5h 경계 `5h00m`, 7d 경계 `07d00h`, 1d Gemini 경계 동일 적용. `hud/utils.mjs` + packages mirror 동시 갱신.

### Removed

- **`chore(hud)`** dead alias 제거 (`hud/constants.mjs`) — `PLUGIN_USAGE_CACHE_PATH` 와 `CLAUDE_USAGE_STALE_MS_WITH_PLUGIN` 은 외부 import 0건의 `OMC_*` alias source 역할만. 정의 직접 인라인하고 base 이름 삭제. 동작 변경 없음.

### Tests

- **+1** `tests/unit/tfx-route-stall-kill.test.mjs` — "STALL_KILL 은 SIGTERM 전에 자식 PID 를 스냅샷하고 orphan sweep 을 수행한다" shape 테스트. `_stall_children=$(_find_fork_pids ...)` snapshot 라인 + `orphan children detected` 로그 + `for _cpid in $_orphan_alive` tree kill 루프 회귀 가드.
- **+1** `tests/unit/hud-utils.test.mjs` — `advanceToNextCycle returns next reset (not now) at exact cycle boundary` 회귀 테스트. exact 5h / exact 7d / 2*5h / 1ms past boundary 4 케이스 커버.

## [10.13.3] - 2026-04-22

### Fixed

- **`fix(tfx-route-worker)`** misleading "hub unavailable" warning — `resolveDefaultMcpConfig` 가 cwd 에 `.claude/mcp.json` / `.mcp.json` 가 없을 때 찍던 `warning: no MCP config found, hub unavailable` 메시지가 실제로는 **프로젝트 MCP binding 부재**만을 뜻하는데도 hub server death 로 오독되어 "허브가 죽었다" 오진 유발. 다중 프로젝트 병렬 세션에서 특히 재현. 메시지를 `warning: no project MCP config in cwd — hub status unaffected` 로 교체해 실제 조건(cwd config 부재)과 영향 범위(hub 무관)를 명시. `scripts/tfx-route-worker.mjs` + mirror 동시 갱신.

## [10.13.2] - 2026-04-21

### Fixed

- **[#144]** `fix(#144): doctor auto-fix gap — stale skills recursive + mcp url sync + psmux guidance + TTL` — `triflux doctor --fix` / `tfx update` 가 안내한 대로 자동 해결하지 않던 4개 gap. 근본 원인은 `cleanupStaleSkills()` 가 top-level 파일만 `unlinkSync` 하고 nested directory 를 재귀 삭제하지 않아 `tfx-deep-*` / `tfx-codex-swarm` 같은 과거 잔재가 영구 감지되는 UX bug. (1) `rmSync({recursive:true, force:true})` 로 교체. (2) `--fix` 모드에서 `tfx-hub` URL 불일치 감지 시 `syncHubMcpSettings` + `syncProjectMcpJson` 자동 호출. (3) psmux detach-client 미지원 메시지에 영향(WT 1.24 ConPTY race) + 해결(psmux v3.4+ 업그레이드) + 업그레이드 명령 명시. (4) cli-issues 7일 TTL — stale 항목 `[STALE]` INFO downgrade + issues++ 제외, `--purge-logs` 플래그로 물리 삭제. Codex review FIX_FIRST 2 P2 (log single-write, mismatch deduct) 반영. (`6700597`)
- **`fix(tfx-route)`** stale `config.toml.pre-exec` cleanup + heartbeat `STALL_KILL` — Session 17 에서 `/tfx-auto --cli codex` 2회 연속 `output=0B` stall (900s timeout 대기) 근본 해결. (1) `_codex_config_swap` 에 owner-PID marker (`kill -0` 기반) stale detection 추가, stale 감지 시 backup → config 원본 복원 선행 (backup-loss guard). (2) `heartbeat_monitor` 에 `TFX_STALL_KILL` + `TFX_STALL_KILL_GRACE` 환경변수 기반 SIGTERM → 5s → SIGKILL/taskkill (MINGW/MSYS 경로 포함). Codex review FIX_FIRST P1 mtime 오탐 + P2 backup loss + P2 Windows taskkill 반영. (`24b7229`)

### Tests

- **+4** `scripts/__tests__/setup-cleanup-stale-skills.test.mjs` — #144 재귀 삭제 회귀 방지 (nested dir / top-level only / SKILL_ALIASES 보존 / tfx- prefix 필터)
- **+10** `tests/unit/tfx-route-config-swap.test.mjs` + `tests/unit/tfx-route-stall-kill.test.mjs` — #145 owner-PID cleanup 6건 + STALL_KILL shape 3건 + integration 1건 (실제 child ~4.5s SIGTERM)

### Docs

- `.omc/artifacts/session-17-plan-20260421-130921.md` — 세션 17 미해결 이슈 전수조사 + Batch A~G 착수 순서 + upstream link-only close 판단 기록.

### Issue closed

- **[#144]** doctor auto-fix gap (PR #146 merge)

## [10.13.1] - 2026-04-21

### Fixed

- **[#118]** `fix(#118): codex killed before HANDOFF flush` — BUG-A P0. `tfx multi --teammate-mode headless` 에서 codex timeout kill 시 `.txt` 미생성 + HANDOFF 유실로 인한 silent loss 해소. 3 fix 지점: default `timeoutSec` 300→900, `.partial` capture-pane persist (stallDetect + else 경로 양쪽), `readResult` fallback chain 확장 (`.partial` → `[partial]` prefix → `.err` → capture-pane). Codex R1 HIGH 대응으로 `cleanStaleResultArtifacts` 추가 (resultFile 경로 재사용 시 이전 run `.partial` 오인 차단), R2 MEDIUM 대응으로 `rmSync` 에러 핸들링 세분화 (ENOENT silent / 기타 retry + warn). 2R codex review 수렴. (`c0b59f1`)
- **`fix(config)`** permanent guard against codex `config.toml` reset — `~/.codex/config.toml` 이 세션 시작마다 축소되던 2 경로 근본 해결. (1) `scripts/setup.mjs` `REQUIRED_CODEX_PROFILES` 3→11 확장 (gpt54/mini54/codex53_med/spark53_med 추가), `REQUIRED_TOP_LEVEL_SETTINGS` 상수로 top-level `model`/`service_tier` missing 시 주입 (기존 값 preserve). (2) `scripts/tfx-route.sh` `_codex_config_swap` awk 필터 결과 size validation (<100 bytes 전면 skip, <500 bytes swap 거부, <30% post-filter 거부) + tmp atomic mv. (`ea13d90`)

### Tests

- **+12** `tests/unit/headless-118-timeout-partial.test.mjs` — #118 3 fix 지점 + R1/R2 review 대응 (stale cleanup / real readResult / non-ENOENT rmSync)
- **+24** `tests/unit/setup-codex-profiles.test.mjs` — `REQUIRED_CODEX_PROFILES` / `REQUIRED_TOP_LEVEL_SETTINGS` / top-level region detection / size guard 커버리지

### Docs

- `ROADMAP.md` — 세션 7 이후 9 세션 drift catch-up. 세션 8~16 단일 블록 압축 기록 (13 PR + 3 close + v10.13.0 release + BUG-A 해소 요약). (`93b2d74`)

### Issue closed

- **[#108]** Windows cmd quoting (mechanical, #108 fix 체인 full chain landed)
- **[#115]** swarm 5중 결함 (mechanical, Lane 1/2 + #126/127/128 full chain landed)
- **[#118]** BUG-A P0 codex timeout kill (PR #142 merge)

## [10.13.0] - 2026-04-21

### Added

- **[#125]** `feat(team): sentinel-framed completion payload` — `<<<TFX_COMPLETION_BEGIN/END>>>` sentinel framing via `sentinel-capture.mjs` + `build-worker-prompt.mjs` helpers. overflow guard + standalone-line matching. 세션 6 Codex R1 REQUEST_CHANGES → R2 APPROVE 로 수렴
- **[#138]** `feat(review): tfx review --shard per-file for oversized diffs` — 32KB 초과 diff 에서도 per-file Codex 리뷰 가능. shard 별 순차 실행 (계정 broker 충돌 방지), `[i/N] reviewing <file>` stderr 진행 표시, 32KB 초과 개별 파일은 per-file gate 에서 skip

### Fixed

- **[#115]** harden completion payload extraction per Codex cross-review — head-truncation coverage + assertion tightening (3-round review 수렴)
- **[#126]** `fix(team): surface swarm integration failure in CLI summary` — integration_failures + exit code 반영으로 silent loss 표면화
- **[#127]** `fix(team): cherry-pick + restore HEAD in swarm integration` — BUG-E originalBranch finally restore 로 caller branch HEAD escape 방지
- **[#128]** `fix(team): bypass cmd /c for npm-cmd-shim CLIs` — Windows `.cmd` shim 을 node `.js` 로 unwrap + 직접 spawn (BUG-A). 다중 줄 / fenced 프롬프트 mangling 해제
- **[#130]** `fix(swarm): F7 validator rejects status=failed worker payload` — validator tighten, schema 유지. fail 상태 silent success 가짜 통과 차단 (BUG-G)
- **[#133]** `fix(tfx-route): BUG-H _codex_config_swap fail-safe + doctor orphan cleanup` — async tfx-route 경로에서 MCP inventory 캐시 empty 일 때 codex config `[mcp_servers.*]` 전부 삭제되는 회귀 차단. `tfx doctor --fix` 가 cache orphan 자동 정리
- **[#134]** `fix(swarm): BUG-I worktree intentional deletions vs F6 no_commit_guard` — 워커가 의도적으로 파일을 지운 경우 F6 guard false-positive 방지
- **[#135]** `fix(swarm): BUG-J rebase catch block must not rewind caller branch` — `rebaseShardOntoIntegration` 실패 경로에서 caller branch HEAD 유지 (finally restore)
- **[#136]** `fix(release): packages/triflux full mirror + tfx review subcommand` — 배포 미러 gap 해소 + `tfx review` CLI 서브커맨드 추가
- **[#137]** `fix(review): 32KB prompt size gate + helper hardening` — review 대상 diff 가 32KB 초과 시 안전 truncate + per-file shard opt-in 안내
- **[#139]** `fix(setup): recursive hub/workers/**/*.mjs sync` — top-level 만 스캔하던 `scanHubWorkerFiles` 를 재귀 walk 로 교체. `codex-app-server-worker.mjs` 가 의존하는 `lib/jsonrpc-stdio.mjs` 복구
- **[#140]** `fix(gemini): add --yolo to GeminiBackend` — headless silent-hang 방지. stdin redirect 만으로는 tool-approval 대기에서 풀리지 않음. `buildGeminiCommand` pure helper + Windows/Unix 양 분기 test 커버
- **[#141]** `fix(session-15): packages/remote --yolo + drop stale tfx-autoresearch SKILL test + routing-qa assertion + packages/remote mirror contract tests` — #140 mirror 공백 해소 (packages/remote 별도 패키지) + Phase 5 cleanup 이후 남은 stale SKILL test 제거 + routing-qa assertion 동기화 + structural contract 5 invariants

### Tests

- **[#115]** completion payload 캡처 truncation 커버리지 강화 (`5a69534`, `c12ff01`)
- **[#140]** `buildGeminiCommand` pure helper 양 플랫폼 분기 test +4
- **[#141]** packages/remote mirror contract test +5 (buildGeminiCommand export / Windows --yolo / Unix --yolo / wrapper 패턴 / Codex+ClaudeBackend 존재)
- 전체 unit suite 2307/2310 pass (swarm-hypervisor #110 기존 hang 2건은 exclude, 3 skipped)

### Docs

- roadmap session 6~9 업데이트 (`f31925a`, `7f47807`, `4077c00`)

## [10.12.0] - 2026-04-18

### Added — Phase 4: ensemble fold + remote consolidate

- **Phase 4a** `skills/tfx-auto/SKILL.md` 에 `--shape {consensus|debate|panel}` 플래그 추가 — `--mode consensus` 의 출력 shape + orchestration policy 분기. `hub/team/consensus-meta.mjs` 신규 (표준 `meta_judgment` 스키마 유틸: severity_classification/consensus_vs_dispute/recommended_action/followup_issues). `tfx-debate`/`tfx-consensus`/`tfx-panel` 3 스킬 thin alias 축소
- **Phase 4b** `skills/tfx-remote/SKILL.md` 신설 — 기존 `tfx-remote-setup` + `tfx-remote-spawn` 2스킬을 단일 subcommand 인터페이스로 축소 (setup/spawn/list/attach/send/resume/kill/probe). `hub/lib/hosts-compat.mjs` 신규 — hosts.json v1/v2 호환 adapter (safety-guard/ssh-command 기존 소비자 보존)
- **Phase 4b** `skills/tfx-psmux-rules` → `.claude/rules/tfx-psmux.md` 이관 + `AGENTS.md` 복제 (Codex `@import` 미지원 대응). 스킬 → 강제 규약 재분류

### Changed

- `.claude/rules/tfx-routing.md` — ensemble/debate/consensus/panel 자연어 라우팅을 `tfx-auto --mode consensus --shape …` 로 통합
- legacy alias 6개 (tfx-debate, tfx-consensus, tfx-panel, tfx-remote-setup, tfx-remote-spawn, tfx-psmux-rules) stderr 경고 + stdout `[DEPRECATED]` 마커 + `.omc/state/alias-usage.log` append 규약 적용
- `README.md` + `README.ko.md` — 스킬 수 badge (42 → 21 core + 23 aliases) + Phase 3/4 플래그 본문 반영 + `tfx-remote` 통합 예시
- Unreleased 점검 기준 Phase 4 커밋 5건 중 실제 기능 변경 4건 (`7885c5f`, `498a5f7`, `005c22c`, `0724fe1`) 반영 확인. `c28e102` 는 본 changelog 동기화 커밋

### Fixed

- `scripts/sync-hub-mcp-settings.mjs` — tfx-hub 엔트리에 `type:"http"` 자동 백필 + 검증. Claude Code MCP schema violation 회귀 방지 (user `.claude.json`, project `.mcp.json`, `.gemini/settings.json` 공통)
- `tests/unit/sync-hub-mcp-settings.test.mjs` — type 백필 로직 반영 (case 2/8)

## [10.11.0] - 2026-04-18

### Added — Phase 3: true ralph / auto-escalate / --lead (#112)

- **[#112 Phase 3 Step A]** `hub/team/retry-state-machine.mjs` — true ralph + auto-escalate 상태 머신. 3 모드 (bounded/ralph/auto-escalate), stuck detector (동일 failureReason 3회 중단), 4단계 escalation 체인 (codex:gpt-5-mini → codex:gpt-5 → claude:sonnet-4-6 → claude:opus-4-7), EventEmitter on("transition") 연동 (retry-state-machine.test.mjs 12건)
- **[#112 Phase 3 Step B]** `hub/lib/tfx-route-args.mjs` — tfx-auto ARGUMENTS 파서. Phase 3 신규 플래그 3개 (`--lead {claude|codex}`, `--no-claude-native`, `--max-iterations <N>`) + `--retry` 값 확장 (`ralph`, `auto-escalate`) + 조합 validation (`--parallel 1 + --isolation worktree` force none, `--remote + non-swarm` warn) + `--flag=value` 및 `--flag value` 두 형태 지원 (tfx-route-args.test.mjs 16건)
- **[#112 Phase 3 Step C2]** `hub/bridge.mjs retry-run` / `retry-status` 서브커맨드 — multi-process safe state machine bridge. snapshot JSON 파일을 통해 Claude orchestration 이 매 iteration 마다 state 조회/전이. serialize/applySnapshot round-trip + loadSnapshot/saveSnapshot 파일 I/O + version gate (v1) (bridge-retry.test.mjs 3건, retry-state-machine round-trip 4건)
- **[#112 Phase 3 Step D]** `.claude/rules/tfx-escalation-chain.md` 신규 — DEFAULT_ESCALATION_CHAIN 4단계 규약 + 프로젝트 override (`.triflux/config/escalation-chain.json`). `.gitignore` 에 `!.claude/rules/*.md` 예외 추가 — 기존 `tfx-routing.md` / `tfx-execution-skill-map.md` / `tfx-update-logic.md` 3파일도 함께 tracked (Phase 2 source/installed drift 해결)
- **[#112 Phase 3 Step E]** `skills/tfx-auto/SKILL.md` 본문 복원 — PRE-CONTEXT GATE / STATE & ARTIFACT CONTRACT / CLEANUP & CANCEL RULES + Retry state machine 계약 + Codex lead 계약 섹션 추가 (+61 줄). `skills/tfx-interview/SKILL.md` 에 딥인터뷰 트리거 키워드 (`deep-interview`, `딥인터뷰`, `소크라테스`, `깊이 탐색`, `요구사항 분석`) 흡수 + Stage 1~4 질문 템플릿 fallback (+39 줄). Phase 2 Step B thin alias 축소 시 유실된 규칙 본체 이관 완결
- **[#112 Phase 3 Step F]** integration 테스트 2건 — ralph compaction survive (5 iteration 독립 프로세스 counter 유지, snapshot 외부 수정 후 복원, DONE idempotent resume), auto-escalate chain (체인 2단계 전이, 끝까지 소진 BUDGET_EXCEEDED, 중간 verify-success DONE, stuck 은 체인과 독립)

### Changed

- **[#112 Phase 3 Step C1]** `skills/tfx-auto/SKILL.md` 플래그 오버라이드 테이블 5줄 추가 (`--retry ralph`/`auto-escalate`, `--lead claude|codex`, `--no-claude-native`, `--max-iterations N`). Legacy 매핑 3건 갱신:
  - `tfx-autoroute`: `--cli auto --retry 1` → `--retry auto-escalate`
  - `tfx-persist`: `--mode deep --retry ralph` (⚠ degrade) → `--retry ralph` (Phase 3 unlimited)
  - `tfx-auto-codex`: `--cli codex + env` → `--cli codex --lead codex --no-claude-native`
- **[#112 Phase 3 Step C1]** 3 thin alias 본문 재작성 (`tfx-auto-codex`, `tfx-persist`, `tfx-autoroute`) — Phase 3 플래그로 "완전 표현" 됨을 반영. `tfx-persist` 는 state machine 전이 다이어그램 + `.omc/state/retry-<sid>.json` 복원 경로 명시, `tfx-autoroute` 는 DEFAULT_ESCALATION_CHAIN 4단계 + `.claude/rules/tfx-escalation-chain.md` override crosslink
- **[#112 Phase 3 Step D]** `.claude/rules/tfx-routing.md` "깊이 수정자" 표 — "반복" → `--retry ralph` 매핑, "승격" 신규 행 추가 (`--retry auto-escalate`). `.claude/rules/tfx-execution-skill-map.md` 에 "Retry 정책 (Phase 3+)" 섹션 추가

### Fixed

- **[#113]** `claudemd-sync` `ensureTfxSection` 가드 추가 — 인접 `.claude/rules/tfx-routing.md` 존재 시 inline `<routing>` 주입 skip, 기존 inline 블록은 제거 (action: "removed"). SessionStart 훅의 `setup.runDeferred` 가 매 세션마다 CLAUDE.md 에 74줄 주입하던 회귀 종결. Phase 2 Step A 의 "rules 분리 = source of truth" 의도와 일치. 회귀 테스트 2건 추가
- **[hud]** `buildContextUsageView` 에서 monitor.limitTokens 가 modelHintLimit 과 `Math.max()` 비교로 explicit snapshot(1K) 이 모델 기본(200K) 에 덮이던 회귀 — monitor snapshot 이 제공되면 explicit 데이터 우선. `#88` 모델 ID 기반 컨텍스트 추정의 부작용 수정. lake4-integration.test.mjs "buildContextUsageView" 통과
- **[synapse]** `/synapse/heartbeat` 핸들러가 body 를 `{ sessionId, ...partial }` 로 rest 분해해서 `partial = { partial: {...} }` 이중 포장 → `registry.heartbeat` 의 `partialMeta.branch` 등 전부 undefined → 업데이트 무시. `{ sessionId, partial } = body` 로 직접 구조분해. hub-server.test.mjs "세션 등록, heartbeat 갱신, 해제" 통과
- **[lint]** biome 2.4.10 drift 일괄 정리 — `noUnusedImports` / `noUnusedVariables` / `useOptionalChain` 17파일. `String.raw` (Windows path) 보존 검증. 기존 pre-existing 30 test fail 은 `{ todo: ... }` 마커로 전환 후 Step E 에서 복원
- **[packages]** `pack.mjs` 미러 동기화 — 02dd3aa lint drift 17파일 + #108 체인 마지막 (49e0979) 이후 누락된 `codex-app-server-worker.mjs` sha256 복원. packages-sync PRD-4 gate 2건 pass
- **[test]** `safety-guard-psmux.test.mjs` cwd/env 격리 — `.claude/cleanup-bypass` 로컬 우회 마커가 테스트 cwd 에 있으면 runGuard 가 통과로 오판. `cwd: tmpdir()` + `TFX_CLEANUP_BYPASS` env 제거 + 가드 스크립트 절대경로 해석으로 격리
- **[claudemd-sync]** `.claude/rules/tfx-routing.md` 를 source of truth 로 — Phase 2 Step A 이후 CLAUDE.md 에서 `<routing>` 태그가 없어 "routing section not found" 5건 fail. `getLatestRoutingTable()` 가 새 source 먼저 읽고 CLAUDE.md 인라인/heading 은 legacy fallback 유지
- **[skill-drift]** skill-drift.test.mjs 17 todo + deep-interview.test.mjs 3 todo = 20건 전부 복원 (Phase 3 Step E). 검증 대상 본체 이동 (tfx-multi → tfx-auto) + 누락 규칙 본체 복원 (tfx-interview/tfx-research/tfx-auto) 조합

### Tests

- **[#113]** `claudemd-sync.test.mjs` — rules file 가드 skip / inline cleanup 2건 신규
- **[Phase 3 Step E]** `skill-drift.test.mjs` + `deep-interview.test.mjs` todo 20건 전부 pass 전환

## [10.10.0] - 2026-04-18

### Added
- **[#112 Phase 2 Step A]** `tfx-auto` 플래그 오버라이드 front door — `--cli {auto|codex|gemini|claude}`, `--mode {quick|deep|consensus}`, `--parallel {1|N|swarm}`, `--retry {0|1|ralph}`, `--isolation {none|worktree}`, `--remote <host>` 플래그로 11개 legacy 실행 스킬의 단일 진입점 제공
- **[skill]** `tfx-ship` 신규 — triflux 전용 릴리즈 자동화. 기존 `scripts/release/*` 래퍼 + AskUserQuestion 기반 버전 선택 + CHANGELOG 편집 게이트. Co-Authored-By / AI trailer 하드 차단. `--skip-tests` / `--no-publish` / `--dry-run` 플래그 지원
- **[hook]** tfx-ship 매직 키워드 자동 라우팅 — `배포`, `릴리즈`, `릴리스`, `release`, `publish`, `쉽하자`, `tfx-ship`, `/ship` 등 자연어 감지 시 `tfx-ship` 스킬 자동 invoke (`hooks/keyword-rules.json`)

### Changed
- **[#112 Phase 2 Step B]** 9개 legacy 실행 스킬을 `tfx-auto` thin alias 로 축소 (backward compatible, muscle memory 보존). 본문 100~286줄 → 38~45줄. 각 스킬은 stderr deprecation 경고 후 `/tfx-auto <flags>` 로 리다이렉트. 대상: `tfx-autopilot`, `tfx-autoroute`, `tfx-fullcycle`, `tfx-persist`, `tfx-codex`, `tfx-gemini`, `tfx-auto-codex`, `tfx-multi`, `tfx-swarm`. Phase 5 (v11) 물리 삭제 예정
- **[refactor]** Phase 1 drift migration — 이전 세션에서 `~/.claude/skills/` (installed) 에만 적용된 Phase 1 스킬 통합 12개 파일을 `skills/` (source) 로 복원. 다음 `npm i -g triflux` 에서 자동 동기화 유지

### Fixed — Windows codex spawn 버그 체인 (#108)
- **[#108]** Windows cmd quote bug — `shell: true` + `JSON.stringify` wrap 조합에서 cmd.exe 가 embedded `\"` 를 오파싱 → exit 255 "The filename, directory name, or volume label syntax is incorrect." 증상. args 배열 + `shell: false` 로 dispatch 변경. 회귀 테스트 1건 추가
- **[#108-followup]** swarm-planner 가 빈 prompt shard 를 조기 reject — 누락된 `- prompt: |` 블록으로 인한 silent swarm failure 방지. 에러 메시지에 해당 shard 이름 + `docs/prd/_template.md` 힌트 포함
- **[#108-followup]** Windows `.cmd` resolver fallback — `whichCommand("codex")` 가 extensionless 경로 반환 시 `.cmd`/`.exe`/`.bat`/`.ps1` 순차 탐색. Git Bash 스타일 npm wrapper 대신 Windows batch wrapper 선택
- **[#108-followup]** Windows `.cmd` spawn EINVAL (Node CVE-2024-27980 보안 패치 영향) — `shell: false` 로 `.cmd`/`.bat` spawn 불가. `cmd.exe /c <path>` wrapper 로 우회하면서 `shell: false` 유지 (cmd quote 버그 재발 방지)

### Tests
- **[#110]** `swarm-hypervisor.test.mjs` hang 수정 — mock conductor 가 `sessionConfig.onCompleted` 콜백 체인에 정렬되도록 `ensureWorktree` mock 보강
- 20+ 신규 회귀 테스트 — `execution-mode` Windows `.cmd` fallback 6건, `swarm-planner` empty prompt validation 2건, `conductor` argv dispatch 1건

### Chore
- `pack.mjs` 미러 동기화 (packages/core + packages/triflux + packages/remote)

## [10.9.32] - 2026-04-18

### Fixed
- **[#88]** HUD DEFAULT_CONTEXT_LIMIT 200K 하드코드 → 모델 ID 기반 동적 한도 추정. Opus 4.7/4.6 + Sonnet 4.6 = 1M, [1m] suffix opt-in 지원. stale monitor cache 는 `Math.max(modelHint, cache)` 로 자동 오버라이드
- **[#76]** PreToolUse hook 2배 발화 제거. `scripts/setup.mjs` 가 orchestrator `*` entry 존재 시 직접 등록된 `Bash|Agent` / `Skill` entry 를 prune, orchestrator 부재 시에만 legacy ADD 유지
- **[#77]** Opus 4.7 native progress update 와 triflux info-only 상태 태그 중복 제거. `shouldSuppressInfoOnlyContextStatus` helper 로 60~80% info 구간만 suppress, 80% warn/critical 은 유지
- **[#67]** Windows Codex/MCP 고아 프로세스 누락 수정. `taskkill /T` 로 자식 프로세스 트리 일괄 정리, `hub/team/process-cleanup.mjs` 에 Windows 분기 추가

### Added
- **[#81]** Codex `~/.codex/config.toml` `[mcp_servers.tfx-hub]` url 자동 동기화. `syncCodexHubUrl` TOML 전용 함수 신설, hub/server + hub-ensure 성공 경로에서 JSON/TOML 동시 호출
- **[#90]** `hooks/safety-guard.mjs` 에 Codex PRD 실행 중 main 브랜치 직접 commit 방지 가드. `CODEX_PRD_ACTIVE=1` 환경변수 + branch=main 에서 `git commit` 감지 시 exit 2

### Tests
- **[#91]** hub-quota 비차단성 + 실패 로깅 구조 회귀 테스트 (`tests/integration/hub-quota-nonblocking.test.mjs`)
- **[#92]** synapse debounce (burst 합치기 + 경계 순서 보존) + persist 복구 (정상 flush + 손상 파일 clean start) 회귀 테스트

### Chore
- packages/core, packages/triflux, packages/remote 미러 2회 재동기화 (v10.9.31 수정 + 이번 shards 후)

## [10.9.28] - 2026-04-15

### Fixed
- **[CRITICAL]** synapse heartbeat HTTP 라우트 필드명 불일치 수정 — partial 메타데이터 업데이트 정상 동작
- conductor stdin write-after-end 방지 — writable 체크 추가
- conductor 원격 세션 onCompleted 콜백 누락 수정 — swarm integration 정상 트리거
- packages/remote quota-refresh `Promise.all` → `Promise.allSettled` 동기화 — 단일 계정 실패 시 Hub 크래시 방지
- tui/monitor.mjs wt.exe 직접 spawn fallback 제거 — wt-manager 정책 준수
- packages/triflux 3파일 동기화 (headless, cli-adapter-base, tfx-route.sh)
- plugin.json, marketplace.json 버전 동기화

### Changed
- stale 문서 정리: .omc handoff 35건, docs/ 구버전 문서 삭제
- CHANGELOG v10.9.23-27 누락분 보충

## [10.9.27] - 2026-04-15

### Fixed
- cmd.exe /v:off delayed expansion 비활성화 (보안)
- newline 제거로 명령 주입 방지
- CWD factory 경로 로드 순서 보안 강화

## [10.9.26] - 2026-04-15

### Fixed
- codex exec fallback 제거 — MCP transport 전용으로 전환
- codex-mcp bootstrap timeout 60s → 120s

## [10.9.25] - 2026-04-15

### Fixed
- codex-mcp bootstrap timeout 10s → 60s

## [10.9.24] - 2026-04-15

### Fixed
- gemini-worker Windows .cmd shim spawn ENOENT 복원 (buildSpawnSpec)
- gemini-worker quoteWindowsCmdArg %% 이스케이프 추가
- tfx-route-worker CWD 기반 factory 경로 추가

### Added
- delegator psmux 멀티워커 실행 경로 + MCP executor stall 수정

## [10.9.22] - 2026-04-13

### Fixed
- 테스트 35건 실패 전면 수정 (2428/2429 pass) — constants 누락, regex, async, broker 격리 등 16파일
- Codex MCP stall 근본 수정 — config.toml 원자적 swap으로 비허용 서버 비활성화
- wt.exe --version GUI 다이얼로그 팝업 제거
- env-detect: 쉘 경로/버전/installHint 리팩터 + 레이지 캐싱
- cli-adapter-base: broker null 안전 처리, crash circuit breaker 반영
- cross-review: .omc→.triflux 상태 경로 동기화

### Added
- headless: buildDashboardAttachArgs WT 연결 인자 빌더
- hud renderers: [stale] 마커 지원
- account-broker: _skipPersistence 테스트 격리 옵션

### Changed
- OMC 의존성 분리 + setup.mjs lib 동적 스캔 (18개 자동 동기화)
- Hub idle timeout 기본 비활성화 (영구 실행)

## [10.9.16] - 2026-04-12

### Added
- `/synapse/register`, `/synapse/heartbeat`, `/synapse/unregister` HTTP 엔드포인트
- `synapse-http.mjs` fire-and-forget 헬퍼 — hub HTTP API 호출
- `conductor.mjs` 상태 전이 시 자동 synapse register/heartbeat/unregister (HEALTHY→COMPLETED/DEAD)
- `headless.mjs` runHeadless 워커별 synapse 세션 등록/해제 + 진행 heartbeat
- 단위 테스트: synapse-http, synapse-wiring

### Fixed
- tfx-route.sh: exit 143/137/130 시그널 해석 (SIGTERM/SIGKILL/SIGINT 구분)

## [10.9.15] - 2026-04-12

### Added
- `/synapse/sessions` GET, `/synapse/locks` GET, `/synapse/preflight` POST HTTP 엔드포인트
- synapseEmitter 4개 이벤트 hubLog 리스너 (started, heartbeat, stale, removed)
- preflight op whitelist 검증 (6개 유효 op만 허용, 나머지 400)

### Fixed
- `schedulePersist()` destroyed guard — destroy 후 새 타이머 생성 방지 (callback 내 이중 체크)
- hono + @hono/node-server CVE 2건 패치 (serveStatic path traversal, cookie name validation)

## [10.9.2] - 2026-04-11

### Fixed
- **Hub idle timeout**: Named Pipe 활동이 idle timer를 갱신하지 않아 10분 후 Hub 종료되는 문제 수정
- **Hub startup**: hub-ensure를 DEFERRED → BLOCKING으로 승격하여 세션 시작 전 Hub 준비 보장
- **Hub startup**: 실패 시 code:0 → code:1 반환, 타임아웃 시 code:2 반환
- **Windows spawn**: `cmd.exe /c start /b` → native `detached:true` spawn으로 교체
- **Hub crash recovery**: `unhandledRejection`/`uncaughtException` 핸들러 추가 + PID 파일 정리
- **Health check**: hub-ensure의 `/status` → `/health` 엔드포인트로 state.mjs와 통일
- **Lock staleness**: 락 stale 판정 임계값 3초 → 60초 (느린 시작 시 락 깨짐 방지)
- **global_sync warning**: `global_sync_disabled`는 의도적 비활성이므로 경고 제거

### Changed
- **Codex transport**: `TFX_CODEX_TRANSPORT` 기본값 `exec` → `auto` (MCP 양방향 통신 기본)
- **tfx-auto default**: 기본 모드를 `--quick` → `--thorough`로 전환 (Opus 자동 경량화 포함)

## [10.7.1] - 2026-04-09

### Added
- swarm-planner auto-remote suggestion: hosts.json 기반 원격 호스트 자동 분배 제안
- safety-guard OS-aware SSH: macOS/Linux 대상은 bash 문법 허용, Windows만 차단
- macOS 원격 지원: remote-probe 확장, CLAUDE.md SSH 패턴 OS별 분기

### Fixed
- session-start-fast.mjs `pathToFileURL` 래퍼 추가 — Windows에서 `import(join(...))` 경로 깨짐 수정

## [10.7.0] - 2026-04-09

### Added
- `tfx doctor --diagnose`: 진단 번들(zip) 생성 — spawn-trace JSONL, process report, hook timing, spawn stats, system info 수집
- `spawn-trace.mjs`: child_process 드롭인 래퍼 — JSONL 트레이스, rate limit(10/sec), WT 탭 캡(8), opt-in dedupe
- `session-start-fast.mjs`: SessionStart 6개 훅을 1개 node 프로세스에서 실행 (콜드스타트 7회→1회)
- `context compact nudge`, `config audit`, `coverage threshold` 기능

### Changed
- 5개 SessionStart 훅에 `export run()` 분리 — in-process 실행 지원
- headless, psmux, conductor, wt-manager, remote-spawn, session-spawn-helper, dashboard-open, tui를 spawn-trace 경유로 전환
- 모든 wt.exe spawn 경로에 MAX_WT_TABS=8 가드 적용 (탭 폭주 방지)

### Fixed
- legacy Gemini path 제거 + platform-aware process cleanup
- stale tfx-multi state 세션 시작 시 정리
- `npm run pack`에서 누락되던 ROOT 소스 동기화 문제 해결

### Removed
- `run_legacy_gemini`, `gemini_with_retry`, `_gemini_run_once` 함수 삭제

## [10.5.0] - 2026-04-09

### Changed
- **AccountBroker per-account CircuitBreaker**: 전역 breaker를 계정 단위로 이전, 한 계정 장애가 다른 계정에 전파되지 않음
- **DRY adapter refactor**: `executeWithCircuitBroker()` 공통 추출, codex/gemini adapter ~80줄 중복 제거
- **EventEmitter 관측성**: lease/release/circuitOpen/circuitClose/tierFallback/noAvailableAccounts 이벤트

### Added
- `/broker/reload` 엔드포인트: 장시간 세션에서 accounts.json 핫리로드
- `reloadBroker()`: 모듈 레벨 singleton 직접 교체 (ESM live binding)
- 테스트 10개 추가 (22→32): circuit breaker, half-open, 시간 감쇠, busy guard, EventEmitter

### Fixed
- `authFile` path traversal guard: `join()` 결과가 AUTH_BASE_PATH 밖이면 차단
- `release()` busy guard: 비-busy 계정에 대한 중복 release 방지 (가짜 쿨다운 제거)
- `snapshot()` 방어 복사: `failureTimestamps` 배열 참조 노출 방지
- config loader 에러 로깅: `catch { return null }` → `console.error` 후 null 반환

## [10.4.0] - 2026-04-08

### Added
- **HUD Mission Board** (#4): `getMissionBoardState()` + `renderMissionBoard()` — 팀 실행 시 에이전트별 실시간 진행률 HUD 표시
- **Skill Active State** (#6): `activateSkill/deactivateSkill/pruneOrphanSkillStates` — 스킬 중복 실행 방지 + 고아 상태 자동 정리
- **psmux Demo** (#8): `scripts/demo.mjs` — 멀티모델 오케스트레이션 시각적 데모 (dry-run 지원)
- **Windows Path Utils** (#9): `hub/lib/path-utils.mjs` — 7개 경로 변환 유틸 통합 모듈
- **Runtime Strategy** (#10): `hub/team/runtime-strategy.mjs` — TeamRuntime 추상 클래스 + 3 stub 구현체
- worktree `.claude-plugin` 복사 방지 + `pruneOrphanWorktrees()` 고아 정리 (#34)

### Fixed
- headless-guard: `gh`/`git` 명령 본문 내 codex/gemini 문자열 오감지 수정 (#37 Bug4)
- gemini.test.mjs: stream wrapper timeout 시 skip 처리 (flaky test)
- headless-stall.test.mjs: maxRestarts 증가로 타이밍 이슈 해결

### Closed Issues
- 11개 이슈 클로즈: #1, #2, #3, #5, #18, #20, #21, #23, #31, #37, #52 (코드 검증 후 해결 확인)

## [10.1.0] - 2026-04-07

### Security
- headless-guard: pipe bypass 취약점 수정 (`cat X | codex exec` 패턴)
- headless-guard: wrapper bypass 차단 (env, bash -c, 절대경로)
- headless-guard: P1 psmux payload 검사 + P3 2차 휴리스틱 강화
- safety-guard: SSH→PowerShell bash 문법 직접 전달 차단

### Added
- **Reflexion 적응형 학습**: safety-guard 차단 → pending-penalties → adaptive_rules 자동 승격 파이프라인
- **TUI Routing Monitor**: `tfx monitor` — 실시간 라우팅 대시보드 (routing-weights, Q-table, 성능 추적)
- **adaptive_rules API v2**: hit_count 오염 방지 + 스키마 v2 + 테스트 18건
- knip.json workspace 설정 (monorepo dead code 탐지)
- biome.json 프로젝트 맞춤 룰 튜닝

### Fixed
- `setup --dry-run` 크래시: 제거된 `extractMarkdownSection` 호출 → `getLatestRoutingTable()` API로 교체
- MCP fallback 누락: 연결 실패(exit 1)도 transport exit code로 변환하여 auto mode fallback 정상화
- psmux CP949 인코딩 4축 완전 커버
- Git Bash 실행 실패: PowerShell call operator(&) 누락 수정
- WSL bash 대신 Git Bash 명시 + CLI 절대 경로 resolve
- hook-registry Edit/Write passthrough
- 10건 테스트 실패 전면 수정 (claudemd-manager API 변경, alias 구조 변경, test-lock 래퍼 등)

### Changed
- biome lint: 158 errors → 0 errors (auto-fix + 수동 수정 + 룰 튜닝)
- reflexion store 함수를 adaptive_rules API로 통합
- 고아 모듈 5개 @experimental 마킹
- .gitattributes LF 강제

## [10.0.0] - 2026-04-06

### Added
- **Lake 3 Phase 2**: SSH keepalive (ServerAliveInterval/CountMax) + exponential backoff retry for transient SSH failures
- **Lake 3 Phase 2**: hosts.json capability matching — `selectHostForCapability()`, `resolveHostAlias()`, `getHostConfig()`
- **Lake 4**: Shared segments library — `telemetry-segment.md`, `arguments-processing.md`, `mandatory-rules.md` for cross-skill DRY
- **Lake 4**: Skill manifest — `skill.json` for 41 skills, separating metadata from prompt body
- **Lake 4**: `{{#include shared/*.md}}` directive in skill-template.mjs + `loadTemplatePartials()`
- **Lake 5**: Agent Mesh — `mesh-router.mjs` (direct/broadcast/capability routing), `mesh-queue.mjs` (per-agent TTL queues), `mesh-heartbeat.mjs` (stale agent detection), `conductor-mesh-bridge.mjs` (Conductor EventEmitter integration)
- v10 Lake roadmap section in README

### Changed
- README updated to 42 skills with accurate inventory
- CLAUDE.md routing table: split "리서치" into fast (tfx-research) and autonomous (tfx-autoresearch)
- `tfx-deep-interview` description clarifies Gemini-only (not 3-CLI consensus) — naming exception documented
- `tfx-codex-swarm` converted to pure deprecated alias → redirects to `tfx-swarm`
- `keyword-rules.json` routes codex-swarm patterns to tfx-swarm

### Removed
- Orphan directories: `tfx-workspace`, `tfx-codex-swarm-workspace` (eval artifacts without SKILL.md)
- Non-existent skills removed from README: `tfx-codebase-search`, `tfx-deep-autopilot`, `tfx-sisyphus`, `tfx-deslop`
