# Analysis: Selective Spawn without SKILL.md Guidance

> Generated: 2026-03-30
> Eval: `selective-spawn-with-override` (eval_id: 2)
> Variant: `without_skill`

## Task Summary

**User request**: "issue 24하고 28번 PRD만 코덱스 스폰해줘. 둘 다 xhigh로 세팅하고 ralph로 끝까지 돌려"

**Decomposed requirements**:
1. Select only issues 24 and 28 from the 7 available PRDs
2. Override effort level to `xhigh` for both sessions
3. Use `$ralph` workflow (persist until complete) instead of default `$autopilot`
4. Spawn as Codex sessions (not Claude Code)

## Approach Without Skill Guidance

Without the `tfx-codex-swarm` SKILL.md, the agent must rely on:

### Knowledge Sources Used

| Source | What it provided |
|--------|-----------------|
| `.omc/codex-spawn/codex-prd-launcher.sh` | Existing launcher pattern: `codex exec --full-auto` with `-c` flag config overrides |
| `.omc/codex-spawn/spawn-all.sh` | WT tab spawning pattern using `wt.exe -w new` with `new-tab` chaining |
| `.omc/codex-spawn/prompt-{24,28}.md` | Existing prompt templates for these specific issues |
| `~/.codex/config.toml` | Available profiles including `codex53_xhigh` with exact model/effort settings |
| `.omx/plans/prd-issue-{24,28}.md` | Full PRD content for classification and prompt generation |
| `tui/codex-profile.mjs` | Effort levels: `low`, `medium`, `high`, `xhigh` |
| `hub/workers/codex-mcp.mjs` | Codex MCP API surface: model, profile, approvalPolicy, config options |
| `skills/tfx-ralph/SKILL.md` | Ralph = tfx-persist alias, Tri-Verified Persistence Loop, tier degradation |
| `.omx/tmux-hook.json` | OMX tmux injection supports ralph/ultrawork/team modes |

### What the Skill Would Have Provided

The `tfx-codex-swarm` SKILL.md provides a structured 10-step workflow:

1. **Task file scan** with defined search paths (`.omx/plans/*.md`, `.omc/plans/*.md`, `docs/prd/*.md`)
2. **AskUserQuestion-based selection** UI with "전체/선택/최근" options
3. **Automatic type classification** table (implement/investigate/refactor)
4. **Size-based profile routing** with explicit thresholds (XL/L/M/S)
5. **Profile-to-flag mapping** table
6. **Worktree naming convention** (`.codex-swarm/wt-issue-{N}`)
7. **Prompt template** structure
8. **psmux session + Codex launch** commands
9. **WT tab attach** with psmux-first and wt.exe fallback
10. **Post-spawn management** (status, merge, cleanup)

### Decisions Made Without Skill

| Decision | Without Skill | With Skill |
|----------|--------------|------------|
| PRD location | Found via `Glob **/*prd*` | Defined scan paths in Step 1 |
| Selection method | Direct from user request ("24하고 28번") | AskUserQuestion UI (Step 2) |
| Classification | Manual PRD content analysis | Keyword table lookup (Step 3) |
| Profile routing | Matched user "xhigh" to `codex53_xhigh` in config.toml | Size assessment -> routing table -> override flow (Step 4) |
| Worktree path | Copied `.codex-swarm/wt-issue-{N}` from existing patterns | Defined in Step 5 |
| Prompt structure | Based on existing `.omc/codex-spawn/prompt-{24,28}.md` | Template in Step 6 |
| Execution mode | `codex` interactive (not `codex exec`) for OMX skill compat | Explicit in Step 7 note |
| WT attach | psmux attach + wt.exe fallback from spawn-all.sh | Defined in Step 8 |

## Critical Difference: `codex` vs `codex exec`

The existing `codex-prd-launcher.sh` uses `codex exec --full-auto` (non-interactive). However, this is **incompatible with OMX skills** like `$ralph`. The SKILL.md Step 7 explicitly notes:

> "Codex 대화식 모드 실행 -- OMX 스킬($plan, $autopilot 등)이 동작하려면 대화식 필수"
> "codex exec(비대화식)에서는 OMX $skill이 트리거되지 않으므로 반드시 대화식으로 실행"

Without skill guidance, an agent might incorrectly use `codex exec --full-auto` (copying the launcher pattern), which would silently prevent `$ralph` from activating. The without_skill variant here correctly uses interactive `codex` (without `exec`) because the `$ralph` requirement was analyzed against the tfx-ralph SKILL.md.

## Assertion Compliance

Per `eval_metadata.json`:

| Assertion | Status | Evidence |
|-----------|--------|----------|
| `only-2-selected` | PASS | commands.sh contains only issue-24 and issue-28. No references to 25, 26, 27, 29, 30. Exactly 2 `git worktree add`, 2 `psmux new-session`, 2 `psmux send-keys` |
| `xhigh-override` | PASS | routing.md shows `codex53_xhigh` for both. commands.sh uses `model_reasoning_effort="xhigh"` in both send-keys commands |
| `ralph-skill` | PASS | Prompts contain "$ralph 스킬로 완료될 때까지 반복 실행하세요". classification.md shows `$ralph (user override)` |
| `worktree-2-only` | PASS | commands.sh has exactly 2 `git worktree add` commands (wt-issue-24, wt-issue-28) |

## Risk Notes

1. **Interactive mode requirement**: Without SKILL.md, an agent could default to `codex exec` from the existing launcher, breaking `$ralph` activation
2. **Profile existence**: `codex53_xhigh` must exist in `~/.codex/config.toml` -- verified present
3. **OMX tmux hook**: `.omx/tmux-hook.json` confirms ralph is in `allowed_modes`, so tmux injection will function
4. **Tier degradation**: `$ralph` (= tfx-persist) has a 3-tier degradation chain. If psmux/Hub/Codex are unavailable, it falls back to Tier 3 (Claude Agent only). The commands assume Tier 1 (full stack available)
