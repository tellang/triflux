# PRD — Hub Interactive Session Peer-Discovery

- **Status**: Draft (PRD only — no implementation)
- **Repo**: triflux (origin/main = v10.28.1)
- **Owner lane**: Codex (default CLI), Claude critic on review pass
- **Blast radius (estimate)**: 5 source files + 3 test files + packages mirror (~14–18 files total). See §10–11.
- **Design validation**: Codex single-lane consensus (architect, gpt55_xhigh) confirmed all five design decisions; refinements folded in (sessionKind discriminator, cwd redaction via label/hash, new `/synapse/peers` route, additive schema). See §12 ADR.

---

## 1. Context / Problem

Hub's multi-session tracking exists for **AI worker orchestration** (headless swarm/multi workers).
**Interactive** Claude/Codex sessions running in the same directory are not auto-registered in any
registry, so they cannot discover each other. Three concrete blockers (confirmed by read-only
investigation):

1. **No self-register at SessionStart.** `hooks/session-start-fast.mjs:70-95` only calls
   `hub-ensure.run()` inside the BLOCKING phase. It never registers the current session.
2. **Headless register omits git context.** The only existing auto-register path
   (`hub/team/headless.mjs:1508-1520`) posts `/synapse/register` with `sessionId`/`host`/
   `taskSummary`/`isRemote` only — `worktreePath` and `branch` are left empty.
3. **No peer-lookup API.** There is no way to ask "which other sessions share my cwd / worktree?"
   `getSessionsByWorktree` / `getSessionsByCwd` do not exist; there is no `/synapse/peers` route.

**Why this is cheap to build (~70% already there):** the Synapse Registry
(`hub/team/synapse-registry.mjs`) is the schema SSOT via `sanitizeSession()` and already provides
`worktreePath` + `branch` + `dirtyFiles` + per-session heartbeat monitor + debounced persist.
HTTP routes `GET /synapse/sessions` and `POST /synapse/{register,heartbeat,unregister}` exist
(`hub/server.mjs:1302-1362`). A reusable fire-and-forget HTTP client already exists
(`hub/team/synapse-http.mjs`) with an injectable `fetchImpl` for hermetic tests.

### Key file anchors (read-only confirmed)

| Concern | File:line |
|---|---|
| Schema SSOT (`sanitizeSession`) | `hub/team/synapse-registry.mjs:23-42` |
| Local TTL / heartbeat constants | `hub/team/synapse-registry.mjs:4-7` (local timeout 30s, interval 5s; remote 90s/15s) |
| Registry methods | `hub/team/synapse-registry.mjs:178-328` |
| HTTP routes | `hub/server.mjs:1302-1362` |
| Registry instantiation (persistPath) | `hub/server.mjs:997-1000` |
| Reusable HTTP client | `hub/team/synapse-http.mjs` |
| SessionStart fast-path | `hooks/session-start-fast.mjs:70-95, 188-214` |
| SessionEnd report-only hook | `hooks/session-end-cleanup.mjs:292-332` |
| Headless register (no worktreePath) | `hub/team/headless.mjs:1504-1520` |
| publicSnapshot redaction precedent | `hub/account-broker.mjs:1073-1090` |
| git context helper pattern | `scripts/lib/handoff.mjs:103-105` |

---

## 2. Work Objectives

Make interactive Claude/Codex sessions discover co-located peers (same cwd / same worktree) by
**reusing the existing Synapse Registry** rather than building a parallel registry.

1. Add `cwd`, `pid`, and a `sessionKind` discriminator to the session schema (additive, backward-compatible).
2. Auto-register the current session at SessionStart (fire-and-forget, never blocks startup).
3. Unregister at SessionEnd (report-only hook stays report-only; adds one best-effort POST).
4. Add a peer-lookup API: registry filters + a new redacted `GET /synapse/peers` route with self-exclusion.
5. Use an interactive-appropriate TTL (5 min) and an `idle` state distinct from `stale`.
6. Keep raw `cwd`/`pid` internal; the peer route returns redacted labels (publicSnapshot precedent).
7. Hermetic tests (unit + integration) with no real hub process.
8. Sync packages/{core,remote,triflux} mirrors per `.claude/rules/tfx-mirror-policy.md`.

---

## 3. Guardrails

### Must Have
- Backward-compatible persist: existing `synapse-sessions.json` (no `cwd`/`pid`/`sessionKind`) loads cleanly.
- Fire-and-forget on the hook side: hub down/unreachable must NOT block session start or end.
- `GET /synapse/peers` excludes the caller's own session.
- Raw `pid` never exposed in the peer route; `cwd` exposed only as redacted label/hash by default.
- Reuse `synapse-http.mjs` for register/unregister (DRY — do not write a second HTTP client).
- Reuse the existing git pattern (`git rev-parse --show-toplevel` / `--abbrev-ref HEAD`,
  cf. `scripts/lib/handoff.mjs:103-105`) — do not invent a new git-context module.

### Must NOT Have (Ocean — defer to separate PRDs; see §9)
- Session-to-session real-time messaging.
- Peer-aware lock arbitration (swarm locks stay as-is).
- HUD / TUI / UX surfaces for peers.
- Process attach / kill / signal of discovered peers.
- Cross-host federation, auth/identity policy expansion.
- Changes to headless worker orchestration semantics beyond optionally filling git context.

---

## 4. Task Flow

```
[1] Schema (registry)        → cwd/pid/sessionKind additive + sanitize defaults + TTL branch + idle state
[2] Auto-register (hook)     → SessionStart fire-and-forget self-register (reuse synapse-http)
[3] Unregister (hook)        → SessionEnd best-effort unregister (reuse synapse-http)
[4] Peer API (registry+route)→ querySessions() filter + redacted GET /synapse/peers + self-exclude
[5] Tests (hermetic)         → unit (defaults/filter/TTL) + integration (2-session mutual discovery)
[6] Mirror sync (same PR)    → packages/{core,remote,triflux} per mirror-policy
```

Steps 1 and 4 are registry-internal and can land together; 2 and 3 are hook changes; 5 follows; 6 is in-PR.

---

## 5. Schema (Decision: additive, no version bump)

Extend `sanitizeSession()` (`hub/team/synapse-registry.mjs:23-42`) with three optional fields,
all graceful-defaulted so old persist files load unchanged:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `cwd` | string | `""` | Current working directory of the session (raw, internal-only). |
| `pid` | number \| null | `null` | OS pid (raw, internal-only; never in peer route). |
| `sessionKind` | `"interactive"` \| `"headless"` | `"headless"` | Discriminator. Drives TTL + `idle` policy (§7). Default `"headless"` preserves current behavior for existing rows. |

- **No persist version bump.** `sanitizeSession` already restores missing fields from defaults, so
  pre-existing `synapse-sessions.json` rows hydrate as `cwd:""`, `pid:null`, `sessionKind:"headless"`.
  A version bump is reserved for changes that would *mislead* an old reader (field rename/removal,
  status-meaning change) — none here.
- `heartbeat()` partial-merge (`:229-270`) gains optional handling for `cwd` (string) and `pid` (number);
  `sessionKind` is set at register time and treated as immutable on heartbeat.
- `cloneSession()` already spreads all fields, so persist round-trips the new fields automatically.

### Acceptance criteria
- Loading a persist file written by current code (no new fields) yields rows with the three defaults; no throw.
- A round-trip (register → persist → restore) preserves `cwd`/`pid`/`sessionKind`.

---

## 6. Auto-register at SessionStart (Decision 2)

Add a fire-and-forget self-register in `hooks/session-start-fast.mjs`. The hook already receives the
raw `stdinData` JSON (passed to `hub-ensure.run(stdinData)`); Claude Code's SessionStart payload
carries `session_id`, `cwd`, and `hook_event_name`.

- **Where**: the existing fire-and-forget lane. Preferred: a new BACKGROUND task in `runBackground()`
  (`:171-178`) — strictly best-effort, never affects the blocking stdout returned to the prompt.
  Alternative: a DEFERRED task in `runDeferred()` (`:105-164`, logged). See Open Questions §13.
- **Payload**: `{ sessionId, cwd, pid: process.pid, worktreePath, branch, host: "local",
  sessionKind: "interactive", isRemote: false }`.
  - `worktreePath` / `branch` from the existing git pattern run against `cwd`. If git fails (non-repo),
    send `worktreePath: cwd, branch: ""`.
- **Transport**: reuse `registerSynapseSession(meta, opts)` from `hub/team/synapse-http.mjs`
  (fire-and-forget, swallows errors). Hub down → silent no-op. **Hard requirement: zero added latency to
  the BLOCKING path.**
- **Duplicate guard**: `register()` rejects duplicate `sessionId` (`:188-194`). For interactive sessions a
  duplicate is benign — reject-and-ignore is acceptable (see Open Questions §13).

### Acceptance criteria
- With a mocked `fetchImpl`, SessionStart posts `/synapse/register` with the full interactive payload.
- With hub unreachable (fetch rejects), `execute()` still returns its normal blocking stdout unchanged.

---

## 7. Heartbeat / TTL policy (Decision 5 — Codex: 5 min + idle state)

Interactive sessions idle for long stretches; the current 30s local timeout produces stale
false-positives. Register-only + SessionEnd-unregister is **insufficient** alone: crash, terminal kill, or
a missed SessionEnd leaves a zombie peer.

**Recommendation (Codex-validated):**
- **Interactive TTL = 5 minutes** (`DEFAULT_INTERACTIVE_TIMEOUT_MS = 300_000`), best-effort heartbeat
  interval 30–60s (`DEFAULT_INTERACTIVE_HEARTBEAT_INTERVAL_MS`).
- Add an **`idle`** status distinct from `stale`: when an interactive session exceeds the heartbeat
  interval but is under the TTL, it is "alive but inactive" (`idle`), not "presumed dead" (`stale`).
  `stale` remains the post-TTL state. (Note: `sanitizeSession` currently only accepts
  `stale`/`expired`/`active` for `status` — adding `idle` to that allow-list is part of this step.)
- TTL selection follows `sessionKind`: `intervalFor()` / `timeoutFor()` (`:63-71`) branch on
  `sessionKind === "interactive"` alongside the existing `isRemote` branch. Headless keeps 30s; remote keeps 90s.

**Heartbeat source** is the open-question driver (§13):
1. **Register-only + 5-min TTL, no periodic heartbeat** (simplest; a quiet-but-alive session goes
   `idle`→`stale` after 5 min — acceptable for discovery; peers re-query). **Recommended minimum.**
2. UserPromptSubmit hook as an implicit heartbeat (each user turn re-heartbeats). Lake-safe only if a
   UserPromptSubmit hook surface already exists; otherwise it adds a hook surface — verify before adopting.

The registry-side TTL/idle state machine is in-scope regardless; the heartbeat *trigger* is the user decision.

### Acceptance criteria
- An interactive session with `lastHeartbeat` 31s–4m59s old is NOT `stale` (asserted via advanced/injected clock).
- An interactive session past 5 min becomes `stale`; a headless session past 30s still becomes `stale`.

---

## 8. Unregister at SessionEnd (Decision 3)

`hooks/session-end-cleanup.mjs` stays **report-only** in spirit. Add exactly one best-effort POST:

- In `run(input, env)` (`:292-332`), after the existing report path, call
  `unregisterSynapseSession(sessionId, opts)` from `synapse-http.mjs` using `session_id` from the parsed
  stdin payload.
- Fire-and-forget; failure swallowed; never throws; never changes the hook's stdout contract.
- No process/config side effects — consistent with the hook's existing charter.
- **Crash safety**: if SessionEnd never fires, the 5-min TTL (§7) eventually marks the row `stale`, so
  unregister is an optimization, not a correctness dependency.

### Acceptance criteria
- With a mocked `fetchImpl`, SessionEnd posts `/synapse/unregister` with the session id.
- With hub unreachable, the hook's existing report-only stdout is byte-identical to today's.

---

## 9. Peer-lookup API (Decision 4 — new `/synapse/peers`, redacted)

### 9.1 Registry filter (new)
Add to the frozen return object (`:317-328`):
- `querySessions({ cwd?, worktree?, excludeSessionId? })` — single primitive (DRY; explicit-over-clever
  favors one clear query entrypoint). Optional thin `getSessionsByCwd(cwd)` /
  `getSessionsByWorktree(path)` wrappers only if call sites want them. **Recommended: one
  `querySessions()`.**
- Filters over `active` and `idle` sessions (exclude `stale`/`expired` from peer results by default).
- Self-exclusion via `excludeSessionId` (most explicit; Codex-preferred over implicit caller inference).

### 9.2 New HTTP route (keep `/synapse/sessions` as the raw admin snapshot)
`GET /synapse/peers?cwd=<>&worktree=<>&excludeSessionId=<>` next to existing synapse routes (`:1302-1362`):
- Resolves `querySessions(...)`, applies `excludeSessionId`.
- **Returns a redacted projection** (publicSnapshot precedent, `hub/account-broker.mjs:1073-1090`) built by
  a pure exported `projectPeer()` (so tests exercise redaction without HTTP):

  | Field | Exposed? | Form |
  |---|---|---|
  | `sessionId` | yes | as-is |
  | `branch` | yes | as-is |
  | `sessionKind` | yes | as-is |
  | `status` | yes | `active` / `idle` |
  | `sameCwd` / `sameWorktree` | yes | boolean (computed vs. caller args) |
  | `cwdLabel` | yes | basename / last path segment of cwd |
  | `cwdHash` | yes | short stable hash of full cwd (correlate without leaking path) |
  | `worktreeLabel` | yes | basename of worktree |
  | `cwd` (raw) | **no** | internal only |
  | `pid` (raw) | **no** | internal only |
  | `dirtyFiles` | **no** (default) | omit from peer projection |

- `GET /synapse/sessions` unchanged (admin/raw snapshot, already in place).

### Acceptance criteria
- `GET /synapse/peers?cwd=X&excludeSessionId=S` returns peers sharing cwd X, never session S.
- Response contains `cwdLabel`/`cwdHash`/`sameCwd`, never raw `cwd` or `pid`.

---

## 10. Privacy (Decision 6)

- Hub binds `127.0.0.1` (loopback), but local processes, browsers, logs, and screenshots can leak a full
  path. So: **store raw `cwd`/`pid` internally** (needed for exact-match filtering), **redact in the peer
  route by default** — label + hash, never raw path, never raw pid.
- Mirrors `AccountBroker.publicSnapshot()` (omits `authFile`/`profile`/`host`/file paths/raw failure timestamps).
- Raw `cwd`/`pid` remain visible only via the existing admin `GET /synapse/sessions` (already
  loopback-only) — no new raw-exposure surface added. (Open Question §13: whether `/synapse/sessions`
  should also redact cwd.)

---

## 11. Tests (hermetic — no real hub)

### Unit (extend `tests/unit/synapse-registry.test.mjs`, `tests/unit/synapse-http.test.mjs`)
- `sanitizeSession` defaults: old row → `cwd:""`, `pid:null`, `sessionKind:"headless"`; persist round-trip
  preserves new fields.
- `register` with interactive payload stores `cwd`/`pid`/`sessionKind`.
- `querySessions` filter + `excludeSessionId` (cwd and worktree).
- TTL branching: interactive not `stale` before 5 min; `idle` transition asserted with injected/advanced
  clock (tests already use `persistPath` + temp dirs).
- `projectPeer()` redaction: `cwd`/`pid` absent, `cwdLabel`/`cwdHash`/`sameCwd` present.
- `synapse-http`: `registerSynapseSession` / `unregisterSynapseSession` post correct bodies with injected
  `fetchImpl` (pattern in `synapse-http.test.mjs:19-49`).

### Integration (new `tests/integration/synapse-peer-discovery.test.mjs`)
- Two sessions register with the same cwd via the registry directly (no socket); `querySessions` +
  `excludeSessionId` returns exactly the *other* session — both directions (A sees B, B sees A).
- Redaction path: drive `projectPeer()` on the query result; assert no raw `cwd`/`pid`.
- **Hermetic**: drive the registry object + pure projection function directly; mock `fetchImpl` for
  hook-side helpers. Do NOT start `hub/server.mjs`. (`synapse-http.test.mjs` proves injected-fetch;
  `synapse-registry.test.mjs` proves temp-persist.)

### (Optional) Deliberate-mode expansion — only if scope escalates
- Observability: hub log lines for peer query; e2e would require a live hub (out of hermetic scope, defer).

---

## 12. ADR

**Decision:** Build interactive peer-discovery by extending the existing Synapse Registry with additive
`cwd`/`pid`/`sessionKind` fields, a 5-minute interactive TTL + `idle` state, auto register/unregister via
existing hooks reusing `synapse-http.mjs`, and a new redacted `GET /synapse/peers` route — keeping the
feature inside the lake (no messaging/locks/UI).

**Drivers:** DRY (Synapse holds ~70%), completeness (cover idle/stale/privacy/tests, not just the happy
path), lake-boil (finish the discovery lake without boiling the ocean), explicit-over-clever
(`excludeSessionId` + named query over implicit inference).

**Alternatives considered:**
- *New parallel registry for interactive sessions* — rejected (DRY violation; duplicates persist +
  heartbeat + routes).
- *Register-only, no TTL/heartbeat* — rejected (zombie peers on crash/kill; Codex-flagged).
- *Raw cwd in peer route* — rejected (path leakage via logs/screenshots; AccountBroker redaction precedent).
- *Reuse `/synapse/sessions` with query params for peers* — rejected for the default discovery surface
  (mixes raw admin snapshot with redacted peer projection); raw route stays admin-only.
- *Persist version bump for schema change* — rejected (additive defaults make migration unnecessary).

**Why chosen:** Lowest blast radius that still closes the discovery loop completely. Reuses proven infra;
redaction and TTL match existing repo precedents.

**Consequences:** Interactive sessions become discoverable by co-located peers. Slight registry surface
growth (one route, one query method, one new `idle` status). New `sessionKind` branch in TTL logic. Mirror
sync required in-PR.

**Follow-ups (Ocean — separate PRDs):** session-to-session messaging, peer-aware lock arbitration,
HUD/TUI peer surface, process attach/kill, cross-host federation, identity/auth policy.

---

## 13. Open Questions (user decision required)

1. **Interactive heartbeat trigger.** Registry-side TTL/idle is in-scope, but the heartbeat *source* is
   undecided: (a) register-only + 5-min TTL, no periodic heartbeat (simplest; quiet-but-alive sessions go
   `idle`→`stale` after 5 min), or (b) wire a UserPromptSubmit hook as implicit heartbeat (adds/uses a hook
   surface). **Recommended default: (a).** — Decides whether a new hook surface enters the lake.
2. **Interactive TTL value.** Codex recommends 5 min. Confirm 5 min vs 10 min vs 2 min. — Too low = idle
   false-stale; too high = zombie peers linger longer.
3. **cwd privacy depth.** Default peer route redacts (label+hash). Should the admin `GET
   /synapse/sessions` *also* redact cwd, or stay raw for local admin/HUD use? — Decides whether any raw path
   is exposed over loopback HTTP at all.
4. **SessionStart placement.** Self-register in BACKGROUND (`runBackground`, strictly best-effort) vs
   DEFERRED (`runDeferred`, logged). **Recommended: BACKGROUND.** — Both non-blocking; taste decision.
5. **Register vs upsert on duplicate.** `register()` currently rejects duplicate `sessionId`. For interactive
   re-runs prefer reject-and-ignore, or an explicit upsert path? **Recommended: reject-and-ignore (benign).**
6. **Single `querySessions()` vs two `getSessionsBy*` methods.** **Recommended: one `querySessions()`
   primitive** (+ optional thin wrappers). — DRY / explicit-over-clever.
