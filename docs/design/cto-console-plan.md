# CTO Console Plan

## Purpose

`tfx cto` is a repo-local authority layer for Triflux state. It is not a new agent, scheduler, goal engine, memory engine, or orchestration runtime. It reads existing repo-local and optional host-local authority sources, records a compact snapshot under `.triflux/lake/`, and gives operators one place to inspect current state.

`.triflux/lake/` is a triflux-owned, namespace-neutral CTO authority store. It is intentionally not under `.omx/` because it tracks all agents and adjacent systems, including Claude, Codex/OMX, OMC, AGY, gstack, gbrain, and Triflux runtime state.

The CTO lake is a cross-agent rollup, distinct from `.omx/ultragoal` and `.omc/ultragoal`. Those ultragoal stores remain per-goal execution ledgers owned by their engines; the CTO layer reads and aggregates them without replacing or duplicating their authority.

Research basis: `.omx/goals/autoresearch/cto-lake-existing-feature-research/evidence-matrix.md`.

## Lake Layout

- `.triflux/lake/current.json`: machine-readable authority snapshot. The field contract is defined by `cto/current.schema.json`.
- `.triflux/lake/current.md`: human-readable brief generated from the same snapshot.
- `.triflux/lake/ledger.jsonl`: append-only event ledger. Collectors append line-shaped events; readers never rewrite history.
- `.triflux/lake/ledger.jsonl.lock`: single-writer append lock acquired before writing `ledger.jsonl`, mirroring the existing `${file}.lock` pattern used elsewhere in this repo.
- `.triflux/lake/sources.json`: source registry containing `{ id, kind, probe, enabled }[]`.

## Collector Source Contract

Every source reports `{ available, status, detail, collected_at }`.

Collection scope is durable artifacts only. Live Claude `/goal` state and AGY internal state are not shell-collectable. The collector reads durable artifacts such as `.omx/ultragoal/{goals.json,ledger.jsonl,brief.md}`, `.omc/ultragoal/*`, gstack checkpoints, gbrain, tfx synapse/hub/swarm/team status, `.omx/handoffs`, and Session Vault references. A source uses `available:false` when the surface exposes no shell-readable artifact.

Required source IDs:

- `git`: repo root, branch, head, dirty state, and recent status context.
- `tfx_hub`: hub availability and status.
- `tfx_swarm`: swarm runtime status.
- `tfx_team`: team runtime status.
- `tfx_synapse`: synapse status.
- `ultragoal_omx`: `.omx/ultragoal` state.
- `ultragoal_omc`: `.omc/ultragoal` state.
- `handoffs`: `.omx/handoffs` references.
- `session_vault`: Session Vault references when available.
- `agy`: AGY references when available.
- `gbrain`: optional gbrain references when available.

Collectors must be read-only against upstream engines. They may write only the lake files they own. `tfx cto status` reads live-session data from synapse (`tfx synapse status` / `hub/team/synapse-registry.mjs`) rather than re-deriving it.

`ledger.jsonl` is append-only and single-writer. A collector must acquire `.triflux/lake/ledger.jsonl.lock` before appending so concurrent collectors on this machine cannot interleave or corrupt JSONL lines.

## Commands

- `tfx cto collect`: refresh `.triflux/lake/current.json`, `.triflux/lake/current.md`, and append `.triflux/lake/ledger.jsonl` events.
- `tfx cto status`: print the current authority summary from `.triflux/lake/current.json`, with live sessions read through synapse.
- `tfx cto dashboard --watch`: render a dashboard view and refresh while watching the lake state.

## Cadence Defaults

- Dashboard UI refresh: 1 minute.
- Collector refresh: 5 minutes.
- Brief refresh: 30 minutes.

## Non-Goals

Do not reimplement goal, scheduler, memory, Session Vault, AGY, gbrain, hub, swarm, team, or synapse engines. The CTO collector reads existing sources and records their authority state; it does not become the authority for those systems.
