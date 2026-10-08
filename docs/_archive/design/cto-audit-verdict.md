> 폐기: `tfx cto` 와 CTO lake 기록을 지웠다. ADR-0035, ADR-0012.

# CTO Console — Independent Audit Verdict & Architecture Decisions

> Independent cross-check (separate-context Opus critic) of the autoresearch
> conclusion at `.omx/goals/autoresearch/cto-lake-existing-feature-research/evidence-matrix.md`,
> run before building. Satisfies the project's no-self-approval rule (the original
> research "PASS" was a self-assessment + trivial critic gate).

## Verdict: PASS_WITH_CONCERNS

Core conclusion confirmed sound: no full cross-agent CTO/lake console exists in the
stack (no `tfx cto` command, no aggregator over `.omx/ultragoal` + `.omc/ultragoal`,
the only dashboards are operational Hub/broker surfaces). "Reuse native engines, build
a thin authority layer" is the right instinct.

## Concerns and how they were resolved

| # | Sev | Concern | Resolution |
|---|-----|---------|------------|
| 1 | P1 | Proposed `.omx/lake` triad duplicates the existing `.omx/ultragoal` triad (`goals.json`+`ledger.jsonl`+`brief.md`); "extend vs new sibling" was never evaluated. | **DECISION:** Move the store out of the `.omx/` (OMX) namespace to triflux-owned **`.triflux/lake/`**. Keep it as a SEPARATE **cross-agent rollup** that reads/aggregates `.omx/ultragoal` + `.omc/ultragoal` + gstack/gbrain/synapse — it does not duplicate or replace their per-goal authority. Namespace-neutral because it tracks Claude/Codex/AGY/gstack, not just OMX. |
| 2 | P2 | `ledger.jsonl` concurrent-writer corruption (machine allows up to 10 workers); no writer model specified. | **Applied:** `ledger.jsonl` is append-only AND single-writer via a `.triflux/lake/ledger.jsonl.lock` (mirrors the repo's existing `${file}.lock` pattern). |
| 3 | P2 | Source-probe brittleness; "cross-agent" oversells what is collectable. Live Claude `/goal` and AGY state are not shell-readable. | **Applied:** Collection scope = durable ARTIFACTS only. `sources.*` entries carry `available:false` when a surface exposes no shell-readable artifact. Documented in schema + design doc. |
| 4 | P2 | Original research "PASS" was self-approval + a trivial critic gate (`grep -qi Decision`), no adversarial scrutiny. | This independent audit is the first real gate; concerns above raised the bar accordingly. |
| 5 | P3 | `lake` collides with the internal "Neural Memory Lake N" concept. | User chose to keep `lake` (now at `.triflux/lake`, a distinct path/context). Noted; not blocking. |
| 6 | P3 | `synapse` (live cross-session/host registry) not examined; `tfx cto status` should read from it rather than re-derive. | **Applied:** `tfx cto status` reads live-session data from synapse (persisted synapse snapshots). |

## Net architecture (initial audit)

The current command scope is defined by [ADR-0024](../adr/0024-cto-explicit-queries-only.md).

- Store: `.triflux/lake/{current.json, current.md, ledger.jsonl, sources.json}` (git-ignored runtime).
- Contract: `cto/current.schema.json` (tracked, lives with the code).
- Commands: `tfx cto collect` (aggregate durable artifacts to current.json and append a ledger event), `tfx cto status` (snapshot and live sessions), `tfx cto hygiene --dry-run` (dry-run report).
- Refresh: explicitly run `tfx cto collect`; `status` shows snapshot age.
- Non-goal: does NOT reimplement goal/scheduler/memory engines; reads them only.
