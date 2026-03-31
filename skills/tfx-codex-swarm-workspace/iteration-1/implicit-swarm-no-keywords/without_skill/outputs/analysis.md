# Eval Analysis: implicit-swarm-no-keywords (without_skill)

> Eval ID: 3
> Generated: 2026-03-30
> Prompt: "이 PRD 3개 파일을 각각 독립적으로 코덱스한테 맡겨서 병렬로 구현해줘. docs/prd/auth-refactor.md, docs/prd/api-v2.md, docs/prd/cache-layer.md"
> Condition: Agent has NO tfx-codex-swarm skill loaded

## Assertion Results

| # | Assertion | Pass? | Notes |
|---|-----------|-------|-------|
| 1 | **3-paths-recognized** | PASS | Agent can parse 3 explicit paths from user prompt without any skill |
| 2 | **filename-classification** | PARTIAL | Agent recognizes "refactor" keyword but user directive "구현해줘" overrides; no formal type taxonomy available |
| 3 | **profile-routing-applied** | FAIL | No routing table exists without skill. Agent either uses flat defaults or must reverse-engineer tfx-route.sh |
| 4 | **worktree-isolation** | PARTIAL | Agent may create worktrees if it knows git worktree, but naming convention and `.codex-swarm/` structure are not discoverable without skill |
| 5 | **psmux-and-wt** | FAIL | Agent has no reason to reach for psmux unless it independently discovers `hub/team/psmux.mjs` or `scripts/tfx-route.sh` references |

**Overall: 1 PASS, 2 PARTIAL, 2 FAIL** (vs. with_skill expected: 5/5 PASS)

## Detailed Gap Analysis

### 1. Task Recognition (PASS)

Both with-skill and without-skill agents can parse the 3 file paths from the prompt.
This is basic NLP extraction and requires no specialized knowledge.

- User explicitly named: `docs/prd/auth-refactor.md`, `docs/prd/api-v2.md`, `docs/prd/cache-layer.md`
- Any agent can extract these regardless of skill availability

### 2. Classification (PARTIAL)

**With skill**: Formal 3-type taxonomy (implement/investigate/refactor) with keyword lists.
Even without file content, the skill instructs filename-based fallback classification.

**Without skill**: Agent improvises:
- Recognizes "refactor" in `auth-refactor.md` -- but has no framework to act on it
- User said "구현해줘" -- agent flattens all 3 to "implement"
- No differentiation between auth-refactor (should be refactor workflow -> `$ralph`) and api-v2 (implement -> `$autopilot`)

**Impact**: auth-refactor loses the refactoring-optimized workflow. All 3 tasks get identical treatment.

### 3. Profile Routing (FAIL)

**With skill**: Step 4 provides a 4x4 routing matrix (type x size):
- auth-refactor (refactor, L) -> `codex53_high`
- api-v2 (implement, XL) -> `codex53_xhigh`
- cache-layer (implement, M) -> `codex53_med`

**Without skill**: Agent has no routing table. Three scenarios:
- **Best case**: Discovers `tfx-route.sh`, uses `executor` type -> all get `codex53_high`
- **Typical case**: Runs `codex --full-auto` -> Codex default model, no profile
- **Worst case**: Doesn't know Codex CLI flags at all

**Impact**:
- api-v2 (likely complex) is underprovisioned without `xhigh`
- cache-layer (likely simple) is overprovisioned
- Cost-efficiency is lost; estimated 20-40% token waste on mismatched profiles

### 4. Worktree Isolation (PARTIAL)

**With skill**: Standardized `.codex-swarm/wt-{slug}` naming, branch `codex/{slug}`, PRD copy into worktree.

**Without skill**: Agent may know git worktree but:
- Naming convention is ad-hoc (no `.codex-swarm/` prefix)
- May create worktrees at project root level (messy)
- May skip worktrees entirely and run all 3 codex sessions in the same directory (conflict risk)
- No PRD file copy into worktree
- No prompt file generation (`.codex-swarm/prompts/prompt-{id}.md`)

**Impact**: Without worktree isolation, 3 parallel Codex sessions writing to the same directory will produce git conflicts and corrupted state.

### 5. psmux + WT Integration (FAIL)

**With skill**: Full psmux lifecycle:
- `psmux new-session` per task with correct `--dir`
- `psmux send-keys` with codex command + profile flags
- `psmux attach --wt-new-window` + `--wt-tab` for unified WT view
- Post-spawn status monitoring via `psmux capture-pane`

**Without skill**: Agent has no reason to use psmux:
- Most likely runs `codex &` in background (no session management)
- No WT tab integration
- No way to monitor/attach to running sessions
- No unified dashboard view

**Impact**: User loses visibility into parallel execution. No way to monitor, no tab-based overview, no session recovery if terminal closes.

## Missing Capabilities Without Skill

| Capability | With Skill | Without Skill |
|-----------|-----------|---------------|
| PRD scanning (auto-discover) | `.omx/plans/`, `.omc/plans/`, `docs/prd/` | Only user-specified paths |
| Type classification | 3-type taxonomy + keyword lists | Ad-hoc filename guessing |
| OMX skill mapping | `$plan -> $autopilot` / `$ralph` / `$plan` | None -- raw codex prompt |
| Profile routing | 4x4 matrix (type x size) | Flat or default |
| Size estimation | PRD lines + file impact + keyword complexity | Not attempted |
| Worktree naming | `.codex-swarm/wt-{slug}` standard | Ad-hoc |
| Prompt generation | Structured prompt file per task | Inline string |
| psmux sessions | Named sessions with dir binding | Background processes |
| WT integration | Tabbed window with attach | None |
| Post-spawn monitoring | `psmux capture-pane` per session | `wait` + hope |
| Result collection | `git merge codex/{slug}` workflow | Manual |
| Interactive config | AskUserQuestion for overrides | None |

## Root Cause: Why the Skill Matters

The prompt "이 PRD 3개 파일을 각각 독립적으로 코덱스한테 맡겨서 병렬로 구현해줘" contains NO explicit keywords that trigger the codex-swarm skill:
- No "swarm", "스웜", "다중 실행", "omx swarm"
- Just "코덱스한테 맡겨서 병렬로"

This is the core challenge of eval #3 (implicit-swarm-no-keywords):
- **With skill**: The skill description matches on "PRD가 여러 개이거나 병렬 Codex 실행이 필요한 모든 상황" -- this catches the implicit intent
- **Without skill**: The agent must independently reinvent the entire 10-step workflow from first principles

## Conclusion

Without the tfx-codex-swarm skill, an agent presented with this prompt will:

1. **Correctly identify** the 3 PRD paths (trivial extraction)
2. **Fail to classify** tasks by type (no taxonomy)
3. **Fail to route** profiles optimally (no routing matrix)
4. **Partially isolate** via worktrees (if it knows git worktree)
5. **Fail to orchestrate** via psmux/WT (no knowledge of project's session infra)

The resulting execution would be 3 bare `codex --full-auto` processes running in the same directory with no isolation, no monitoring, no profile optimization, and no WT integration. This is functionally equivalent to the user manually opening 3 terminals and typing codex commands -- the agent adds no orchestration value.

The skill bridges a gap between "I know what Codex is" and "I know how THIS PROJECT orchestrates Codex at scale." That project-specific knowledge (worktree conventions, psmux patterns, profile routing, OMX skill mapping) cannot be inferred from the prompt alone.
