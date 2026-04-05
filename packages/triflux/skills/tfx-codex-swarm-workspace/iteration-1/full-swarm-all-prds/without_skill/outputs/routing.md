# Codex Profile Routing — 7 PRDs

## Routing Method

Following SKILL.md Step 4 profile routing tables.

### Size Estimation Signals

| Signal | Method |
|--------|--------|
| PRD length | line count |
| Affected files | file paths mentioned in PRD |
| High-cost keywords | "architecture", "migration", "refactoring" |
| Dependency depth | references to other issues/PRDs |

### Size Thresholds

| Size | PRD lines | Affected files | High-cost keywords |
|------|-----------|----------------|--------------------|
| XL | 80+ | 6+ | 2+ |
| L | 40-80 | 3-5 | 0-1 |
| M | 20-40 | 1-2 | 0 |
| S | <20 | 1 | 0 |

---

## Per-PRD Routing

### Issue #24 — remote-spawn file transfer
- **Lines**: 73
- **Affected files**: `scripts/remote-spawn.mjs` (primary), prompt pipeline, scp path (~3 files)
- **High-cost keywords**: 0
- **Size**: L (standard)
- **Type**: implement
- **Profile**: `codex53_high`
- **Flags**: `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'`

### Issue #25 — resize blank-screen investigation
- **Lines**: 76
- **Affected files**: `scripts/remote-spawn.mjs`, psmux pane capture, SSH PTY (~4 files)
- **High-cost keywords**: 0
- **Size**: L (standard)
- **Type**: investigate
- **Profile**: `gpt54_high`
- **Flags**: `-c 'model="gpt-5.4"' -c 'model_reasoning_effort="high"'`

### Issue #26 — session cleanup
- **Lines**: 70
- **Affected files**: `scripts/remote-spawn.mjs`, `hub/server.mjs` (~2-3 files)
- **High-cost keywords**: 0
- **Size**: L (standard)
- **Type**: implement
- **Profile**: `codex53_high`
- **Flags**: `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'`

### Issue #27 — HUD dashboard anchor
- **Lines**: 73
- **Affected files**: `hub/team/headless.mjs` (primary), WT config (~2 files)
- **High-cost keywords**: 0
- **Size**: L (standard)
- **Type**: implement
- **Profile**: `codex53_high`
- **Flags**: `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'`

### Issue #28 — headless-guard spawn deadlock
- **Lines**: 69
- **Affected files**: `scripts/headless-guard.mjs`, `tests/unit/headless-guard.test.mjs` (~2 files)
- **High-cost keywords**: 0
- **Size**: L (standard)
- **Type**: implement
- **Profile**: `codex53_high`
- **Flags**: `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'`

### Issue #29 — headless cwd propagation
- **Lines**: 70
- **Affected files**: `hub/team/cli/commands/start/parse-args.mjs`, `hub/team/cli/commands/start/start-headless.mjs`, `hub/team/headless.mjs`, `hub/team/backend.mjs`, `scripts/tfx-route.sh` (~5 files)
- **High-cost keywords**: 0
- **Size**: L (standard)
- **Type**: implement
- **Profile**: `codex53_high`
- **Flags**: `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'`

### Issue #30 — terminal minimize investigation
- **Lines**: 70
- **Affected files**: `scripts/remote-spawn.mjs`, `hub/team/headless.mjs`, WT focus (~3 files)
- **High-cost keywords**: 0
- **Size**: L (standard)
- **Type**: investigate
- **Profile**: `gpt54_high`
- **Flags**: `-c 'model="gpt-5.4"' -c 'model_reasoning_effort="high"'`

---

## Routing Summary Table

| # | Task | Size | Type | Profile | Model | Effort |
|---|------|------|------|---------|-------|--------|
| 24 | file-transfer | L | implement | `codex53_high` | gpt-5.3-codex | high |
| 25 | resize-blank | L | investigate | `gpt54_high` | gpt-5.4 | high |
| 26 | session-cleanup | L | implement | `codex53_high` | gpt-5.3-codex | high |
| 27 | dashboard-anchor | L | implement | `codex53_high` | gpt-5.3-codex | high |
| 28 | guard-deadlock | L | implement | `codex53_high` | gpt-5.3-codex | high |
| 29 | cwd-propagation | L | implement | `codex53_high` | gpt-5.3-codex | high |
| 30 | terminal-minimize | L | investigate | `gpt54_high` | gpt-5.4 | high |

## Execution Config

| Setting | Value | Notes |
|---------|-------|-------|
| Execution mode | `--full-auto` | sandbox auto-approve |
| Worktree | enabled | per-session isolated worktree |
| psmux | enabled | session management |
| WT layout | single window, 7 tabs | user requested tabs |
