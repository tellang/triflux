# Changelog

All notable changes to triflux will be documented in this file.

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
