---
name: tfx-harness
description: >
  Use for meta-routing questions. Read the canonical routing SSOT and return
  exactly one branch and immediate owner; do not execute the requested work.
---

# tfx-harness — Codex adapter

This skill is a routing adapter, not an execution engine. Read D0–D11 from the
canonical routing SSOT, classify the user intent against available host
capability evidence, and return one immediate owner. Do not copy the routing
tree, keyword rules, or owner matrix into this file.

## Locate the routing SSOT

This skill is installed globally but the SSOT belongs to the Triflux project.
Try these locations in order and return blocked only when all three fail:

1. `$TFX_ROUTING_SSOT`, when set.
2. `.claude/rules/tfx-routing.md` below the main Git worktree, derived from
   the parent of `git rev-parse --git-common-dir`.
3. Walk upward from the current working directory looking for
   `.claude/rules/tfx-routing.md`.

Do not use `git rev-parse --show-toplevel` for step 2. In a linked worktree it
returns that worktree root, whose SSOT may be a stale branch snapshot.
`--git-common-dir` still points to the main repository's `.git` directory.

When blocked, include this one-line remedy:

`export TFX_ROUTING_SSOT=<triflux clone>/.claude/rules/tfx-routing.md`

Prefer `~/.zshenv` for this variable because hooks and headless workers may not
load interactive `~/.zshrc`. Do not create a global copy or symlink under
`~/.claude/rules/`; Claude auto-loads that directory into unrelated sessions.

## Return contract

Translate only host syntax. Hook-injected routing context is authoritative for
the current turn. Resolve the SSOT owner against the current Codex Available
Skills inventory, preserving the exact `$skill` name when it exists.

```text
[tfx-harness]
branch: D<n>
owner: <exactly one immediate owner>
availability: available | unavailable | unknown
fallback_notice: <optional>
status: recommendation-only | dispatching | blocked
```

- Return exactly one branch and one immediate owner.
- With unknown availability, do not infer a fallback.
- With measured unavailability, report
  `owner unavailable → tfx-X fallback` before using the fallback.
- If the SSOT cannot be read, return
  `blocked: routing SSOT unavailable` and the remedy above.
- For a “which skill/path?” question, remain recommendation-only.
- When the user clearly requests execution, read the selected downstream
  `SKILL.md`, invoke or follow that exact Codex `$skill`, and then relinquish
  routing ownership. Do not keep solving the downstream task inside this
  adapter once its owner is available.
- If the owner is unavailable, use only the fallback explicitly allowed by the
  SSOT and label the measured unavailability before dispatch.
- Do not select downstream implementation agents, models, profiles, or effort.
