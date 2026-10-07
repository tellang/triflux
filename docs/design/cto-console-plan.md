# CTO Console Plan

## Purpose

`tfx cto` is a repo-local authority layer for Triflux state. It is not a new agent, scheduler, goal engine, memory engine, or orchestration runtime. It reads existing repo-local and optional host-local authority sources, records a compact snapshot under `.triflux/lake/`, and gives operators one place to inspect current state.

`.triflux/lake/` is a triflux-owned, namespace-neutral CTO authority store. It is intentionally not under `.omx/` because it tracks repo-local state across Triflux and adjacent systems.

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

Collection scope is durable artifacts only. Live Claude `/goal` state is not shell-collectable. The collector reads durable artifacts such as `.omx/ultragoal/{goals.json,ledger.jsonl,brief.md}`, `.omc/ultragoal/*`, gstack checkpoints, tfx synapse/hub/swarm/team status, and `.omx/handoffs`. A source uses `available:false` when the surface exposes no shell-readable artifact.

Required source IDs:

- `git`: repo root, branch, head, dirty state, and recent status context.
- `tfx_hub`: hub availability and status.
- `tfx_swarm`: swarm runtime status.
- `tfx_team`: team runtime status.
- `tfx_synapse`: synapse status.
- `ultragoal_omx`: `.omx/ultragoal` state.
- `ultragoal_omc`: `.omc/ultragoal` state.
- `handoffs`: `.omx/handoffs` references.

Collectors must be read-only against upstream engines. They may write only the lake files they own. `tfx cto status` reads live-session data from synapse (persisted synapse snapshots) rather than re-deriving it.

`ledger.jsonl` is append-only and single-writer. A collector must acquire `.triflux/lake/ledger.jsonl.lock` before appending so concurrent collectors on this machine cannot interleave or corrupt JSONL lines.

## Host-Local Source Boundary

The collector is repo-local first. It reads `.triflux/*`, `.omx/*`, `.omc/*`, and other durable repo artifacts before considering host-local Triflux caches under `~/.claude/cache/tfx-hub/*`. Host-local cache reads are a discovery fallback for operators who want one CTO view of active local Triflux runtime state; they are not written back to upstream engines and can be disabled in tests or library calls with `includeHostArtifacts:false`.

Because host-local cache files may be shared by multiple checkouts, every collected source remains tagged by `sources.{id}` plus `.triflux/lake/sources.json`. Consumers must treat the lake as a snapshot of readable evidence, not as ownership over the underlying systems.

## Prompt Boundary

`current.md` is injected only as read-only context. Hook and route injectors wrap it with explicit `CTO NORTH STAR - READ ONLY` boundaries. Injection is off by default and requires `TFX_CTO_NORTH_STAR=1` ([ADR-0018](../adr/0018-cto-auto-behaviors-opt-in.md)).

## Commands

- `tfx cto collect`: refresh `.triflux/lake/current.json`, `.triflux/lake/current.md`, and append `.triflux/lake/ledger.jsonl` events.
- `tfx cto status`: print the current authority summary from `.triflux/lake/current.json`, with live sessions read through synapse.
- `tfx cto hygiene --dry-run`: report dry-run hygiene findings without moving files.

## Cadence Defaults

Collection is explicitly requested with `tfx cto collect`. `status` reports the snapshot generation time and age so a stale lake is visible.

## Non-Goals

Do not reimplement goal, scheduler, memory, Session Vault, AGY, gbrain, hub, swarm, team, or synapse engines. The CTO collector reads existing sources and records their authority state; it does not become the authority for those systems.
