# codex-plugin-cc Reverse Engineering Notes

Date: 2026-04-03
Clone location: `C:\Users\SSAFY\Desktop\Projects\cli\codex-plugin-cc`
Target version: `@openai/codex-plugin-cc@1.0.2`

## 1. Product intent

`codex-plugin-cc` is not a general orchestration system. It is a Claude Code plugin whose core promise is:

- keep the user inside Claude Code
- delegate selected work to the local Codex runtime
- preserve Codex thread continuity so the user can resume or manage runs later
- expose that runtime through a small set of slash commands and one thin subagent

This intent is explicit in:

- `README.md`
- `plugins/codex/commands/*.md`
- `plugins/codex/agents/codex-rescue.md`

The plugin is optimized for one host environment, one external delegate, and one narrow workflow family:

- review current code with Codex
- ask Codex to rescue/investigate/fix
- manage the resulting jobs from Claude Code

## 2. Repository structure

The codebase is intentionally narrow:

- `plugins/codex/commands/*.md`
  - Claude slash command entrypoints
- `plugins/codex/agents/codex-rescue.md`
  - thin forwarding subagent
- `plugins/codex/scripts/codex-companion.mjs`
  - single command runtime for setup, review, task, status, result, cancel
- `plugins/codex/scripts/lib/codex.mjs`
  - Codex app-server client orchestration and thread/turn capture
- `plugins/codex/scripts/lib/state.mjs`
  - workspace-scoped state + job index
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
  - background job lifecycle and progress persistence
- `plugins/codex/scripts/lib/job-control.mjs`
  - status/result/cancel resolution and session filtering
- `plugins/codex/scripts/lib/render.mjs`
  - user-facing text rendering, including resume hints
- `plugins/codex/scripts/lib/broker-lifecycle.mjs`
  - shared broker startup/teardown for a reusable app-server runtime
- `plugins/codex/scripts/session-lifecycle-hook.mjs`
  - Claude session hook to export session data and clean up on session end
- `plugins/codex/scripts/stop-review-gate-hook.mjs`
  - optional stop-time review gate
- `tests/*.test.mjs`
  - strong runtime-level regression coverage

## 3. Command surface

The plugin exposes six user-visible command families:

- `/codex:setup`
  - environment, auth, and optional review-gate management
- `/codex:review`
  - built-in read-only review path
- `/codex:adversarial-review`
  - structured, steerable design challenge review
- `/codex:rescue`
  - task delegation to Codex with optional backgrounding and resume behavior
- `/codex:status`
  - active/recent job inspection
- `/codex:result`
  - final stored result retrieval
- `/codex:cancel`
  - interrupt active work

The important architectural point is that the slash commands are thin shells. They almost all converge on `scripts/codex-companion.mjs`.

## 4. Runtime architecture

### 4.1 One central runtime

`plugins/codex/scripts/codex-companion.mjs` is the real product core.

It centralizes:

- command parsing
- model/effort normalization
- setup checks
- review dispatch
- task dispatch
- background worker spawning
- job persistence
- status/result/cancel behavior
- rendering

This is a strong architectural decision. The plugin avoids re-implementing Codex invocation logic in every slash command or agent prompt.

### 4.2 Review path split

The plugin has two different review implementations.

`/codex:review`

- implemented in `executeReviewRun()`
- uses `runAppServerReview()` in `lib/codex.mjs`
- validates the request against Codex's native review target model
- stays read-only
- does not accept arbitrary focus text

`/codex:adversarial-review`

- implemented in the same `executeReviewRun()` function but through the non-native path
- builds a custom prompt from `prompts/adversarial-review.md`
- runs `runAppServerTurn()`
- requests structured JSON output via `schemas/review-output.schema.json`
- renders richer findings with severity ordering through `lib/render.mjs`

The plugin therefore treats "plain review" and "pressure-test review" as different product surfaces, not one flag on the same call.

### 4.3 Task / rescue path

The rescue path is built around persistent task threads.

Key behavior from `executeTaskRun()` in `codex-companion.mjs`:

- task threads are persisted with `persistThread: true`
- `--resume`/`--resume-last` reopens the latest tracked task thread for the repo
- default prompt for resume is `DEFAULT_CONTINUE_PROMPT`
- write mode is explicit and changes sandbox from `read-only` to `workspace-write`
- the rendered task result is built with `renderTaskResult()`

This is the single biggest product difference from a simple one-shot wrapper:

- the plugin treats Codex work as a resumable thread, not just an execution result

### 4.4 Background execution

Background execution is not a shell hack. It is a structured stateful flow:

- `handleTask()` creates a job record
- `enqueueBackgroundTask()` stores the request payload
- `spawnDetachedTaskWorker()` starts a detached Node worker
- `handleTaskWorker()` rehydrates the stored request
- `runTrackedJob()` updates JSON state and append-only log files

This design gives the plugin first-class `/status`, `/result`, and `/cancel` semantics.

## 5. Codex transport model

### 5.1 App server first

The plugin is built around the Codex app server, not around scraping one-shot CLI output.

`lib/codex.mjs` uses:

- `CodexAppServerClient.connect(...)`
- `thread/start`
- `thread/resume`
- `turn/start`
- `review/start`
- `turn/interrupt`
- `thread/list`

That means the plugin operates on explicit Codex objects:

- threads
- turns
- review threads
- interruptions

### 5.2 Shared broker with direct fallback

`withAppServer()` in `lib/codex.mjs` tries a shared broker-backed client first when present.

If broker transport is busy or unavailable, it falls back to direct client startup.

This is backed by:

- `lib/broker-lifecycle.mjs`
- `scripts/app-server-broker.mjs`
- `getSessionRuntimeStatus()`

The runtime therefore has two real transport modes:

- direct startup
- shared session via broker

The mode is not hidden. It is surfaced in setup/status rendering.

## 6. Session and state model

### 6.1 Workspace-scoped state

`lib/state.mjs` hashes the canonical workspace root and stores per-workspace state under:

- `CLAUDE_PLUGIN_DATA/state/<slug>-<hash>`
- fallback: temp dir if plugin data dir is not available

Stored artifacts include:

- `state.json`
- per-job JSON files
- per-job logs
- broker session metadata

### 6.2 Claude session scoping

`session-lifecycle-hook.mjs` exports the Claude session id via:

- `CODEX_COMPANION_SESSION_ID`

This id is then used to:

- filter visible jobs to the current Claude session
- choose a resume candidate for the current session
- clean up session-owned jobs on session end

This is a crucial product decision:

- workspace state is durable
- session views are scoped

### 6.3 Resume-friendly rendering

`lib/render.mjs` treats `threadId` as a first-class UX artifact.

It renders:

- `Codex session ID: ...`
- `Resume in Codex: codex resume <thread>`

This appears in:

- stored result rendering
- job detail rendering
- active/recent job tables

The plugin assumes that a Codex run without resumability is materially worse UX.

## 7. Hook model

The plugin uses Claude hooks for two purposes.

### 7.1 Session lifecycle

`session-lifecycle-hook.mjs`

- on `SessionStart`
  - exports session id and plugin data dir into Claude's env file
- on `SessionEnd`
  - shuts down broker
  - kills leftover running job processes
  - removes session-owned jobs from state

### 7.2 Optional stop gate

`stop-review-gate-hook.mjs`

- checks whether review gate is enabled in config
- verifies Codex setup/auth first
- runs a stop-time review task through `codex-companion.mjs task --json`
- blocks session end if the result begins with `BLOCK:`

This is intentionally expensive and guarded in README because it can create a Claude/Codex feedback loop.

## 8. Prompting and agent design

The plugin is disciplined about Claude-side scope.

`plugins/codex/commands/rescue.md` and `plugins/codex/agents/codex-rescue.md` enforce:

- the Claude subagent is a thin forwarder
- one Bash call to the companion runtime
- no repo inspection by the forwarding agent
- no follow-up summarization
- write-capable rescue by default unless the user requests read-only behavior

This prevents "double orchestration":

- Claude does not half-solve the task before handing it to Codex
- Codex remains the real task executor

## 9. Testing strategy

The repo is unusually well tested for a plugin this small.

Tests cover:

- broker endpoint and lifecycle behavior
- runtime setup detection
- fake Codex execution
- task backgrounding
- session filtering
- resume candidate selection
- result rendering
- review-gate behavior
- shared session runtime reporting

The test suite is not just unit-level. It encodes product contracts.

## 10. Design strengths

- Single runtime core instead of duplicated command logic
- App-server-native thread/turn model
- Explicit resume semantics
- Workspace + session-scoped job model
- Strong render layer that exposes actionable next steps
- Clean hook-based session cleanup
- Good regression coverage for operational behavior

## 11. Design limits

- It is single-delegate by design: Codex inside Claude Code
- It is not a multi-model scheduler
- It assumes Claude Code plugin semantics and lifecycle hooks
- Background management is oriented around one plugin runtime, not around distributed worker surfaces

## 12. What is reusable for Triflux

Strong candidates:

- Preserve Codex session/thread identifiers and surface `codex resume` hints
- Make transport/runtime mode more explicit in user-facing results
- Keep durable, workspace-scoped job metadata when Triflux chooses asynchronous Codex work
- Treat "review" and "steerable challenge review" as distinct contracts when relevant

Weak candidates:

- Porting the whole broker/session model into Triflux wholesale
- Replacing Triflux's multi-surface execution model with a plugin-style thin forwarder

The plugin is strongest where it treats Codex as a first-class stateful runtime. That idea transfers. Its Claude-plugin-specific shell does not.
