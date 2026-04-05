# Codex Swarm - PRD Classification (Selective: Issue 24, 28)

> Generated: 2026-03-30
> Source: `.omx/plans/prd-issue-{24,28}.md` (2 PRDs selected from 7 total)
> User directive: "issue 24하고 28번 PRD만 코덱스 스폰해줘. 둘 다 xhigh로 세팅하고 ralph로 끝까지 돌려"
> Mode: without_skill (no SKILL.md guidance)

## Selection Filter

User explicitly requested **only issue 24 and 28**. Issues 25, 26, 27, 29, 30 are excluded.

## Classification

| # | PRD File | Type | Keywords Found | OMX Skill |
|---|----------|------|----------------|-----------|
| 24 | `prd-issue-24-remote-spawn-file-transfer.md` | **implement** | "추가", "변경", "전송" | `$ralph` (user override) |
| 28 | `prd-issue-28-headless-guard-spawn-deadlock.md` | **implement** | "변경", "개선", "추가" | `$ralph` (user override) |

## Classification Logic (without SKILL.md)

Without skill guidance, classification is inferred from PRD content analysis:

- **Issue 24**: PRD describes adding a file-transfer phase to `remote-spawn.mjs`. Contains action words "추가" (add), "변경" (change). Clear implementation task.
- **Issue 28**: PRD describes improving `headless-guard.mjs` denial messages and adding regression tests. Contains "변경" (change), "개선" (improve), "추가" (add). Clear implementation task.

Both would auto-classify as **implement** under normal routing, which maps to `$plan -> $autopilot`. However, the user explicitly requested `$ralph` (persist until done), overriding the default skill assignment for both tasks.

## User Override Summary

| Override | Default | Applied |
|----------|---------|---------|
| Task selection | all 7 PRDs | **2 PRDs only** (24, 28) |
| OMX skill | `$plan -> $autopilot` | **`$ralph`** (끝까지 돌려) |
| Profile/effort | auto-routed per size | **xhigh forced** (둘 다 xhigh) |

## Summary

- **2 implement** tasks selected: issues 24, 28
- **5 excluded**: issues 25, 26, 27, 29, 30
- **Skill override**: `$ralph` for both (user: "ralph로 끝까지 돌려")
