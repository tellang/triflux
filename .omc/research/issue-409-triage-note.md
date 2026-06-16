# Issue #409 codex_apps init fail triage

Date: 2026-06-16
Worktree: `/Users/tellang/Projects/tools/triflux/.worktrees/issue-doctor-378-409`

## Bounded current smoke

Command run:

```sh
codex exec 'Respond exactly: smoke_ok_409'
```

Local Codex version evidence from the smoke artifact:

```text
codex-cli 0.139.0
```

Result:

- Exit code: `0`
- Stdout: `smoke_ok_409`
- `codex_apps` initialization failure reproduced: `false`

Raw bounded-smoke artifact: `.omc/research/issue-409-codex-apps-smoke.json`

## Triage conclusion

Current local evidence does not reproduce the `codex_apps` init failure. Treat #409 as an obsolete candidate unless a newer reproduction provides current stderr/log output. No doctor/docs guidance was added because hardcoding stale Codex 0.137-era behavior is not supported by this Codex 0.139.0 smoke.
