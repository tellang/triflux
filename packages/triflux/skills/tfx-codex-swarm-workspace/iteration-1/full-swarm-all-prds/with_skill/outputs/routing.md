# Codex Swarm - Profile Routing Table

> Generated: 2026-03-30

## Size Assessment (Step 4-1)

| # | PRD File | Lines | Affected Files | High-cost Keywords | Dependencies | Size |
|---|----------|-------|----------------|-------------------|--------------|------|
| 24 | prd-issue-24 | 73 | 4 (`remote-spawn.mjs`, handoff, scp, staging) | 0 | none | **L** |
| 25 | prd-issue-25 | 76 | 4 (`psmux`, SSH PTY, Claude TUI, WT) | 0 | none | **L** |
| 26 | prd-issue-26 | 70 | 3 (`remote-spawn`, `psmux`, hub stale cleanup) | 0 | none | **L** |
| 27 | prd-issue-27 | 73 | 4 (`wt.exe` attach, dashboard viewer, headless, config) | 0 | none | **L** |
| 28 | prd-issue-28 | 69 | 4 (`headless-guard.mjs`, `hub/team/psmux.mjs`, codex, gemini) | 0 | none | **L** |
| 29 | prd-issue-29 | 70 | 5 (`tfx-route.sh`, `parse-args.mjs`, `start-headless.mjs`, `headless.mjs`, `buildHeadlessCommand`) | 0 | none | **L** |
| 30 | prd-issue-30 | 70 | 3 (`remote-spawn.mjs`, `headless.mjs`, WT) | 0 | none | **L** |

### Size Thresholds (from SKILL.md)

| Size | PRD Lines | Affected Files | High-cost Keywords |
|------|-----------|----------------|-------------------|
| XL   | 80+       | 6+             | 2+                |
| L    | 40-80     | 3-5            | 0-1               |
| M    | 20-40     | 1-2            | 0                 |
| S    | <20       | 1              | 0                 |

All 7 PRDs fall in the **L (standard)** range: 69-76 lines, 3-5 affected files, 0 high-cost keywords.

## Profile Routing (Step 4-2)

Per routing table: Type x Size -> Profile

| Type \ Size | XL | L | M | S |
|-------------|-----|-----|-----|-----|
| **implement** | codex53_xhigh | **codex53_high** | codex53_med | codex53_low |
| **investigate** | gpt54_high | **gpt54_high** | gpt54_low | mini54_med |

## Final Routing

| # | Task | Size | Type | Profile | Codex Flags |
|---|------|------|------|---------|-------------|
| 24 | file-transfer | L | implement | `codex53_high` | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'` |
| 25 | resize-blank | L | investigate | `gpt54_high` | `-c 'model="gpt-5.4"' -c 'model_reasoning_effort="high"'` |
| 26 | session-cleanup | L | implement | `codex53_high` | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'` |
| 27 | hud-dashboard-anchor | L | implement | `codex53_high` | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'` |
| 28 | guard-deadlock | L | implement | `codex53_high` | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'` |
| 29 | cwd-propagation | L | implement | `codex53_high` | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'` |
| 30 | terminal-minimize | L | investigate | `gpt54_high` | `-c 'model="gpt-5.4"' -c 'model_reasoning_effort="high"'` |

## Execution Defaults

| Setting | Value | Note |
|---------|-------|------|
| Mode | `--full-auto` | Sandbox auto-approve |
| Worktree | enabled | Per-session independent worktree |
| psmux | enabled | Session management |
| WT | tabs in single window | User requested: "하나의 WT에 탭으로 넣어줘" |
