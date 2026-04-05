# PRD Classification — 7 PRDs in .omx/plans/

## Classification Criteria

Based on PRD content analysis against SKILL.md Step 3 rules:
- **implement**: keywords "구현", "implement", "추가", "변경", "fix", actionable code changes
- **investigate**: keywords "조사", "investigation", "재현", "reproduce", runtime-only evidence needed

User override: implement -> `$plan` -> `$autopilot`, investigate -> `$plan` only.

---

## PRD-by-PRD Classification

### 1. prd-issue-24-remote-spawn-file-transfer.md
- **Type**: implement
- **Rationale**: "Add an explicit file-transfer phase before remote Claude launch", "Copy transferred files", "rewrite the prompt". Clear implementation deliverable with bounded code changes in `scripts/remote-spawn.mjs`.
- **Validity verdict**: mostly valid
- **OMX skill**: `$plan` -> `$autopilot`

### 2. prd-issue-25-remote-spawn-resize-blank-screen.md
- **Type**: investigate
- **Rationale**: "Produce a deterministic reproduction procedure", "investigation checklist", "instrumentation-first workflow". Explicitly framed as investigation, not implementation. Verdict was "evidence insufficient".
- **Validity verdict**: evidence insufficient
- **OMX skill**: `$plan` (investigation mode)

### 3. prd-issue-26-remote-spawn-session-cleanup.md
- **Type**: implement
- **Rationale**: "Add a normal-exit watcher", "trigger killPsmuxSession(sessionName)". Clear implementation target: add cleanup logic to spawn lifecycle.
- **Validity verdict**: valid
- **OMX skill**: `$plan` -> `$autopilot`

### 4. prd-issue-27-hud-dashboard-anchor.md
- **Type**: implement
- **Rationale**: "Replace focus-relative split behavior with a dedicated dashboard target strategy", "Remove or narrow mf up focus manipulation". Concrete implementation changes to `hub/team/headless.mjs`.
- **Validity verdict**: valid
- **OMX skill**: `$plan` -> `$autopilot`

### 5. prd-issue-28-headless-guard-spawn-deadlock.md
- **Type**: implement
- **Rationale**: "Make the denial message action-oriented and specific", "Add regression tests around the guard decision matrix". Implementation + test additions to `scripts/headless-guard.mjs`.
- **Validity verdict**: partially valid
- **OMX skill**: `$plan` -> `$autopilot`

### 6. prd-issue-29-headless-cwd-propagation.md
- **Type**: implement
- **Rationale**: "Add a cwd or equivalent field to the headless start argument parsing", "Propagate that field through start-headless.mjs". Multi-file implementation across CLI parse, headless, backend layers.
- **Validity verdict**: valid
- **OMX skill**: `$plan` -> `$autopilot`

### 7. prd-issue-30-remote-spawn-terminal-minimize.md
- **Type**: investigate
- **Rationale**: "Reproduce the symptom reliably", "Build a minimal repro script", "Collect terminal state evidence". Explicitly an investigation PRD. Verdict was "evidence insufficient".
- **Validity verdict**: evidence insufficient
- **OMX skill**: `$plan` (investigation mode)

---

## Summary Table

| # | PRD file | Type | OMX Skill | Validity |
|---|----------|------|-----------|----------|
| 24 | prd-issue-24-remote-spawn-file-transfer | implement | `$plan` -> `$autopilot` | mostly valid |
| 25 | prd-issue-25-remote-spawn-resize-blank-screen | investigate | `$plan` only | evidence insufficient |
| 26 | prd-issue-26-remote-spawn-session-cleanup | implement | `$plan` -> `$autopilot` | valid |
| 27 | prd-issue-27-hud-dashboard-anchor | implement | `$plan` -> `$autopilot` | valid |
| 28 | prd-issue-28-headless-guard-spawn-deadlock | implement | `$plan` -> `$autopilot` | partially valid |
| 29 | prd-issue-29-headless-cwd-propagation | implement | `$plan` -> `$autopilot` | valid |
| 30 | prd-issue-30-remote-spawn-terminal-minimize | investigate | `$plan` only | evidence insufficient |

**Totals**: 5 implement, 2 investigate
