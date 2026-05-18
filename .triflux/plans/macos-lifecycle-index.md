# macOS Process Lifecycle Fix — Master PRD

> Generated: 2026-05-18
> Source of truth: [docs/research/macos-process-lifecycle-leak-report-2026-05-18.md](../../docs/research/macos-process-lifecycle-leak-report-2026-05-18.md)
> Workflow: tfx-swarm 4 worktrees → PR 4개 → Shard 1 PR `/ultrareview` 1회 → squash-merge → `/tfx-ship`

## Overview

보고서 §"Recommended Fix Plan" (lines 379-465) 의 P1~P4 + 본 작업 중 실측으로 발견한 P3b (version drift) / P4b (SessionEnd hook JSON schema mismatch) 를 4개 shard 로 분해. 각 shard 는 worktree 격리 병렬 구현. 보고서 파일이 single source of truth — PRD 는 line range 만 인용.

## Shard 매트릭스

| Shard | Subject | Root files | Mirror targets | Cross-review | Source lines |
|-------|---------|------------|----------------|--------------|--------------|
| 1 | P1 macOS mux identity | hub/team/session.mjs, hub/team/terminal-opener.mjs | packages/triflux + packages/remote (Edit) | codex → claude + ultrareview 1회 | 99-134, 273-326, 391-408 |
| 2 | P2 test-lock supervisor | scripts/test-lock.mjs | packages/triflux/scripts/ | codex → claude | 167-232, 410-428 |
| 3 | P3a hub stale + P3b version drift | scripts/hub-ensure.mjs, bin/triflux.mjs (doctor) | packages/triflux | codex → gemini | 56-97, 234-271, 430-447 |
| 4 | P4a tmux cleanup + P4b SessionEnd schema | hooks/session-end-cleanup.mjs, bin/triflux.mjs (doctor) | packages/triflux | codex → claude | 136-163, 328-342, 449-465 |

## 병렬 / 순서 제약

- 기본: 4 shard 모두 worktree 격리 병렬 (tfx-swarm 자동)
- **Cross-cut**: Shard 3 과 Shard 4 모두 `bin/triflux.mjs doctor` 확장 → 머지 순서 **S3 → S4** (S4 PR 이 S3 branch 위 rebase 또는 stacked) 또는 S4 가 머지 시점에 S3 변경 incorporate
- Shard 4 의 macOS cleanup path 는 Shard 1 의 mux identity fix 에 의존 (`mux === "tmux"` 검증) — 단 PR 단위 독립 (S4 의 cleanup 호출 시 인터페이스는 S1 fix 이후에도 안정)

## Global Constraints (전 shard 적용)

- 보고서 파일은 본 chore PR 에서 main 으로 commit (PRD 가 line range 인용)
- No public API signature changes 단독 — caller-impact 분석 동반
- No `tests/legacy/` 편집, DB/스키마 migration 0, package.json 신규 dep 0
- `git add -A` 금지 — 의도된 파일만 stage
- AI attribution footer 금지 (Co-Authored-By 등) — `/tfx-ship` 정책
- packages mirror policy 준수 (`.claude/rules/tfx-mirror-policy.md`):
  - hub/, scripts/, hooks/ → `packages/triflux/` byte-identical
  - hub/lib/, scripts/lib/ → `packages/core/` byte-identical
  - `packages/remote/` → **Edit only** (`@triflux/core/*` import 보존; cp 사용 시 import 경로 revert 위험)
  - `tests/` → mirror **제외** (npm files 미포함)
- 동일 모델 self-approve 금지 — Claude 작성물은 Codex 가, Codex 작성물은 Claude/Gemini 가 리뷰

## ultrareview 예산

- **Shard 1 PR 1회만 사용** — macOS platform edge case 가 가장 위험 (`detectMultiplexer()` 회귀가 attach/cleanup 광범위 영향)
- Shard 2/3/4 는 Claude<->Codex (또는 ↔ Gemini) cross-review 만

## Done When (전체)

- `gh pr list --search "macos-lifecycle" --state merged --json number | jq length` == 4
- `pnpm test tests/unit/multiplexer-resolution.test.mjs tests/unit/test-lock.test.mjs tests/integration/hub-singleton.test.mjs tests/unit/session-end-cleanup.test.mjs` exits 0
- darwin without psmux binary 환경에서 `node -e "import('./hub/team/session.mjs').then(m=>console.log(m.detectMultiplexer()))"` 출력 ≠ `"psmux"`
- `tfx --version` 이 v10.22.x 출력
- GitHub release CHANGELOG 가 4 shard 모두 명시

## Worktree Branches (tfx-swarm 가 자동 생성)

- `fix/macos-lifecycle-s1-mux-identity`
- `fix/macos-lifecycle-s2-test-lock-supervisor`
- `fix/macos-lifecycle-s3-hub-retirement`
- `fix/macos-lifecycle-s4-tmux-cleanup-schema`

## Acceptance Criteria 매핑 (보고서 §Acceptance Criteria, lines 466-476)

| 보고서 항목 | 담당 shard |
|-------------|------------|
| (1) darwin tmux-only → `detectMultiplexer() === "tmux"` + attach 명령 `tmux attach-session` | S1 |
| (2) `npm test` orphan node --test 잔존 안 함 | S2 |
| (3) test-lock stale handling 이 dead lock vs live stale 구분 | S2 |
| (4) `tfx doctor` 가 stale hub clusters + tmux sessions 보고 | S3 + S4 |
| (5) hub startup 후 stale hub instances 누적 안 함 | S3 |
| (6) darwin mux identity / test child cleanup / stale hub 회귀 테스트 | S1 + S2 + S3 |
