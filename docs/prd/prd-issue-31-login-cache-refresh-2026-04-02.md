# PRD: Issue #31 - login/auth change should refresh warmup caches

## Problem

Warmup caches can remain stale after Codex login or auth state changes because the normal setup/session-start path runs cache warmup with TTL enforcement instead of a forced rebuild.

## Current Evidence

- `scripts/setup.mjs` runs Phase 1 warmup on session start with TTL-based behavior.
- `bin/triflux.mjs` already contains a forced cache rebuild path through `buildAll({ force: true })`.
- `scripts/lib/env-probe.mjs` already inspects `.codex/auth.json`.
- `scripts/cache-warmup.mjs` owns the build vs skip decision for the warmup targets.

## Requirements

1. If Codex auth state changes, the next warmup pass must rebuild the auth-sensitive caches even when TTL has not expired.
2. The trigger must be derived from local state only, without relying on a separate login hook API.
3. Unchanged auth must preserve current TTL-based skip behavior.
4. The implementation must stay dependency-free and low-risk.

## Acceptance Criteria

1. A stable auth fingerprint is derived from `.codex/auth.json`.
2. Warmup metadata persists the last seen fingerprint.
3. `codexSkills`, `tierEnvironment`, and `searchEngines` rebuild when the fingerprint changes.
4. `projectMeta` keeps normal TTL behavior.
5. Added regression tests cover both unchanged-auth skip and changed-auth rebuild behavior.

## Implementation Outline

1. Extend auth probing to expose a stable fingerprint alongside plan/source.
2. Persist the fingerprint in warmup metadata under `.omc/state/`.
3. Update `cache-warmup` skip logic so auth-sensitive targets ignore TTL when the fingerprint changed.
4. Write the metadata only after a successful warmup pass.
5. Add unit coverage for the auth probe contract and the warmup invalidation flow.

## Verification

- `node --test tests/unit/cache-warmup.test.mjs`
- `node --test tests/unit/env-probe.test.mjs`
- `node --test tests/integration/triflux-cli.test.mjs`
- `npm test`
