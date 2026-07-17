---
name: tfx-harness
description: >
  Use for meta-routing questions. Read the canonical routing SSOT and return
  exactly one branch and immediate owner; do not execute the requested work.
---

# tfx-harness — Codex adapter

Read `.claude/rules/tfx-routing.md` D0–D11 before routing. This adapter only
translates host syntax: use `$skill` for an available owner. Do not copy the
routing tree, keyword rules, or an owner matrix here.

Return:

```text
[tfx-harness]
branch: D<n>
owner: <exactly one immediate owner>
availability: available | unavailable | unknown
fallback_notice: <optional>
status: recommendation-only | dispatching | blocked
```

- Never choose more than one branch or immediate owner.
- With unknown availability, do not infer a fallback. With measured
  unavailability, state `owner unavailable → tfx-X fallback` before fallback.
- If the SSOT cannot be read, return `blocked: routing SSOT unavailable`.
- For a “which skill/path?” question, remain recommendation-only.
- Do not select downstream implementation agents or models.
