# Triflux vs codex-plugin-cc Comparison

Date: 2026-04-03

## 1. Scope

This comparison focuses only on Codex invocation mechanics and the product intent around them.

It does not try to compare:

- Gemini integration
- Claude-native orchestration in general
- Triflux dashboard/team UX outside Codex execution

## 2. Triflux Codex execution surfaces

Code-level inspection shows four concrete surfaces.

### Family A: routed one-shot execution

Primary files:

- `scripts/tfx-route.sh`
- `scripts/tfx-route-post.mjs`

Behavior:

- resolves role/profile to Codex CLI arguments
- supports `exec`, `mcp`, and `auto` transport selection
- falls back from MCP bootstrap to legacy exec when needed
- post-processes stdout/stderr into a compact `TFX-ROUTE RESULT`

Intent:

- cheap one-shot analysis/review/planning
- centralized CLI policy and fallback logic

### Family B: headless or direct worker execution

Primary files:

- `hub/workers/codex-mcp.mjs`
- `hub/workers/delegator-mcp.mjs`
- `hub/team/backend.mjs`
- `hub/team/headless.mjs`
- `hub/team/pane.mjs`

Behavior:

- direct MCP workers can talk to `codex mcp-server` over stdio and keep thread identity in process memory
- headless workers use `CodexBackend.buildArgs()` to run `codex exec ... --output-last-message`
- interactive pane startup uses `buildCliCommand("codex")` and prompt injection
- result collection is oriented around files or pane capture, not around Codex thread state

Intent:

- durable implementation/test/refactor work
- worker panes and long-lived sessions

### Family C: native wrapper delegation

Primary files:

- `hub/team/native.mjs`
- `.claude/agents/slim-wrapper.md` referenced by native wrapper flows

Behavior:

- Claude native teammates are forced to delegate via `tfx-route.sh`
- async job polling is added on top of the routed path
- the wrapper is strict about not allowing direct repo edits

Intent:

- use Claude-native teammate control while still centralizing external Codex/Gemini invocation

### Practical summary

From a code view the four surfaces are:

1. `scripts/tfx-route.sh` routed one-shot
2. `hub/workers/codex-mcp.mjs` direct MCP worker path
3. `hub/team/pane.mjs` and related direct interactive pane startup
4. `hub/team/backend.mjs`/`hub/team/headless.mjs` headless one-shot worker path

From a product view the user's "about three ways" instinct is still basically right:

1. routed one-shot
2. direct/headless worker execution
3. native teammate wrapper that still delegates to the routed path

## 3. codex-plugin-cc execution model

`codex-plugin-cc` has one dominant execution surface:

- `codex-companion.mjs` backed by the Codex app server

Everything else is a thin shell around that runtime:

- slash commands
- rescue subagent
- session hooks
- stop-review gate

This is the opposite of Triflux:

- Triflux has many surfaces and central route policy
- `codex-plugin-cc` has one stateful runtime and many thin entrypoints

## 4. Intent difference

### Triflux

Core intent:

- orchestrate across multiple models and multiple execution surfaces
- pick the cheapest or most useful surface per task
- support both text-oriented and implementation-oriented paths

That is why Triflux contains:

- route policy
- team/headless runtime
- pane runtime
- dashboard/runtime monitoring

### codex-plugin-cc

Core intent:

- give Claude Code users a reliable way to call into Codex
- preserve Codex continuity, not multi-model orchestration
- make review, rescue, status, result, and cancel feel native

That is why the plugin invests in:

- thread persistence
- broker/direct runtime reporting
- session-scoped job filtering
- result rendering with resume hints

## 5. Mechanism difference

### Transport

Triflux:

- shell and worker oriented
- `codex exec` and optional MCP bootstrap in `tfx-route.sh`
- pane/headless execution separately built in team runtime

codex-plugin-cc:

- app-server-native
- broker/shared-session aware
- explicit thread/turn/review objects

### State

Triflux:

- execution results are often text-first
- state exists for team orchestration, but not every routed Codex run preserves Codex-native session continuity

codex-plugin-cc:

- jobs are first-class persisted records
- `threadId` is a user-visible artifact
- session filtering and resume behavior are built in

### UX

Triflux:

- optimized for route output, orchestration status, and cross-model flows

codex-plugin-cc:

- optimized for "what did Codex do, and how do I resume/manage it now?"

## 6. What should not be copied

- Triflux should not collapse into a single plugin-style runtime
- Triflux should not adopt Claude-plugin assumptions as core architecture
- Triflux should not replace multi-surface orchestration with a thin-forwarder-only model

Those changes would fight Triflux's product intent.

## 7. What is worth copying

The strongest transferable idea is:

- preserve Codex thread/session continuity wherever Triflux already invokes Codex successfully

This idea fits Triflux because it improves all of the following without changing the overall architecture:

- debuggability
- follow-up handoff
- resume ergonomics
- user trust in routed executions

## 8. Selected improvement for this pass

Chosen feature:

- surface Codex session id and `codex resume <id>` hint in routed Triflux output when the session id is available

Why this one:

- direct value
- low-risk scope
- aligns with `codex-plugin-cc`'s strongest UX idea
- does not force Triflux into the plugin's single-runtime architecture

Implemented in:

- `scripts/tfx-route-post.mjs`
- `tests/unit/v24-functions.test.mjs`

Behavior:

- extract session/thread ids from routed Codex output or stderr metadata
- append a stable resume hint if one is available and not already present
- preserve existing compact output style

## 9. Deferred ideas

These are plausible future follow-ups but were intentionally not included in this PR-sized change:

- expose effective Codex transport mode (`exec`, `mcp`, `exec-fallback`) in the user-visible routed output
- persist asynchronous routed Codex jobs with session-aware status/result commands
- split Triflux review paths into native review vs steerable adversarial review contracts
- normalize session/thread surfacing across routed, headless, and pane-based Codex paths
