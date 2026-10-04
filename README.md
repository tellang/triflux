[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="triflux" src="docs/assets/logo-dark.svg" width="200">
  </picture>
</p>

<h3 align="center">CLI-first multi-model orchestration for Claude Code, Codex, and Antigravity</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/v/triflux?style=flat-square&color=FFAF00&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/dm/triflux?style=flat-square&color=F5C242" alt="npm downloads"></a>
  <a href="https://github.com/tellang/triflux/stargazers"><img src="https://img.shields.io/github/stars/tellang/triflux?style=flat-square&color=FFAF00" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-374151?style=flat-square" alt="Node >= 20">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-374151?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  <img alt="triflux demo" src="docs/assets/demo-multi.gif" width="680">
</p>

triflux is a Claude Code plugin and npm CLI that routes coding work across Claude, Codex,
and Antigravity. You describe the task once with `/tfx-auto`; triflux picks the CLI lane
(Codex by default), runs it through managed routes instead of ad-hoc shell commands, and
can fan the work out to parallel workers, worktree-isolated swarms, live Claude↔Codex
sessions, or remote hosts. The `tfx` shell CLI covers setup, diagnostics, the local Hub,
and team orchestration.

## Install

```bash
npm install -g triflux   # postinstall runs the setup script
tfx doctor               # check CLIs, tmux, Hub, MCP, profiles, skills
```

Or install the Claude Code plugin from this repository's marketplace:

```bash
claude plugin marketplace add tellang/triflux
claude plugin install triflux@triflux
```

`tfx doctor --fix` repairs common drift; `tfx doctor --json` is for automation.

## First steps

```text
/tfx-auto "fix the failing auth tests"
/tfx-auto "review this change for trust-boundary issues" --mode consensus
/tfx-auto "finish the migration and verify it" --mode deep --retry ralph --max-iterations 10
```

Run `tfx auto "<task>" --json` in a shell to preview the routing decision without executing it.

## Skills

Skills you invoke directly:

| Skill | Use |
| --- | --- |
| `/tfx-auto` | Front door for implementing, fixing, reviewing, and parallel work. Behavior is set by flags (below). |
| `/tfx-live` | Live Claude↔Codex sessions: `start`/`ask`/`stop`, `peer` relay, `orchestrate`, `list-sessions`. |
| `/tfx-remote` | Remote Claude Code sessions over SSH: `setup`, `spawn`, `list`, `attach`, `send`, `resume`, `probe`, `kill`. |
| `/tfx-setup` | Interactive setup: file sync, HUD, Codex profiles, MCP, hook priority. |
| `/tfx-doctor` | Diagnose and repair; also starts, stops, and checks the Hub. |
| `/tfx-profile` | Manage Codex profiles. |
| `/tfx-ship` | triflux release flow (maintainers). |
| `/tfx-wt` | Windows Terminal tabs and panes. `tfx setup` installs it on Windows only. |

Internal lanes (marked `internal: true`; other skills and the router call them, but you can name them explicitly):

| Skill | Use |
| --- | --- |
| `tfx-harness` | Meta routing: returns which skill or path fits a request, without running it. |
| `tfx-plan` | Multi-model implementation plan (`--quick` for a lighter pass). |
| `tfx-review` | Code review verdict (`--quick` for a lighter pass). |
| `tfx-research` | Web research with cross-checked sources (`--quick`, `--auto`, `--depth`). |
| `tfx-interview` | Requirements interview; `--format goal` turns an idea into a Claude Code `/goal` block. |

The package also bundles two general helpers, `merge-worktree` and `star-prompt`.
A keyword hook may suggest a skill from your prompt; invoke `/tfx-*` explicitly when you want a predictable route.

## `/tfx-auto` flags

| Flag | Values | Effect |
| --- | --- | --- |
| `--mode` | `quick` (default), `deep`, `consensus`, `live` | `deep` = plan → execute → verify loop; `consensus` = multi-CLI agreement; `live` = hand off to `tfx-live peer` |
| `--shape` | `consensus`, `debate`, `panel` | Output shape for `--mode consensus` |
| `--cli` | `auto`, `codex`, `antigravity`, `claude` | Force a CLI lane |
| `--cli-set` | `triad`, `no-antigravity`, `custom` | Consensus participants |
| `--parallel` | `1`, `N`, `swarm` | `N` = local workers (`tfx multi`); `swarm` = PRD shards in worktrees (`tfx swarm`) |
| `--isolation` | `none`, `worktree` | Worktree isolation per shard (forced on with `swarm`) |
| `--remote` | `<host>` | Send swarm shards to a host from `hosts.json` |
| `--retry` | `0`, `1` (default), `ralph`, `auto-escalate` | `ralph` = retry state machine with stuck detection; `auto-escalate` = move up the model chain |
| `--max-iterations` | `N` | Cap for `ralph` / `auto-escalate` (`0` = unlimited) |
| `--rounds` | `N` (default 4) | Round trips for `--mode live` |
| `--risk-tier` | `auto`, `low`, `medium`, `high` | Pick verification strength from the change; ignored when `--mode` is set |
| `--skill` | `<name>` | Prepend `skills/<name>/SKILL.md` to the Codex/Antigravity prompt |
| `--no-native-bridge-ui` | | Hide headless workers from the `claude agents` panel |

The full contract, including `--lead`, `--options`, `--experts`, and conflict rules, lives in
[`skills/tfx-auto/SKILL.md`](skills/tfx-auto/SKILL.md).

## Models and profiles

Codex runs through named profiles; model IDs live in `~/.codex/<profile>.config.toml`, and the
role → profile map lives in [`scripts/lib/agent-route-policy.mjs`](scripts/lib/agent-route-policy.mjs).
Claude is called by alias, so the newest model in each tier is picked up automatically.

| Profile / alias | Lanes |
| --- | --- |
| `gpt6_astra_xhigh` | Architecture, planning, critique, debugging, security review, deep execution |
| `gpt6_astra_max`, `gpt6_astra_ultra` | Hardest single tasks (`TFX_CODEX_PROFILE=max\|ultra`); `max` is the first `auto-escalate` step |
| `gpt61_sol_high` / `gpt61_sol_med` | Default implementation, review, verification, tests, docs / cleanup |
| `gpt6_luna_high` / `gpt6_luna_low` | Build fixes, writing / latency-first lookups |
| Claude `fable` | Final `--retry auto-escalate` step |
| Claude `opus` / `sonnet` / `haiku` | Meta routing and planning gates / Claude-native QA and verification / fast exploration |

Routing policy: [`.claude/rules/tfx-routing.md`](.claude/rules/tfx-routing.md) ·
escalation chain: [`.claude/rules/tfx-escalation-chain.md`](.claude/rules/tfx-escalation-chain.md).

## Shell CLI

| Command | Use |
| --- | --- |
| `tfx setup` / `tfx doctor` | Sync files, hooks, HUD, MCP, profiles / diagnose and repair (`--fix`, `--json`) |
| `tfx auto` | Preview the `tfx-auto` routing decision |
| `tfx multi` | Local multi-CLI team in tmux + Hub |
| `tfx swarm` | PRD-based, worktree-isolated work: `plan`, `preflight`, `run`, `list` |
| `tfx synapse` | Swarm session registry and leases |
| `tfx hub` | Local Hub: `start`, `stop`, `status`, `ensure` |
| `tfx mcp` | Managed MCP registry: `list`, `sync`, `add`, `remove` |
| `tfx hooks` | Hook orchestrator: scan, diff, apply, status |
| `tfx handoff` | Serialize the current context for another session or host |
| `tfx cto` | Repo-local authority console: `collect`, `status`, `dashboard`, `hygiene`, `steward`, `event` |
| `tfx review` / `tfx codex-team` | Codex git-diff review / Codex-led team mode |
| `tfx stealth-fetch <url>` | Fetch one URL through cloakbrowser (JSON on stdout) |
| `tfx notion-read`, `tfx why`, `tfx schema`, `tfx list`, `tfx monitor`, `tfx tray`, `tfx update`, `tfx version` | Notion → Markdown, commit intent trailers, CLI schemas, installed skills, TUI monitor, tray, update, version |
| `tfx-live` | Live session bridge (same as the `/tfx-live` skill) |
| `tfx-profile` | Interactive Codex profile manager |

`tfx <command> --help` and `tfx schema <command>` print the exact arguments.

## Runtime features

**Live sessions.** `tfx-live` drives Claude Code and Codex TUI sessions. Claude daemon targets
(`--short`/`--session-id`) try UDS first and fall back to tmux when `--session` is also given;
Codex uses tmux, or UDS with
`--transport uds --thread <id|auto>`. `peer` relays between two sessions for `--rounds`, and
`orchestrate` runs Claude + Codex on one task. triflux's Codex hook records running Codex
sessions under `~/.local/state/triflux/codex-sessions/`, so `tfx-live list-sessions --cli codex|claude`
also finds sessions you started yourself in tmux.

**Long jobs.** `scripts/tfx-route.sh --async <agent> "<prompt>"` returns a job id at once, which
gets past Claude Code's 600-second Bash limit. Follow up with `--job-status`, `--job-wait`, and
`--job-result`.

**Hub.** A local message bus for teams, remote sessions, MCP tools, and status surfaces. It binds
to `127.0.0.1:27888` by default (`TFX_HUB_PORT` overrides) and accepts a bearer token from
`TFX_HUB_TOKEN`. Headless workers from `tfx-auto`, `tfx multi`, and local swarm shards appear in
the `claude agents` panel unless you pass `--no-native-bridge-ui`.

**Retry and escalation.** `--retry ralph` loops until done or stuck (three identical failures).
`--retry auto-escalate` steps from Codex `gpt6_astra_max` to Claude `fable`; override the chain in
`.triflux/config/escalation-chain.json`.

**Machine profile.** Setup records which CLIs this machine may use and its timeout policy in
`~/.config/triflux/machine-profile.env`. `TFX_DISABLE_CODEX=1` or `TFX_DISABLE_ANTIGRAVITY=1`
removes a CLI from routing; if no allowed CLI is available the route fails instead of silently
falling back. Details: [`.claude/rules/tfx-machine-profile.md`](.claude/rules/tfx-machine-profile.md).

**CTO lake.** `tfx cto` keeps an append-only history of the repo in `.triflux/lake/`. Automatic
behavior is off by default; opt in with `TFX_CTO_AUTO_COLLECT=1`, `TFX_CTO_NORTH_STAR=1`, or
`TFX_HUB_AUTO_TRAY=1` ([ADR-0018](docs/adr/0018-cto-auto-behaviors-opt-in.md)).

**Remote hosts.** `/tfx-remote` and `--remote <host>` read hosts from `~/.config/triflux/hosts.json`
(Windows: `%APPDATA%\triflux\hosts.json`). Run `/tfx-remote setup` to add one, then
`/tfx-remote spawn <host> "run a security review"`.

## Architecture

```mermaid
graph TD
    User([Claude Code prompt / shell]) --> Skills["/tfx-auto · /tfx-live · /tfx-remote"]
    User --> CLI[tfx CLI]
    Skills --> Route[tfx-route.sh]
    Skills --> Live[tfx-live]
    CLI --> Team["tfx multi · tfx swarm"]
    Route --> Codex[Codex CLI]
    Route --> Agy[Antigravity agy]
    Route --> Claude[Claude Code]
    Team --> Route
    Team --> WT[(git worktrees)]
    Live -->|UDS or tmux| Sessions[Claude / Codex TUI sessions]
    Route --> Hub["Hub 127.0.0.1:27888"]
    Team --> Hub
    Hub --> Store[(SQLite or memory store)]
    Hub --> MCP[MCP tools]
    Hub --> UI["HUD · claude agents panel"]
    CLI --> Lake[(".triflux/lake (tfx cto)")]
```

Package layout and execution paths: [ARCHITECTURE.md](ARCHITECTURE.md). Documentation map:
[docs/README.md](docs/README.md).

## Platforms

| Platform | Multiplexer | Notes |
| --- | --- | --- |
| macOS | tmux | Default path. Install `coreutils` (`gtimeout`) if you keep a positive hard ceiling. `tfx tray` starts a Swift menu-bar helper. |
| Linux | tmux | Supported. `tfx tray` is not available. |
| Windows | psmux + Windows Terminal | See below. |

**Windows.** psmux (a tmux fork) runs PowerShell by default. safety-guard blocks direct `wt.exe`
and raw `psmux kill-session`, so tabs and panes go through the `tfx-wt` skill (set up only on
Windows) and `hub/team/wt-manager.mjs`. `tfx tray` runs the system tray (`--attach` for a
foreground debug run). Agent rules: [`.claude/rules/tfx-psmux.md`](.claude/rules/tfx-psmux.md).

## Security and guards

| Layer | Protection |
| --- | --- |
| Managed routes | Codex and Antigravity are called through `tfx-route.sh`, Hub workers, or `tfx`, never through a bare `codex exec` or `agy`. This is a rule for callers; no hook enforces it. |
| safety-guard hook | Blocks destructive shell commands (root `rm -rf`, force push to main, `git clean -fd`, SQL `DROP`), direct `wt.exe`, raw psmux kill, and bash syntax sent over SSH to Windows hosts, and points to the managed alternative. |
| Hub | Binds to localhost; optional bearer token (`TFX_HUB_TOKEN`). |
| MCP registry | Replaces stale or unsupported MCP entries with managed ones. |
| Consensus | Deep and consensus runs report degraded or disputed results instead of hiding them. |

## Contributing

Node 20 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, lint, package boundaries,
mirror and release checks, and state snapshots. Releases are automated: merging a version-bump
commit to `main` runs `release.yml` after CI passes; it tags, creates the GitHub release, and publishes to npm
through OIDC Trusted Publishing. Decisions are recorded in [docs/adr/](docs/adr/README.md).

<p align="center">
  <sub>MIT License &middot; Made by <a href="https://github.com/tellang">tellang</a></sub>
</p>
