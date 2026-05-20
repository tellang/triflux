# Legacy skill aliases

This file keeps deprecated names out of the main README while preserving the
migration map for old prompts, old CLAUDE.md snippets, and existing user muscle
memory.

## Rule

Prefer the canonical surface in new docs and prompts:

- Claude Code work: `/tfx-auto ...` with explicit flags.
- Remote work: `/tfx-remote ...`.
- Shell operations: `tfx ...`.

Legacy aliases are transition shims. Do not teach them as the primary API.

## Alias map

| Deprecated alias | Use instead | Notes |
| --- | --- | --- |
| `/tfx-autopilot` | `/tfx-auto ...` | Unified front door. |
| `/tfx-fullcycle` | `/tfx-auto ... --mode deep --parallel 1` | Deep single-lane execution. |
| `/tfx-multi` | `/tfx-auto ... --parallel N --mode deep` or shell `tfx multi ...` | Slash alias is legacy; shell team command remains active. |
| `/tfx-persist` | `/tfx-auto ... --retry ralph` | Persistent retry loop. |
| `/tfx-swarm` | `/tfx-auto ... --parallel swarm --mode consensus --isolation worktree` or shell `tfx swarm ...` | PRD/worktree swarm path. |
| `/tfx-consensus` | `/tfx-auto ... --mode consensus` | Consensus output shape default. |
| `/tfx-debate` | `/tfx-auto ... --mode consensus --shape debate` | Debate renderer. |
| `/tfx-panel` | `/tfx-auto ... --mode consensus --shape panel` | Panel renderer. |
| `/tfx-remote-setup` | `/tfx-remote setup` | Consolidated remote surface. |
| `/tfx-remote-spawn` | `/tfx-remote spawn <host> "task"` | Consolidated remote surface. |
| `/tfx-psmux-rules` | `.claude/rules/tfx-psmux.md` | Rules are policy docs, not a primary skill surface. |

## Removal gate

Before deleting a legacy alias physically, check all of the following:

1. `skills/<alias>/SKILL.md` has an equivalent canonical workflow documented here.
2. README and Korean README use the canonical form only.
3. Keyword tests and manifest generation preserve deprecation metadata until the
   alias is intentionally removed.
4. Release notes call out the deletion window.
5. `npm run gen:skill-docs`, `npm run gen:skill-manifest`, and targeted tests pass.
