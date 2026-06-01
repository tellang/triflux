# Open Questions

## Hub Interactive Session Peer-Discovery — 2026-06-01
PRD: `.triflux/plans/hub-session-peer-discovery.md`

- [ ] **Interactive heartbeat trigger** — register-only + 5-min TTL (recommended) vs UserPromptSubmit-hook heartbeat — Decides whether a new hook surface enters the lake (scope creep risk).
- [ ] **Interactive TTL value** — Codex recommends 5 min; confirm 5 vs 10 vs 2 min — Too low = idle false-stale, too high = zombie peers linger.
- [ ] **cwd privacy depth** — peer route redacts by default; should admin `GET /synapse/sessions` also redact cwd or stay raw — Decides whether any raw path is exposed over loopback HTTP at all.
- [ ] **SessionStart register placement** — BACKGROUND (recommended) vs DEFERRED — Both non-blocking; taste decision affecting log visibility.
- [ ] **Register vs upsert on duplicate sessionId** — reject-and-ignore (recommended) vs explicit upsert — Affects behavior when interactive hooks re-run for the same session.
- [ ] **API shape** — single `querySessions()` (recommended) vs two `getSessionsByCwd`/`getSessionsByWorktree` methods — DRY / explicit-over-clever.
