# PRD Classification (without skill guidance)

> Generated: 2026-03-30
> Source: user-specified paths (3 PRDs)
> Prompt: "이 PRD 3개 파일을 각각 독립적으로 코덱스한테 맡겨서 병렬로 구현해줘"
> Mode: **no skill** — agent infers workflow from project infrastructure only

## Input Recognition

User explicitly provided 3 file paths:

| # | PRD File | Exists |
|---|----------|--------|
| 1 | `docs/prd/auth-refactor.md` | No (simulated) |
| 2 | `docs/prd/api-v2.md` | No (simulated) |
| 3 | `docs/prd/cache-layer.md` | No (simulated) |

## Filename-Based Type Classification

Since the PRD files do not exist (simulated scenario), classification relies entirely on filename heuristics:

| # | PRD File | Inferred Type | Reasoning |
|---|----------|---------------|-----------|
| 1 | `auth-refactor.md` | **refactor** (리팩터링) | Filename contains "refactor" -- clear refactoring signal |
| 2 | `api-v2.md` | **implement** (구현) | "v2" implies new version/feature implementation |
| 3 | `cache-layer.md` | **implement** (구현) | "layer" implies new subsystem/feature implementation |

## Classification Logic Applied

Without skill guidance, the agent has NO formal classification table. Instead it relies on:

1. **Filename keyword matching** (ad-hoc):
   - "refactor" in filename -> refactoring task
   - "v2", "new", "layer" -> implementation task
   - No "investigation"/"조사" signals detected

2. **User directive parsing**:
   - "구현해줘" (implement) -- user explicitly said "implement" for all 3
   - This overrides any filename-based classification

3. **Conflict**: Filename says "refactor" for auth-refactor, but user says "구현해줘" for all.
   Without skill guidance, the agent likely treats all 3 as implementation tasks per user directive.

## Final Classification

| # | PRD File | Final Type | Rationale |
|---|----------|-----------|-----------|
| 1 | `auth-refactor.md` | **implement** | User said "구현해줘"; overrides filename "refactor" signal |
| 2 | `api-v2.md` | **implement** | User said "구현해줘"; filename aligns |
| 3 | `cache-layer.md` | **implement** | User said "구현해줘"; filename aligns |

## Observations (vs. with-skill behavior)

- **No formal classification table**: The skill provides a 3-type taxonomy (implement/investigate/refactor) with keyword lists. Without it, the agent must improvise.
- **No OMX skill mapping**: No `$plan -> $autopilot` or `$plan -> $ralph` differentiation. The agent likely does not mention OMX skills at all.
- **User override dominance**: "구현해줘" flattens all tasks to implement, losing the nuance that auth-refactor might benefit from a refactoring workflow (`$ralph`).
- **No PRD content analysis**: Since files don't exist, both with-skill and without-skill variants rely on filenames. But the skill variant would explicitly note the absence and still apply its classification table.
