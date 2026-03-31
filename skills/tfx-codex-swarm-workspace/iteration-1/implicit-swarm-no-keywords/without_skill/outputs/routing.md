# Profile Routing (without skill guidance)

> Generated: 2026-03-30
> Mode: **no skill** — agent must discover routing from tfx-route.sh infrastructure

## What the Agent Knows

Without the codex-swarm skill, the agent has no routing table (Step 4 of SKILL.md).
It must derive Codex profiles from one of:

1. **tfx-route.sh** — the project's CLI router (if the agent discovers it)
2. **Raw codex CLI flags** — if the agent knows Codex CLI syntax
3. **No routing at all** — just runs `codex` with defaults

## Likely Agent Behavior: Scenario Analysis

### Scenario A: Agent discovers tfx-route.sh (best case)

The agent finds `scripts/tfx-route.sh` and sees the `route_agent()` function with profile mappings.
It would extract:

| Agent Type | Profile | CLI Flags |
|-----------|---------|-----------|
| executor | `codex53_high` | `exec --profile codex53_high --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` |
| executor (bg) | `codex53_high` | same, `RUN_MODE="bg"` |
| scientist | `gpt54_high` | `exec --profile gpt54_high ...` |

The agent might map all 3 PRDs to `executor` type (since user said "구현") and use `codex53_high`:

| # | PRD File | Agent Type | Profile | Timeout |
|---|----------|-----------|---------|---------|
| 1 | auth-refactor.md | executor | codex53_high | 1080s |
| 2 | api-v2.md | executor | codex53_high | 1080s |
| 3 | cache-layer.md | executor | codex53_high | 1080s |

**Problem**: No size-based differentiation. All 3 get identical profiles regardless of complexity.

### Scenario B: Agent uses codex CLI directly (likely case)

The agent skips tfx-route.sh entirely and invokes `codex` with `--full-auto`:

| # | PRD File | Command | Profile |
|---|----------|---------|---------|
| 1 | auth-refactor.md | `codex --full-auto "..."` | default (no profile) |
| 2 | api-v2.md | `codex --full-auto "..."` | default (no profile) |
| 3 | cache-layer.md | `codex --full-auto "..."` | default (no profile) |

**Problem**: No profile routing at all. All tasks use Codex defaults.

### Scenario C: Agent uses tfx-route.sh --async (optimistic case)

If the agent discovers the `--async` flag in tfx-route.sh:

```
tfx-route.sh --async executor "PRD auth-refactor 구현" implement
tfx-route.sh --async executor "PRD api-v2 구현" implement
tfx-route.sh --async executor "PRD cache-layer 구현" implement
```

This gets profile routing for free via tfx-route.sh, but still no per-task size differentiation.

## Comparison: Skill-Guided Routing

The skill's Step 4 would produce differentiated routing:

| # | PRD File | Size | Type | Profile (with skill) | Profile (without skill) |
|---|----------|------|------|---------------------|------------------------|
| 1 | auth-refactor.md | L (est.) | refactor | `codex53_high` | `codex53_high` or default |
| 2 | api-v2.md | XL (est.) | implement | `codex53_xhigh` | `codex53_high` or default |
| 3 | cache-layer.md | M (est.) | implement | `codex53_med` | `codex53_high` or default |

Key differences:
- **With skill**: Size-based differentiation (XL/L/M/S) drives profile selection
- **Without skill**: Flat routing -- all tasks get the same profile
- **With skill**: Type-aware routing (refactor vs implement use different profile ladders)
- **Without skill**: All treated as "executor" type uniformly

## Missing Without Skill

1. **No PRD line-count / file-impact analysis** (Step 4-1 of SKILL.md)
2. **No routing table** (Step 4-2) — the 4x4 type-vs-size matrix is unknown
3. **No profile flag mapping** — `codex53_xhigh` -> specific CLI flags
4. **No AskUserQuestion for override** — user cannot adjust routing interactively
5. **No cost optimization** — small tasks waste xhigh tokens, large tasks may undershoot
