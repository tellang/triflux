# Triflux open issue triage — 2026-06-16

Source of truth: live `gh issue list --state open --limit 200` against `tellang/triflux` on 2026-06-16, repo head `75e3dbe4` (`v10.36.0`).

## Triage rubric

- **Stale-close**: live reproduction is gone or the issue is now only historical documentation.
- **P2**: user-visible correctness, silent unsafe behavior, or workflow failure that should be fixed before broad release work.
- **P3**: real but bounded ergonomics/doctor correctness issue.
- **P4**: low-risk cleanup/docs/contract clarification.

## Open issue inventory

| Issue | Priority | Stale? | Current decision | Notes / planned closure evidence |
| --- | --- | --- | --- | --- |
| #411 consensus follow-ups | P2 | No | Fix the high-signal bounded items now; leave risky keychain freshness as follow-up if needed. | Silent daemon auth default, q-learning deflake, and small P4 hygiene are code-testable. Keychain freshness needs non-interactive design and may remain open/partial. |
| #409 codex_apps init fail docs | P4 | **Stale-close candidate** | Close as obsolete unless another host reproduces. | Local smoke on 2026-06-16: `codex-cli 0.139.0`; `codex exec 'Return exactly TFX_CODEX_APPS_SMOKE_OK.'` exited 0, no `codex_apps`/init-fail stderr. |
| #408 critical redundant policy | P2 | No | Fix now. | Split `critical` from `redundancy`; require explicit redundancy to launch extra worker, with same-CLI option. |
| #407 shard MCP manifest abstraction | P2 | No | Fix now. | Undefined MCP server names should be skipped with warning/metadata instead of causing Codex unknown-server failure. |
| #378 agy migrated MCP config doctor false positive | P3 | No | Fix now. | Empty legacy `~/.gemini/config/mcp_config.json` plus `.migrated` should not be a hard parse error or be repopulated by `--fix`. |
| #367 tfx-live missing daemon UDS diagnostics | P2 | No | Fix now. | Distinguish missing daemon dir/unsupported daemon from stale socket and guide tmux fallback. |
| #310 agy alias duplication | P4 | No, but low-risk | Resolve by documenting the intentional direct-call alias contract unless code proves safe to remove. | `agent-map.json` normalizes upstream callers; `tfx-route.sh`/`cli-agy` still need direct `agy` entrypoint compatibility. |
| #292 HUD sv semantic mismatch | P2 | No | Fix now. | Avoid presenting combined `sv:` from incomparable Codex cumulative vs Gemini latest-session fallbacks. |

## Worktree lanes

- `fix/issues-407-408-swarm` → #407/#408.
- `fix/issues-378-409-doctor` → #378/#409.
- `fix/issue-292-hud-sv` → #292.
- `fix/issues-367-411-followups` → #367/#411 bounded follow-ups.
- `fix/issues-20260616` → integration branch and this triage artifact.

## Closure plan

1. Land code fixes from the independent lanes into `fix/issues-20260616`.
2. Run focused tests per lane, then `npm run release:check-mirror` and at least targeted aggregate tests.
3. Open a PR summarizing fixed issues, stale-close recommendation for #409, and any deliberately deferred #411 keychain freshness work.
