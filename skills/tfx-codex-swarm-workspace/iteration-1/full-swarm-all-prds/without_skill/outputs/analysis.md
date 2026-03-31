# Codex Swarm Analysis — Full 7-PRD Execution Plan

## Overview

- **Source**: 7 PRD files in `.omx/plans/`
- **Issues**: #24, #25, #26, #27, #28, #29, #30
- **Classification**: 5 implement, 2 investigate
- **User directive**: implement -> `$plan` -> `$autopilot`, investigate -> `$plan` only
- **Execution**: Codex CLI in `--full-auto` mode, one psmux session per PRD, all in one WT window as tabs

## What Was Generated

| File | Purpose |
|------|---------|
| `classification.md` | PRD-by-PRD type classification with rationale |
| `routing.md` | Codex profile routing (model, effort level) per PRD |
| `commands.sh` | Full executable script: worktrees, prompts, psmux, codex, WT tabs |
| `analysis.md` | This summary |

## Execution Pipeline

```
Phase 1: git worktree add (7 isolated worktrees)
Phase 2: Copy PRD files into worktrees
Phase 3: Generate per-task prompt files with OMX skill instructions
Phase 4: psmux new-session + codex send-keys (7 sessions)
Phase 5: psmux attach --wt-tab (1 WT window, 7 tabs)
```

## Session Map

| Tab | Session | Issue | Type | Model | Skill Flow |
|-----|---------|-------|------|-------|------------|
| 1 | codex-swarm-24 | file-transfer | implement | gpt-5.3-codex (high) | $plan -> $autopilot |
| 2 | codex-swarm-25 | resize-blank | investigate | gpt-5.4 (high) | $plan only |
| 3 | codex-swarm-26 | session-cleanup | implement | gpt-5.3-codex (high) | $plan -> $autopilot |
| 4 | codex-swarm-27 | dashboard-anchor | implement | gpt-5.3-codex (high) | $plan -> $autopilot |
| 5 | codex-swarm-28 | guard-deadlock | implement | gpt-5.3-codex (high) | $plan -> $autopilot |
| 6 | codex-swarm-29 | cwd-propagation | implement | gpt-5.3-codex (high) | $plan -> $autopilot |
| 7 | codex-swarm-30 | terminal-minimize | investigate | gpt-5.4 (high) | $plan only |

## Isolation Strategy

Each session runs in its own git worktree under `.codex-swarm/wt-issue-{N}` on branch `codex/issue-{N}`. This prevents file conflicts between parallel Codex sessions. PRD files are copied into each worktree so the Codex agent can read them locally.

## Key Design Decisions

### 1. Model Selection
- **Implement tasks** (5): `gpt-5.3-codex` with high reasoning effort. Codex-optimized model for code generation.
- **Investigate tasks** (2): `gpt-5.4` with high reasoning effort. General model better suited for analysis and investigation planning.
- All 7 PRDs sized as L (standard) based on line count (69-76 lines) and affected file counts (2-5 files).

### 2. OMX Skill Routing
- User explicitly requested: implement -> autopilot, investigate -> plan only.
- Implement prompts instruct: `$plan` first, then `$autopilot` for autonomous execution.
- Investigate prompts instruct: `$plan` only, explicitly stating "do not implement".

### 3. WT Layout
- User requested "one WT with tabs" -- all 7 sessions are tabs in a single WT window.
- First session uses `--wt-new-window`, remaining 6 use `--wt-tab`.
- wt.exe fallback is provided as a commented-out alternative.

### 4. No Execution
- Per instructions, commands are generated but NOT executed.
- The `commands.sh` script is ready to run when the user decides to launch.

## Monitoring Commands

```bash
# Check status of all sessions
for N in 24 25 26 27 28 29 30; do
  echo "=== Issue #$N ==="
  psmux capture-pane --session "codex-swarm-$N" --lines 5
done

# List active sessions
psmux list-sessions | grep codex-swarm

# Kill all swarm sessions (cleanup)
for N in 24 25 26 27 28 29 30; do
  psmux kill-session --name "codex-swarm-$N"
done
git worktree prune
rm -rf .codex-swarm/
```

## Risk Notes

- **Issue #25 and #30** (investigate): These have "evidence insufficient" validity verdicts. The investigation plans may conclude that no code fix is needed. Using `$plan` only is appropriate.
- **Issue #28** (partially valid): The deadlock claim is overstated per validity review, but the UX improvement is still warranted. Autopilot should handle the bounded scope.
- **Issue #29**: Touches the most files (5 across CLI parse, headless, and backend layers). Most likely to need careful cross-file coordination.
- **Parallel execution**: 7 simultaneous Codex sessions will consume significant API quota. All are routed to high-effort profiles.
