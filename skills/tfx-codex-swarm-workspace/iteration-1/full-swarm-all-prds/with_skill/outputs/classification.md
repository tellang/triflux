# Codex Swarm - PRD Classification Table

> Generated: 2026-03-30
> Source: `.omx/plans/prd-issue-{24..30}.md` (7 PRDs)
> User directive: "구현은 autopilot, 조사는 plan만 쓰고"

## Classification

| # | PRD File | Type | Keywords Found | User Override | OMX Skill |
|---|----------|------|----------------|---------------|-----------|
| 24 | `prd-issue-24-remote-spawn-file-transfer.md` | **implement** (구현) | "추가", "변경" | autopilot | `$plan` -> `$autopilot` |
| 25 | `prd-issue-25-remote-spawn-resize-blank-screen.md` | **investigate** (조사) | "조사", "investigation", "재현", "reproduce" | plan only | `$plan` |
| 26 | `prd-issue-26-remote-spawn-session-cleanup.md` | **implement** (구현) | "추가", "변경" | autopilot | `$plan` -> `$autopilot` |
| 27 | `prd-issue-27-hud-dashboard-anchor.md` | **implement** (구현) | "변경", "개선" | autopilot | `$plan` -> `$autopilot` |
| 28 | `prd-issue-28-headless-guard-spawn-deadlock.md` | **implement** (구현) | "변경", "fix" | autopilot | `$plan` -> `$autopilot` |
| 29 | `prd-issue-29-headless-cwd-propagation.md` | **implement** (구현) | "변경" | autopilot | `$plan` -> `$autopilot` |
| 30 | `prd-issue-30-remote-spawn-terminal-minimize.md` | **investigate** (조사) | "조사", "investigation", "재현", "reproduce" | plan only | `$plan` |

## Classification Logic

Per SKILL.md Step 3:

- **implement**: PRD content contains "구현", "implement", "추가", "변경", "fix"
- **investigate**: PRD content contains "조사", "investigation", "재현", "reproduce"
- **refactor**: PRD content contains "리팩터", "refactor", "정리", "개선"

User explicitly overrode skill assignment:
- All **implement** tasks -> `$plan` -> `$autopilot` (not `$ralph`)
- All **investigate** tasks -> `$plan` only (no follow-up execution)

## Summary

- **5 implement** tasks: issues 24, 26, 27, 28, 29
- **2 investigate** tasks: issues 25, 30
- **0 refactor** tasks
