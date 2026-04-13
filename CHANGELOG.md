# Changelog

All notable changes to triflux will be documented in this file.

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
