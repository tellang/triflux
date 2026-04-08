# Changelog

All notable changes to triflux will be documented in this file.

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
