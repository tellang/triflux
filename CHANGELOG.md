# Changelog

All notable changes to triflux will be documented in this file.

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
