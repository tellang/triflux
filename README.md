[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="triflux" src="docs/assets/logo-dark.svg" width="200">
  </picture>
</p>

<p align="center">
  <strong>The Multi-Model Orchestration Hub for Claude Code</strong><br>
  <em>Vanish Claude tokens. Route tasks to Codex and Gemini via high-performance Hub IPC.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/v/triflux?style=flat-square&color=FFAF00&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/dm/triflux?style=flat-square&color=F5C242" alt="npm downloads"></a>
  <a href="https://github.com/tellang/triflux/stargazers"><img src="https://img.shields.io/github/stars/tellang/triflux?style=flat-square&color=FFAF00" alt="GitHub stars"></a>
  <a href="https://github.com/tellang/triflux/actions"><img src="https://img.shields.io/github/actions/workflow/status/tellang/triflux/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-374151?style=flat-square" alt="License: MIT"></a>
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
  <a href="#architecture">Architecture</a> ·
  <a href="#pipeline-thorough">Pipeline</a> ·
  <a href="#delegator-mcp">Delegator MCP</a> ·
  <a href="#agent-types">Agent Types</a> ·
  <a href="#security">Security</a>
</p>

---

## What's New in v4?

**triflux v4** evolves from a simple router into a **high-performance orchestration hub**. It introduces resident services, named-pipe IPC, and advanced task pipelines to provide the most stable multi-model experience for [Claude Code](https://claude.ai/code).

### Key Features

- **Hub IPC Architecture** — Lightning-fast resident Hub server with Named Pipe & HTTP MCP bridge.
- **Pipeline `--thorough`** — Multi-phase task lifecycle: `plan` → `prd` → `exec` → `verify` → `fix`.
- **Delegator MCP** — Native MCP tools (`delegate`, `reply`, `status`) for seamless agent interaction.
- **psmux / Windows Native** — Hybrid support for `tmux` (WSL) and `psmux` (Windows Terminal native).
- **QoS Dashboard** — Real-time health monitoring with AIMD-based dynamic batch sizing.
- **21+ specialized agents** — From `scientist-deep` to `spark_fast`, each optimized for specific tasks.

---

## Architecture

triflux uses a **Hub-and-Spoke** architecture. The resident Hub manages state, authentication, and task routing via high-performance Named Pipes.

```mermaid
graph TD
    User([User / Claude Code]) <-->|Slash Commands| TFX_CLI[tfx CLI]
    TFX_CLI <-->|Named Pipe / HTTP| HUB[triflux Hub Server]
    
    subgraph "Orchestration Hub"
        HUB <--> STORE[(SQLite Store)]
        HUB <--> DASH[QoS Dashboard]
        HUB <--> DELEGATOR[Delegator Service]
    end
    
    DELEGATOR <-->|Spawn| CODEX[Codex CLI]
    DELEGATOR <-->|Spawn| GEMINI[Gemini CLI]
    DELEGATOR <-->|Native| CLAUDE[Claude Code]
    
    HUB -.->|MCP Bridge| External[External MCP Clients]
```

---

## Quick Start

### 1. Install

```bash
npm install -g triflux
```

### 2. Setup (Required)

Synchronize scripts, register skills to Claude Code, and configure the HUD.

```bash
tfx setup
```

### 3. Usage

```bash
# Auto mode — Parallel execution via Hub
/tfx-auto "refactor auth + update UI + add tests"

# Pipeline mode — Thorough multi-phase execution
/tfx-auto --thorough "implement complex data migration"

# Direct Delegation
/tfx-delegate "research latest React patterns" --provider gemini
```

---

## Pipeline: `--thorough` Mode

The v4 Pipeline provides a robust execution loop designed for complex engineering tasks.

| Phase | Description |
|-------|-------------|
| **plan** | Architect the solution and identify dependencies. |
| **prd** | Generate a detailed Technical Specification / PRD. |
| **exec** | Perform the actual code implementation. |
| **verify** | Run tests and verify the implementation against the PRD. |
| **fix** | (Loop) Automatically fix failures identified in the verify phase (Max 3). |
| **ralph** | (Reset) If the fix loop fails, restart from `plan` with new insights (Max 10). |

---

## Delegator MCP

Interact with the Hub directly through MCP tools.

- **`delegate`**: Route a prompt to a specific provider or let the Hub decide. Supports `sync` and `async` modes.
- **`reply`**: Continue multi-turn conversations with a running agent (currently Gemini direct).
- **`status`**: Check the progress of asynchronous background tasks.

---

## Agent Types (21+)

| Agent | CLI | Purpose |
|-------|-----|---------|
| **executor** | Codex | Standard implementation & refactoring. |
| **build-fixer** | Codex/Gemini | Instant fixes for build/type errors. |
| **architect** | Codex | High-level system design & planning. |
| **scientist-deep** | Codex | Exhaustive research & deep analysis. |
| **code-reviewer** | Codex | Security & Logic focused code review. |
| **security-reviewer**| Codex | Vulnerability & Permission audit. |
| **quality-reviewer** | Codex | Logic & Maintainability audit. |
| **designer** | Gemini | UI/UX & documentation design. |
| **writer** | Gemini | Technical writing & explanations. |
| **spark** | Gemini | Lightweight, fast prototyping. |
| **verifier** | Claude | Final verification & validation. |
| **test-engineer** | Claude | Comprehensive test suite generation. |
| *...and more* | | `debugger`, `planner`, `critic`, `analyst`, `scientist`, `explore`, `qa-tester` |

---

## Security

triflux v4 is designed for secure, professional environments:

- **Hub Token Auth** — Secure IPC using `TFX_HUB_TOKEN` (Bearer Auth).
- **Localhost Only** — Default Hub binding to `127.0.0.1` prevents external access.
- **CORS Lockdown** — Strict origin checking for the QoS Dashboard.
- **Injection Protection** — Sanitized shell command execution in `psmux` and `tmux`.

---

## QoS Dashboard

Monitor your orchestration health at `http://localhost:27888/dashboard`.

- **AIMD Batch Sizing** — Automatically scales parallel tasks (3 → 10) based on success rates.
- **Token Savings** — Real-time tracking of Claude tokens saved by routing to Codex/Gemini.
- **Rate Limit Tracking** — Live monitoring of Codex and Gemini quotas.

---

## Platform Support

- **Linux / macOS**: Native `tmux` integration.
- **Windows**: **psmux** (PowerShell Multiplexer) + Windows Terminal hybrid for a native Windows experience.

---

<p align="center">
  <sub>MIT License · Made with ❤️ by <a href="https://github.com/tellang">tellang</a></sub>
</p>
