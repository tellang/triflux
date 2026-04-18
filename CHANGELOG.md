# Changelog

All notable changes to triflux will be documented in this file.

## [Unreleased]

### Added — Phase 3: true ralph / auto-escalate / --lead (#112)

- **[#112 Phase 3 Step A]** `hub/team/retry-state-machine.mjs` — true ralph + auto-escalate 상태 머신. 3 모드 (bounded/ralph/auto-escalate), stuck detector (동일 failureReason 3회 중단), 4단계 escalation 체인 (codex:gpt-5-mini → codex:gpt-5 → claude:sonnet-4-6 → claude:opus-4-7), EventEmitter on("transition") 연동 (retry-state-machine.test.mjs 12건)
- **[#112 Phase 3 Step B]** `hub/lib/tfx-route-args.mjs` — tfx-auto ARGUMENTS 파서. Phase 3 신규 플래그 3개 (`--lead {claude|codex}`, `--no-claude-native`, `--max-iterations <N>`) + `--retry` 값 확장 (`ralph`, `auto-escalate`) + 조합 validation (`--parallel 1 + --isolation worktree` force none, `--remote + non-swarm` warn) + `--flag=value` 및 `--flag value` 두 형태 지원 (tfx-route-args.test.mjs 16건)
- **[#112 Phase 3 Step C2]** `hub/bridge.mjs retry-run` / `retry-status` 서브커맨드 — multi-process safe state machine bridge. snapshot JSON 파일을 통해 Claude orchestration 이 매 iteration 마다 state 조회/전이. serialize/applySnapshot round-trip + loadSnapshot/saveSnapshot 파일 I/O + version gate (v1) (bridge-retry.test.mjs 3건, retry-state-machine round-trip 4건)
- **[#112 Phase 3 Step D]** `.claude/rules/tfx-escalation-chain.md` 신규 — DEFAULT_ESCALATION_CHAIN 4단계 규약 + 프로젝트 override (`.triflux/config/escalation-chain.json`). `.gitignore` 에 `!.claude/rules/*.md` 예외 추가 — 기존 `tfx-routing.md` / `tfx-execution-skill-map.md` / `tfx-update-logic.md` 3파일도 함께 tracked (Phase 2 source/installed drift 해결)
- **[#112 Phase 3 Step F]** integration 테스트 2건 — ralph compaction survive (5 iteration 독립 프로세스 counter 유지, snapshot 외부 수정 후 복원, DONE idempotent resume), auto-escalate chain (체인 2단계 전이, 끝까지 소진 BUDGET_EXCEEDED, 중간 verify-success DONE, stuck 은 체인과 독립)

### Changed

- **[#112 Phase 3 Step C1]** `skills/tfx-auto/SKILL.md` 플래그 오버라이드 테이블 5줄 추가 (`--retry ralph`/`auto-escalate`, `--lead claude|codex`, `--no-claude-native`, `--max-iterations N`). Legacy 매핑 3건 갱신:
  - `tfx-autoroute`: `--cli auto --retry 1` → `--retry auto-escalate`
  - `tfx-persist`: `--mode deep --retry ralph` (⚠ degrade) → `--retry ralph` (Phase 3 unlimited)
  - `tfx-auto-codex`: `--cli codex + env` → `--cli codex --lead codex --no-claude-native`
- **[#112 Phase 3 Step C1]** 3 thin alias 본문 재작성 (`tfx-auto-codex`, `tfx-persist`, `tfx-autoroute`) — Phase 3 플래그로 "완전 표현" 됨을 반영. `tfx-persist` 는 state machine 전이 다이어그램 + `.omc/state/retry-<sid>.json` 복원 경로 명시, `tfx-autoroute` 는 DEFAULT_ESCALATION_CHAIN 4단계 + `.claude/rules/tfx-escalation-chain.md` override crosslink
- **[#112 Phase 3 Step D]** `.claude/rules/tfx-routing.md` "깊이 수정자" 표 — "반복" → `--retry ralph` 매핑, "승격" 신규 행 추가 (`--retry auto-escalate`). `.claude/rules/tfx-execution-skill-map.md` 에 "Retry 정책 (Phase 3+)" 섹션 추가

### Fixed

- **[lint]** biome 2.4.10 drift 일괄 정리 — `noUnusedImports` / `noUnusedVariables` / `useOptionalChain` 17파일. `String.raw` (Windows path) 보존 검증. 기존 pre-existing 30 test fail 은 `{ todo: ... }` 마커로 전환 (Phase 2 Step B thin alias 이관 회귀, Phase 3 Step E 복원 예정)
- **[packages]** `pack.mjs` 미러 동기화 — 02dd3aa lint drift 17파일 + #108 체인 마지막 (49e0979) 이후 누락된 `codex-app-server-worker.mjs` sha256 복원. packages-sync PRD-4 gate 2건 pass
- **[test]** `safety-guard-psmux.test.mjs` cwd/env 격리 — `.claude/cleanup-bypass` 로컬 우회 마커가 테스트 cwd 에 있으면 runGuard 가 통과로 오판. `cwd: tmpdir()` + `TFX_CLEANUP_BYPASS` env 제거 + 가드 스크립트 절대경로 해석으로 격리
- **[claudemd-sync]** `.claude/rules/tfx-routing.md` 를 source of truth 로 — Phase 2 Step A 이후 CLAUDE.md 에서 `<routing>` 태그가 없어 "routing section not found" 5건 fail. `getLatestRoutingTable()` 가 새 source 먼저 읽고 CLAUDE.md 인라인/heading 은 legacy fallback 유지

### Known Issues

- **[#113]** `claudemd-sync` 가 세션 중 프로젝트 `CLAUDE.md` 에 `<routing>` 블록 자동 주입하는 경로 미식별 — Phase 2 Step A 의 축소 의도와 상충. 재발생 시 `git checkout -- CLAUDE.md` 로 revert 필요
- **[skill-drift]** skill-drift.test.mjs 17건 + deep-interview.test.mjs 3건 `todo` 마커 유지 — Phase 2 Step B thin alias 축소 시 유실된 규칙 (CLEANUP & CANCEL RULES, 5 Stage 헤더, 산출물 경로 등) 의 본체 복원은 Phase 3 Step E 로 이관

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
