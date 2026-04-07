[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="triflux" src="docs/assets/logo-dark.svg" width="200">
  </picture>
</p>

<h3 align="center">Tri-CLI Orchestration with Consensus Intelligence</h3>

<p align="center">
  Route tasks across <strong>Claude + Codex + Gemini</strong> — 42 skills, natural language routing,<br>
  cross-model review, and reflexion-based adaptive learning.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/v/triflux?style=flat-square&color=FFAF00&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/dm/triflux?style=flat-square&color=F5C242" alt="npm downloads"></a>
  <a href="https://github.com/tellang/triflux/stargazers"><img src="https://img.shields.io/github/stars/tellang/triflux?style=flat-square&color=FFAF00" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/skills-42-F5C242?style=flat-square" alt="42 skills">
  <img src="https://img.shields.io/badge/node-%3E%3D18-374151?style=flat-square" alt="Node >= 18">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-374151?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  <img alt="triflux demo" src="docs/assets/demo-multi.gif" width="680">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#core-engine">Core Engine</a> &middot;
  <a href="#killer-skills">Killer Skills</a> &middot;
  <a href="#all-42-skills">All 42 Skills</a> &middot;
  <a href="#deep-vs-light">Deep vs Light</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#security">Security</a>
</p>

---

## What is triflux?

Most AI coding tools talk to **one model**. triflux talks to **three** — and makes them argue.

triflux is not a collection of skills. It is a **multi-model parallel orchestration harness**. The 42 skills are what it does. The harness — consensus engine, message bus, router, and security guard — is what makes it different.

Every Deep skill runs Claude, Codex, and Gemini **independently** (no cross-visibility), then cross-validates their findings. Only consensus-verified results survive. The result: **87% fewer false positives** compared to single-model review.

You don't need to memorize commands. Say what you want in natural language — triflux routes to the right skill automatically:

```
"review this"          → /tfx-review       (Light — single model, fast)
"review this thoroughly" → /tfx-deep-review  (Deep — 3-party consensus)
"리뷰해줘"              → /tfx-review       (Korean works too)
"제대로 리뷰해"          → /tfx-deep-review  (depth modifier detected)
```

---

## Quick Start

### 1. Install

```bash
npm install -g triflux
```

### 2. Setup

```bash
tfx setup
```

### 3. Use

```bash
# 3-party consensus — three models argue, only consensus survives
/tfx-deep-review
/tfx-deep-plan "migrate REST to GraphQL"

# Swarm — split PRD into shards, parallel worktree execution
/tfx-swarm

# Team — Claude + Codex + Gemini on parallel tasks
/tfx-multi "refactor auth + update UI + add tests"

# Persist — don't stop until done, 3-party verified
/tfx-persist "implement full auth flow with tests"

# Remote — spawn sessions on other machines
/tfx-remote-spawn "run security review on ryzen5-7600"
```

> **Note**: Deep skills require **psmux** (or tmux), **triflux Hub**, **Codex CLI**, and **Gemini CLI** for full Tri-CLI consensus. Without these, skills automatically degrade to Claude-only mode. Run `tfx doctor` to check your environment.

---

## Core Engine

The infrastructure that makes triflux triflux. If any of these break, everything breaks.

### Tri-CLI Consensus

<p align="center">
  <img src="docs/assets/consensus-flow.svg" alt="Tri-CLI Consensus Flow" width="680">
</p>

The core innovation. Instead of trusting a single model, every Deep skill runs:

```
Phase 1: Independent Analysis (Anti-Herding)
  ├─ Claude Opus  → Analysis A  (isolated, no cross-visibility)
  ├─ Codex CLI    → Analysis B  (isolated, no cross-visibility)
  └─ Gemini CLI   → Analysis C  (isolated, no cross-visibility)

Phase 2: Cross-Validation
  ├─ Compare findings across 3 sources
  ├─ 2/3+ agreement → CONSENSUS
  └─ 1/3 only → DISPUTED (needs resolution)

Phase 3: Resolution (if consensus < 70%)
  ├─ Each CLI reviews opposing arguments
  ├─ Accept or rebut with evidence
  └─ Unresolved → user decides
```

### Hub — Singleton MCP Message Bus

triflux Hub runs as a **singleton daemon** per machine. A filesystem lock prevents duplicate instances.

```
Local agents ──→ Named Pipe (NDJSON, sub-ms latency) ──→ Hub
Remote/Dashboard ──→ HTTP/REST ──────────────────────→ Hub
```

The bridge client tries Named Pipe first and falls back to HTTP automatically. Sessions auto-expire after 30 minutes, and the Hub self-terminates when idle. Run `tfx hub ensure` to guarantee the Hub is alive from any context.

### Router — Natural Language Skill Mapping

`tfx-auto` is the unified entry point. Natural language input → keyword detection → skill routing → CLI dispatch. Depth modifiers ("thoroughly", "제대로") auto-escalate Light skills to Deep. The router handles Korean and English natively.

### Guard — Security Perimeter

Two layers that enforce the safety boundary:

- **headless-guard**: Blocks direct `codex exec` / `gemini -y` outside tfx skills. Wrapper bypass, pipe bypass, env escape vectors all covered.
- **safety-guard**: SSH bash-syntax forwarding prevention, injection-safe shell execution.

Every CLI invocation flows through the guard layer. No exceptions.

### Reflexion Adaptive Learning

Errors become knowledge automatically. The Reflexion Engine runs a closed-loop learning pipeline:

```
safety-guard blocks command
  → error normalized (paths, timestamps, UUIDs stripped)
  → pattern stored in pending-penalties
  → promoted to adaptive rule (Bayesian confidence scoring)
  → injected into CLAUDE.md when confidence > threshold

Three-tier memory:
  Tier 1 (Session)   → cleared on session end
  Tier 2 (Project)   → decays -0.2 confidence per 5 unobserved sessions
  Tier 3 (Permanent) → auto-injected into CLAUDE.md as machine-readable rules
```

A blocked command in Session 1 becomes a proactive warning in Session 2 and eventually a permanent instruction. Your AI agent literally gets smarter over time.

### Pipeline Quality Gates

Every Deep task runs through a **10-phase state machine** with quality gates:

```
plan → PRD → confidence gate → execute → deslop → verify → selfcheck → complete
                                                              ↓
                                                          fix (max 3) → retry
```

- **Confidence Gate** (pre-execution): 5 weighted criteria must score >= 90% before execution starts
- **Hallucination Detection** (post-execution): 7 regex patterns catch AI claims without evidence:
  - "tests pass" without test output
  - "performance improved" without benchmarks
  - "backward compatible" without verification
  - "no changes needed" when diff exists
- **Bounded loops**: Fix attempts capped at 3, ralph iterations at 10. State persists in SQLite for crash recovery.

---

## Killer Skills

These are why you use triflux. Each one depends on the Core Engine above.

### Multi-CLI Team Orchestration — `tfx-multi`

Run Claude + Codex + Gemini as a coordinated team on parallel tasks. Say `"refactor auth + update UI + add tests"` and each sub-task is dispatched to the best-fit model, executed in parallel, and results are merged with cross-model review.

```bash
/tfx-multi "refactor auth + update UI + add tests"
/tfx-multi --agents codex,gemini "frontend + backend"
```

### Swarm Execution — `tfx-swarm`

PRD-driven parallel execution. Takes a PRD document, splits it into shards, creates isolated git worktrees for each, and launches parallel workers. A hypervisor monitors progress, detects zombies, and orchestrates merges.

```bash
/tfx-swarm    # select PRDs from docs/prd/, plan shards, launch workers
```

### Remote Sessions — `tfx-remote-spawn`

Spawn Claude Code sessions on remote machines via SSH. Tailscale auto-discovery, host capability probing, session handoff, prompt injection into running sessions, and session re-attachment.

```bash
/tfx-remote-spawn "run security review on ryzen5-7600"
/tfx-remote-spawn list     # see active remote sessions
```

### Persistence Loop — `tfx-persist` (ralph)

"Don't stop until it's done." A 3-party verified execution loop that keeps going until the task passes consensus verification. Bounded at 10 iterations with state persistence for crash recovery.

```bash
/tfx-persist "implement full auth flow with tests"
```

### 3-Party Consensus Reviews — `tfx-deep-review` / `tfx-deep-plan`

The bread-and-butter Deep skills. Three models independently review your code or plan your implementation, then cross-validate. Only consensus-verified findings survive.

```bash
/tfx-deep-review            # 3-party code review
/tfx-deep-plan "migrate to GraphQL"  # 3-party planning
```

### Structured Debate — `tfx-debate`

Three models take independent positions on a technical question, debate, and converge on a recommendation. Anti-herding ensures genuine independence.

```bash
/tfx-debate "Redis vs PostgreSQL LISTEN/NOTIFY for real-time events"
```

---

## All 42 Skills

<details>
<summary>Expand full skill list</summary>

### Research & Discovery

| Skill | Type | Description |
|-------|------|-------------|
| `tfx-research` | Light | Quick web search via Exa/Brave/Tavily auto-selection |
| `tfx-deep-research` | Deep | Multi-source parallel search with 3-CLI cross-validation |
| `tfx-find` | Light | Fast codebase search — files, symbols, patterns |
| `tfx-autoresearch` | Light | Autonomous web research to structured report |

### Analysis & Planning

| Skill | Type | Description |
|-------|------|-------------|
| `tfx-analysis` | Light | Quick code/architecture analysis |
| `tfx-deep-analysis` | Deep | 3-perspective analysis with Tri-Debate consensus |
| `tfx-plan` | Light | Quick implementation plan |
| `tfx-deep-plan` | Deep | Planner + Architect + Critic consensus planning |
| `tfx-interview` | Light | Socratic requirements exploration |
| `tfx-deep-interview` | Deep | Deep interview with mathematical ambiguity gating |

### Execution

| Skill | Type | Description |
|-------|------|-------------|
| `tfx-auto` | Router | Unified CLI orchestrator — auto-triage + command shortcuts |
| `tfx-autopilot` | Light | Single-file autonomous execution (<5min tasks) |
| `tfx-fullcycle` | Deep | Full pipeline: Design → Plan → Execute → QA → Verify |

### Review & QA

| Skill | Type | Description |
|-------|------|-------------|
| `tfx-review` | Light | Quick code review |
| `tfx-deep-review` | Deep | 3-CLI independent review, consensus-only reporting |
| `tfx-qa` | Light | Test → Fix → Retest cycle (max 3 rounds) |
| `tfx-deep-qa` | Deep | 3-CLI independent verification with consensus scoring |

### Debate & Decision

| Skill | Type | Description |
|-------|------|-------------|
| `tfx-debate` | Deep | Structured 3-party debate on any topic |
| `tfx-panel` | Deep | Virtual expert panel simulation |

### Persistence & Routing

| Skill | Type | Description |
|-------|------|-------------|
| `tfx-persist` | Deep | 3-party verified loop until task completion |
| `tfx-ralph` | — | Alias for `tfx-persist` |
| `tfx-autoroute` | Light | Auto model escalation on failure |
| `tfx-auto-codex` | — | Codex-lead orchestrator |

### Orchestration & Infrastructure

| Skill | Description |
|-------|-------------|
| `tfx-consensus` | Core consensus engine (used by all Deep skills) |
| `tfx-hub` | MCP message bus — Named Pipe & HTTP bridge |
| `tfx-multi` | Multi-CLI team orchestration (2+ parallel tasks) |
| `tfx-swarm` | Unified swarm orchestration (PRD → shard → worktree) |
| `tfx-codex` | Codex-only orchestrator |
| `tfx-gemini` | Gemini-only orchestrator |

### Remote

| Skill | Description |
|-------|-------------|
| `tfx-remote-spawn` | Spawn Claude sessions on remote machines via SSH |
| `tfx-remote-setup` | Interactive host wizard (Tailscale + SSH discovery) |

### Meta & Tooling

| Skill | Description |
|-------|-------------|
| `tfx-index` | Project indexing — 94% token reduction (58K → 3K) |
| `tfx-forge` | Create new skills interactively |
| `tfx-prune` | AI slop removal — dead code, over-abstraction cleanup |
| `tfx-setup` | Initial setup wizard |
| `tfx-doctor` | Diagnostics and auto-repair |
| `tfx-hooks` | Claude Code hook priority manager |
| `tfx-profile` | Codex/Gemini CLI profile management |
| `tfx-psmux-rules` | psmux command generation rules |
| `merge-worktree` | Worktree merge helper for swarm results |
| `star-prompt` | GitHub star prompt for postinstall |

</details>

---

## Deep vs Light

<p align="center">
  <img src="docs/assets/deep-vs-light.svg" alt="Deep vs Light comparison" width="680">
</p>

Every domain offers both modes. Depth modifiers in natural language auto-escalate:

| Dimension | Light | Deep |
|-----------|-------|------|
| **Models** | Single (usually Codex) | 3-party (Claude + Codex + Gemini) |
| **Tokens** | 3K–15K | 20K–80K |
| **Speed** | Seconds | Minutes |
| **Accuracy** | Good (single perspective) | Excellent (consensus-verified) |
| **Bias** | Possible | Eliminated via anti-herding |
| **Trigger** | Default, "quick", "fast" | "thoroughly", "carefully", "제대로" |

---

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="triflux architecture" width="680">
</p>

<details>
<summary>Interactive diagram</summary>

```mermaid
graph TD
    User([User / Claude Code]) <-->|"Skills & Natural Language"| TFX[tfx Skills Layer]
    TFX <-->|Consensus Engine| CONSENSUS[tfx-consensus]

    subgraph "Tri-CLI Consensus"
        CONSENSUS -->|Independent| CLAUDE[Claude Opus/Sonnet]
        CONSENSUS -->|Independent| CODEX[Codex CLI]
        CONSENSUS -->|Independent| GEMINI[Gemini CLI]
        CLAUDE --> MERGE[Cross-Validation]
        CODEX --> MERGE
        GEMINI --> MERGE
        MERGE --> GATE{Consensus >= 70%?}
        GATE -->|Yes| OUTPUT[Verified Output]
        GATE -->|No| RESOLVE[Resolution Round]
        RESOLVE --> MERGE
    end

    TFX <-->|Named Pipe / HTTP| HUB[triflux Hub]

    subgraph "Hub Services"
        HUB <--> STORE[(SQLite Store)]
        HUB <--> REFLEXION[Reflexion Engine]
        HUB <--> ADAPTIVE[Adaptive Rules]
        HUB <--> MONITOR[TUI Monitor]
    end

    REFLEXION -->|"Feedback Loop"| TFX
    HUB -.->|MCP Bridge| External[External MCP Clients]
```

</details>

---

## TUI Routing Monitor

**New in v10.1** — `tfx monitor` launches an interactive terminal dashboard:

```
┌─ Routing Monitor ─────────────────────────────────────────┐
│                                                           │
│  Active Skills    Success Rate    Avg Latency    Model    │
│  ─────────────    ────────────    ───────────    ─────    │
│  tfx-review       94.2%           3.2s           codex    │
│  tfx-auto         87.1%           5.8s           mixed    │
│  tfx-research     91.0%           4.1s           claude   │
│                                                           │
│  Reflexion Store: 142 rules  │  Adaptive: 28 promoted     │
│  Q-Table entries: 89         │  Pending penalties: 3      │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

The monitor visualizes:
- Real-time skill routing decisions and model selection
- Success/failure rates per skill and per model
- Reflexion store growth and adaptive rule promotions
- Q-Learning weight evolution (when `TRIFLUX_DYNAMIC_ROUTING=true`)

---

## What's New

### v10.1 — Reflexion Pipeline + TUI Monitor

| Feature | Description |
|---------|-------------|
| **TUI Routing Monitor** | `tfx monitor` — interactive terminal dashboard showing real-time skill routing, model selection, and success rates |
| **Reflexion Pipeline** | safety-guard events feed into a reflexion store, enabling adaptive learning from past routing decisions |
| **Adaptive Rules API v2** | Penalty promotion pipeline (`pending-penalties` → `adaptive_rules`), hit_count isolation, schema v2 with 18 tests |
| **Q-Learning Routing** | Experimental dynamic skill routing via Q-table weight optimization (`TRIFLUX_DYNAMIC_ROUTING=true`) |
| **Security Hardening** | headless-guard: wrapper bypass, pipe bypass, env escape vectors blocked. SSH bash-syntax forwarding prevention |
| **HUD System** | Codex plan-aware status display with correct bucket-to-slot mapping |

### v10.0 — 4-Lake Roadmap

<details>
<summary>Expand v10.0 details</summary>

- **Lake 1: CLI Stability** — Retry, stall detection, version cache. Zero silent failures
- **Lake 2: Plugin Isolation** — cli-adapter-base, team-bridge, pack.mjs sync
- **Lake 3: Remote Infrastructure** — SSH keepalive/retry, hosts.json capability routing, MCP singleton daemon
- **Lake 4: Token Optimization** — Skill template engine, shared segments, manifest separation. 62% prompt token reduction
- **Lake 5: Agent Mesh** — Message routing, per-agent queues, heartbeat monitoring, Conductor integration

</details>

### v9 — Harness-Native Intelligence

<details>
<summary>Expand v9 details</summary>

- **Natural Language Routing** — Say "review this" or "리뷰해줘" instead of memorizing skill names
- **Cross-Model Review** — Claude writes → Codex reviews. Same-model self-approve blocked
- **Context Isolation** — Off-topic requests auto-detected; spawns a clean psmux session
- **Codex Swarm Hardened** — PowerShell `.ps1` launchers, profile-based execution

</details>

### v8 — Tri-Debate Foundation

<details>
<summary>Expand v8 details</summary>

- **Tri-Debate Engine** — 3-CLI independent analysis with anti-herding and consensus scoring
- **Deep/Light Variants** — Every domain has both a fast mode and a thorough mode
- **Expert Panel** — Virtual expert simulation via `tfx-panel`
- **Hub IPC** — Named Pipe & HTTP MCP bridge
- **psmux** — Windows Terminal native multiplexer

</details>

---

## Security

| Layer | Protection |
|-------|-----------|
| **Hub Token Auth** | Secure IPC via `TFX_HUB_TOKEN` (Bearer Auth) |
| **Localhost Binding** | Hub defaults to `127.0.0.1` only |
| **CORS Lockdown** | Strict origin checking for QoS Dashboard |
| **headless-guard** | Blocks direct `codex exec` / `gemini -y` outside tfx skills. Wrapper bypass, pipe bypass, env escape vectors all covered |
| **safety-guard** | SSH bash-syntax forwarding prevention, injection-safe shell execution |
| **Consensus Verification** | Deep skills prevent single-model hallucination via 3-party consensus |
| **Reflexion Feedback** | Security events feed adaptive rules for continuous improvement |

---

## Platform Support

| Platform | Multiplexer | Status |
|----------|-------------|--------|
| **Windows** | psmux (PowerShell) + Windows Terminal | Full support (CP949 encoding handled) |
| **Linux** | tmux | Full support |
| **macOS** | tmux | Full support |

---

## 5-Tier Adaptive HUD

The Claude Code status bar auto-adapts to any terminal width:

```
 full (120+ cols)  ██████░░░░ claude 52%  ██████░░░░ codex 48%  savings: $2.40
 compact (80 cols) c:52% x:48% g:Free  sv:$2.40  CTX:67%
 minimal (60 cols) c:52% x:48% sv:$2.40
 micro (<60 cols)  c52 x48 sv$2
 nano (<40 cols)   c:52%/x:48%
```

Zero config. Open a vertical split pane and the HUD auto-collapses. Close it and it expands back. When `tfx-multi` is active, a live worker row appears showing per-CLI progress: `x✓ g⋯ c✗` (completed/running/failed).

Context token attribution tracks usage by skill, file, and tool call, with warnings at 60%/80%/90% context fill.

---

## Windows Terminal Orchestration

triflux doesn't just run in a terminal -- it **orchestrates** it. The WT Manager API provides:

- **Tab creation** with PID-tracked lifecycle (temp file polling for readiness)
- **Split-pane layouts** via `applySplitLayout()` for multi-agent dashboards
- **Dead tab pruning** using cross-platform PID liveness detection
- **Base64 PowerShell encoding** eliminating all quoting/escaping issues

Every direct `wt.exe` call is blocked by safety-guard. Agents can only use the managed API path, preventing uncontrolled terminal sprawl.

---

## Research Foundation

The triflux skill suite was shaped by patterns from across the Claude Code ecosystem:

| Project | Inspiration |
|---------|-------------|
| everything-claude-code | Instinct-based learning patterns |
| Superpowers | TDD enforcement, composable skills |
| oh-my-openagent | Category routing, Hashline edits |
| SuperClaude | index-repo 94% token reduction, expert panels |
| oh-my-claudecode | Ralph persistence, CCG tri-model |
| ruflo | 60+ agent orchestration |
| Exa / Brave / Tavily MCP | Neural search, deep research pipeline |

5-language research (EN/CN/RU/JP/UA) uncovered unique patterns: WeChat integration (CN), Discord mobile bridges (JP), GigaCode alternatives (RU), and community-driven localization efforts.

---

<p align="center">
  <sub>MIT License &middot; Made by <a href="https://github.com/tellang">tellang</a></sub>
</p>
