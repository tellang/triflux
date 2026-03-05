[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="triflux" src="docs/assets/logo-dark.svg" width="200">
  </picture>
</p>

<p align="center">
  <strong>CLI-first multi-model orchestrator</strong><br>
  <em>Route tasks to Codex, Gemini, and Claude — route tasks to the right model, save Claude tokens</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/v/triflux?style=flat-square&color=FFAF00&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/dm/triflux?style=flat-square&color=F5C242" alt="npm downloads"></a>
  <a href="https://github.com/tellang/triflux/stargazers"><img src="https://img.shields.io/github/stars/tellang/triflux?style=flat-square&color=FFAF00" alt="GitHub stars"></a>
  <a href="https://github.com/tellang/triflux/actions"><img src="https://img.shields.io/github/actions/workflow/status/tellang/triflux/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-374151?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-374151?style=flat-square" alt="Node.js >= 18"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/demo-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/demo-light.gif">
    <img alt="triflux demo" src="docs/assets/demo-dark.gif" width="680">
  </picture>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#skills">Skills</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#setup-guide">Setup Guide</a>
</p>

---

## Why triflux?

- **Cost-intelligent routing** — Automatically routes tasks to Codex and Gemini before spending Claude tokens
- **DAG-based parallel execution** — Decomposes complex tasks into dependency graphs and runs them concurrently
- **Auto-triage** — Codex classifies + Opus decomposes, no manual agent selection needed
- **16 agent types** — From executor to architect, each mapped to the optimal CLI and effort level
- **HUD status bar** — Real-time CLI health, token savings, and rate limit monitoring
- **Zero config** — Install and start using slash commands in Claude Code immediately

<details>
<summary><strong>Install</strong></summary>

### Plugin (recommended)

```bash
/plugin marketplace add https://github.com/tellang/triflux
/plugin install triflux
```

### npm (global)

```bash
npm install -g triflux
```

### npx (one-off)

```bash
npx triflux doctor
```

### Verify

```bash
tfx doctor
```

</details>

## Quick Start

```bash
# Auto mode — AI classifies + decomposes + executes in parallel
/tfx-auto "refactor auth module + improve login UI + add tests"

# Manual mode — specify agent count and type
/tfx-auto 3:codex "review src/api, src/auth, src/payment"

# Command shortcuts — single agent, instant execution
/implement "add JWT auth middleware"
/analyze "security review of payment module"
/research "latest React Server Components patterns"

# Single-CLI modes
/tfx-codex "refactor + review"     # Codex only
/tfx-gemini "implement + document"  # Gemini only
```

## Skills

| Skill | Mode | Description |
|-------|------|-------------|
| `/tfx-auto` | Auto | Triage → decompose → parallel execute via DAG |
| `/tfx-codex` | Codex-only | All CLI tasks routed to Codex |
| `/tfx-gemini` | Gemini-only | All CLI tasks routed to Gemini |
| `/tfx-setup` | Setup | File sync, HUD config, CLI diagnostics |

### Command Shortcuts

Bypass triage — instant single-agent execution:

| Command | Agent | CLI | Use Case |
|---------|-------|-----|----------|
| `/implement` | executor | Codex | Code implementation |
| `/build` | build-fixer | Codex | Build/type error fixes |
| `/research` | document-specialist | Codex | Documentation lookup |
| `/brainstorm` | analyst | Codex | Requirements analysis |
| `/design` | architect | Codex | Architecture design |
| `/troubleshoot` | debugger | Codex | Bug analysis |
| `/cleanup` | executor | Codex | Code cleanup |
| `/analyze` | quality + security | Codex | Parallel review (2 agents) |
| `/spec-panel` | architect + analyst + critic | Codex | Spec review (3 agents) |
| `/explain` | writer | Gemini | Code explanation |
| `/document` | writer | Gemini | Documentation |
| `/test` | test-engineer | Claude | Test strategy |
| `/reflect` | verifier | Claude | Verification |

## Architecture

```
User: "/tfx-auto refactor auth + improve UI + add tests"
         |
         v
   [Phase 1: Parse] ─── Auto mode detected
         |
         v
   [Phase 2a: Classify] ─── Codex
   │  auth refactor → codex
   │  UI improvement → gemini
   │  test addition  → claude
         |
         v
   [Phase 2b: Decompose] ─── Opus (inline, no agent spawn)
   │  t1: executor (implement, src/auth/)     Level 0
   │  t2: designer (docs, src/components/)    Level 0
   │  t3: test-engineer (Claude native)       Level 1 ← depends on t1
         |
         v
   [Phase 3: Execute] ─── DAG parallel
   │  Level 0: t1(Codex) + t2(Gemini)  ← parallel
   │  Level 1: t3(Claude)               ← after t1 completes
         |
         v
   [Phase 4-6: Collect → Retry → Report]
```

### Agent Routing Table

| Agent | CLI | Effort | Timeout | Mode |
|-------|-----|--------|---------|------|
| executor | Codex | high | 360s | fg |
| build-fixer | Codex | fast | 180s | fg |
| debugger | Codex | high | 300s | bg |
| deep-executor | Codex | xhigh | 1200s | bg |
| architect | Codex | xhigh | 1200s | bg |
| planner | Codex | xhigh | 1200s | fg |
| critic | Codex | xhigh | 1200s | bg |
| analyst | Codex | xhigh | 1200s | fg |
| code-reviewer | Codex | thorough | 600s | bg |
| security-reviewer | Codex | thorough | 600s | bg |
| quality-reviewer | Codex | thorough | 600s | bg |
| scientist | Codex | high | 480s | bg |
| document-specialist | Codex | high | 480s | bg |
| designer | Gemini Pro 3.1 | — | 600s | bg |
| writer | Gemini Flash 3 | — | 600s | bg |
| explore | Claude Haiku | — | 300s | fg |
| verifier | Claude Sonnet | — | 300s | fg |
| test-engineer | Claude Sonnet | — | 300s | bg |

### Failure Handling

1. **First failure** → Claude native agent fallback
2. **Second failure** → Report failed subtask, continue with remaining results
3. **Timeout** → Partial results reported

<details>
<summary><strong>Setup Guide</strong></summary>

### Prerequisites

- **Node.js** >= 18
- **Claude Code** (required)
- **Codex CLI** (optional): `npm install -g @openai/codex`
- **Gemini CLI** (optional): `npm install -g @google/gemini-cli`

> Without Codex or Gemini, triflux automatically falls back to Claude native agents.

### Post-install

```bash
# Sync files + configure HUD
tfx setup

# Run diagnostics
tfx doctor
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `tfx setup` | Sync scripts + HUD + skills |
| `tfx doctor` | CLI diagnostics + issue tracker |
| `tfx update` | Update to latest version |
| `tfx list` | List installed skills |
| `tfx version` | Show version info |

Shortcuts: `tfx` = `triflux`, `tfl` = `triflux`

### HUD Status Bar

Real-time monitoring in Claude Code's status line:

- Claude / Codex / Gemini token usage and rate limits
- CLI health indicators (installed, API key status)
- Session cost tracking and savings report

Configured automatically via `tfx setup`.

</details>

<details>
<summary><strong>oh-my-claudecode Integration</strong></summary>

triflux works standalone or as part of [oh-my-claudecode](https://github.com/nicepkg/oh-my-claudecode):

- Skills auto-registered via OMC's plugin system
- `cli-route.sh` integrates with OMC's agent catalog
- HUD extends OMC's status line
- Compatible with OMC autopilot, ralph, team, and ultrawork modes

</details>

<details>
<summary><strong>Changelog</strong></summary>

### 2.0.0

- Rebranded from `cx-skills` to `triflux`
- New CLI commands: `tfx`, `triflux`, `tfl`
- Updated skills: `/tfx-auto`, `/tfx-codex`, `/tfx-gemini`, `/tfx-setup`
- Visual refresh with amber branding
- All internal references updated (`CX_CLI_MODE` → `TFX_CLI_MODE`)

### Previous (cx-skills)

See [cx-skills releases](https://github.com/tellang/cx-skills/releases) for v1.x history.

</details>

---

<p align="center">
  <a href="https://github.com/tellang/triflux">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=tellang/triflux&type=Date&theme=dark">
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=tellang/triflux&type=Date">
      <img alt="Star History" src="https://api.star-history.com/svg?repos=tellang/triflux&type=Date" width="600">
    </picture>
  </a>
</p>

<p align="center">
  <sub>MIT License · Made by <a href="https://github.com/tellang">tellang</a></sub>
</p>
