# Codex Swarm - Profile Routing (Selective: Issue 24, 28 with xhigh override)

> Generated: 2026-03-30
> Mode: without_skill (no SKILL.md guidance)

## Size Assessment

| # | PRD File | Lines | Affected Files | High-cost Keywords | Dependencies | Size |
|---|----------|-------|----------------|-------------------|--------------|------|
| 24 | prd-issue-24 | 73 | 4 (`remote-spawn.mjs`, handoff, scp, staging) | 0 | none | **L** |
| 28 | prd-issue-28 | 69 | 4 (`headless-guard.mjs`, `hub/team/psmux.mjs`, codex, gemini) | 0 | none | **L** |

Both PRDs fall in the **L (standard)** range.

## Default Routing (what auto-routing would produce)

Under normal routing for L-size implement tasks:

| # | Task | Size | Type | Auto Profile | Auto Flags |
|---|------|------|------|-------------|------------|
| 24 | file-transfer | L | implement | `codex53_high` | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'` |
| 28 | guard-deadlock | L | implement | `codex53_high` | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"'` |

## Applied Routing (after user xhigh override)

User directive: "둘 다 xhigh로 세팅하고" overrides the auto-routed `codex53_high` to `codex53_xhigh`.

| # | Task | Size | Type | Profile | Codex Flags |
|---|------|------|------|---------|-------------|
| 24 | file-transfer | L | implement | **`codex53_xhigh`** | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="xhigh"'` |
| 28 | guard-deadlock | L | implement | **`codex53_xhigh`** | `-c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="xhigh"'` |

### Profile Resolution

`codex53_xhigh` maps to the existing Codex config profile `[profiles.codex53_xhigh]`:
```toml
[profiles.codex53_xhigh]
model = "gpt-5.3-codex"
model_reasoning_effort = "xhigh"
```

This profile exists in `~/.codex/config.toml`, so either `-c` inline flags or `--profile codex53_xhigh` can be used.

## Execution Defaults

| Setting | Value | Note |
|---------|-------|------|
| Mode | `--full-auto` | Sandbox auto-approve (YOLO) |
| Worktree | enabled | Per-session independent worktree |
| psmux | enabled | Session management via send-keys |
| WT | 2 tabs in single window | Only 2 sessions (not 7) |
| OMX skill | `$ralph` | Persist loop until task fully complete |

## Cost / Duration Estimate

| Factor | Value |
|--------|-------|
| Model | gpt-5.3-codex (SWE-Bench 72%, Terminal-Bench 77%) |
| Effort | xhigh (maximum reasoning, slowest) |
| Sessions | 2 concurrent |
| Expected duration | 15-45 min per session (xhigh adds ~2-3x vs high) |
