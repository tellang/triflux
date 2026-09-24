---
name: tfx-live
description: >
  Use when Claude, Codex, or a Triflux worker needs live Claude↔Codex orchestration:
  start/ask/stop, multi-turn, peer relay, daemon UDS attach, or UDS-first with tmux fallback.
argument-hint: "<start|ask|stop|interrupt|probe|list-sessions|peer|converse|goal-driven|orchestrate> ..."
---

# tfx-live: Claude↔Codex live orchestration

`tfx-live` is the Triflux-owned live bridge for Claude Code and Codex TUI sessions.
It runs as a local CLI (`tfx-live`) and supports tmux TUI control plus Claude and Codex daemon UDS attach.

## Default transport

- Claude targets with `--short` or `--session-id`: **UDS-first `auto` by default**.
- If UDS probe/attach fails: write `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`, then tmux fallback when `--session` is provided.
- Codex targets and Claude targets without a daemon ref: tmux by default.
- Codex existing threads use explicit `--transport uds --thread <id|auto>`; `auto` transport remains Claude-only.
- UDS completion contract: `done=true` only when `matchedCompletion===true`; `timedOut` or `closed` is not completion.
- Bridge resolution: `--bridge` > `$TFX_BRIDGE` > `$TFX_REPO_ROOT/hub/bridge.mjs` > bundled Triflux `hub/bridge.mjs`.

## Quick start

```bash
# Claude -> Codex helper session
tfx-live start --cli codex --session cx1 --cwd ~/Projects
tfx-live ask --cli codex --session cx1 --prompt "현재 변경사항을 요약해줘" --timeout 120
tfx-live stop --cli codex --session cx1

# Codex -> Claude tmux helper session
tfx-live start --cli claude --session cl1 --cwd ~/Projects
tfx-live ask --cli claude --session cl1 --prompt "이 구현을 리뷰해줘" --timeout 120
tfx-live stop --cli claude --session cl1
```

## UDS-first Claude daemon ask

Find daemon sessions:

```bash
tfx-live probe
```

Then ask by short:

```bash
tfx-live ask --cli claude --short <8hex> --prompt "STRUCTURED_RETURN_OK 만 답해줘" --timeout 120
```

Because `--short` is present, the default transport is `auto`: probe UDS first, then tmux fallback only if `--session` is also provided.
For explicit UDS-only failure behavior:

```bash
tfx-live ask --cli claude --transport uds --short <8hex> --prompt "..." --timeout 120
```

## Codex tmux session discovery

List the Codex CLI sessions already running in tmux; this does not require a
prior `tfx-live start`. The JSON result includes the tmux session name, start
time, current working directory, attachment state, `panes: [{ target, cwd,
command }]` for Codex panes, and `target` for the first matching pane.

```bash
# All locally running Codex tmux sessions
tfx-live list-sessions --cli codex

# Limit discovery to sessions whose pane cwd exactly matches this worktree
tfx-live list-sessions --cli codex --cwd ~/Projects/my-worktree
```

`probe` remains the Claude daemon/UDS discovery command. Use
`list-sessions --cli codex` when selecting an existing Codex tmux session to
pass to `tfx-live ask --session <name:window.pane>`.
Discovery and peer preflight also inspect pane tty/descendant processes for
the npm `node .../codex` shim, `codex.js`, and native `codex` executables.
`codex-code-mode-host` does not count. With `--remote`, the process check runs
on that host; unavailable `ps` produces a peer `preflightWarning` and allows
attach to continue.

`ask` and tmux `interrupt` accept session names, `name:window`, and
`name:window.pane`. `start` and `stop` require a session name only; `stop`
rejects pane targets because it kills the entire session. `--remote HOST`
preserves the complete target.
`stop` also rejects pane/window IDs such as `%12` and `@3`, and dotted targets.

Before pasting, `ask` checks the visible pane for active work and Codex
`model: loading`. `--if-busy wait|fail|interrupt` defaults to `wait`.
`--busy-timeout SECONDS` defaults to `--timeout`; `--poll-interval` is in
milliseconds. A busy timeout sends no prompt. `interrupt` sends Escape,
then waits for idle before pasting. Results include `ifBusy` and
`busyWaitedMs`. `converse`, `goal-driven`, and `peer` accept these flags too.
Only the last visible `model:` header controls loading detection. Time-only
lines are removed from the response tail; times inside the answer remain.

## Existing Codex TUI thread over UDS

With `daemon_auto_start` enabled, Codex TUI runs on a shared local app-server
daemon. Its default socket is
`$CODEX_HOME/app-server-control/app-server-control.sock`, or the same path
under `~/.codex` when `CODEX_HOME` is unset. `--codex-socket PATH|default`
selects an existing socket and follows symlinks. If absent, start the daemon
with `codex app-server daemon start`.

```bash
tfx-live list-sessions --cli codex --transport uds --cwd ~/Projects/my-worktree
tfx-live ask --cli codex --transport uds --thread auto \
  --cwd ~/Projects/my-worktree --prompt "현재 변경사항을 요약해줘" \
  --if-busy wait --busy-timeout 120 --timeout 120
tfx-live ask --cli codex --transport uds --thread <id> \
  --codex-socket default --prompt "추가 확인 사항" --if-busy fail
```

No `--session`, `--short`, or `--session-id` is required. Discovery returns
`[{ threadId, cwd, name, status, source }]` for loaded threads. `--thread auto`
selects exactly one loaded thread after optional realpath-normalized `--cwd`
filtering. Start the TUI and send its first message if none is loaded. Multiple
matches produce an error listing candidates; select an explicit thread ID.

The client calls `thread/resume` with `excludeTurns: true` before `turn/start`
to subscribe to response notifications. It does not request historical turns.
UDS `--if-busy wait|fail|steer` defaults to `wait`.
`steered` uses the returned turn ID and fresh `turn/started` events after
subscription, not the earlier busy snapshot; when a current turn ID is
available, `turn/steer` sends it as `expectedTurnId`.
The fallback treats no fresh matching `turn/started` before completion as a
reused turn; it relies on ordered notifications from the resumed connection.
Completion matches the returned turn ID. Closing the client
does not archive or delete the thread, or start or stop the shared daemon.
Responses prefer completed `final_answer` items, joined with blank lines;
without one, the last agent message is used. Intermediate commentary is
returned separately. Retryable error notifications keep the turn open and
increment `meta.retries`.
`--max-turn SECONDS` sets the Codex UDS activity extension ceiling. Remote
relay timeouts include busy waiting, the full turn allowance, and a relay margin.
Codex relay budgets also allow the next lifecycle timer check after that ceiling.

Codex UDS `interrupt` is unavailable: `turn/interrupt` requires a turn ID,
which the supported metadata-only `thread/read` does not provide. Use tmux
`interrupt --session <target>` when the TUI pane is available.

## Peer relay

```bash
# tmux-only peer
tfx-live peer --cli-a codex --cli-b claude \
  --session-a cx-peer --session-b cl-peer \
  --cwd ~/Projects --mode freeform --seed "둘이 변경을 리뷰하고 역할을 나눠라" \
  --rounds 2 --timeout 180

# Codex tmux + Claude daemon UDS-first
tfx-live peer --cli-a codex --cli-b claude \
  --session-a cx-peer --session-b cl-fallback --short-b <8hex> \
  --cwd ~/Projects --mode freeform --seed "서로 응답을 다음 프롬프트로 이어받아라" \
  --rounds 2 --timeout 180

# Attach both existing tmux panes without starting or stopping their sessions
tfx-live peer --cli-a codex --cli-b claude \
  --session-a work:0.1 --session-b work:0.2 --attach-a --attach-b \
  --mode freeform --seed "변경을 검토해줘" --if-busy wait

# Existing Codex daemon thread + existing Claude daemon session
tfx-live peer --cli-a codex --transport-a uds --thread-a <id|auto> \
  --codex-socket-a default --cli-b claude --transport-b uds --short-b <8hex> \
  --cwd ~/Projects/my-worktree --mode freeform --seed "변경을 검토해줘"
```

In `peer`, every hop sends the previous response as the next prompt to the opposite agent; the final JSON includes the transcript and lifecycle metadata.

`--attach-a` and `--attach-b` preflight existing tmux targets before any hop.
Codex targets must identify a Codex pane. Attached sessions are preserved on
success, error, SIGINT, and SIGTERM. UDS sides are always treated as attached.
The result includes `attachedA` and `attachedB`. Side-specific UDS flags are
`--thread-a`, `--thread-b`, `--codex-socket-a`, and `--codex-socket-b`.
`--if-busy-a` and `--if-busy-b` accept `wait|fail|interrupt` for tmux and
`wait|fail|steer` for Codex UDS. A common `--if-busy` must be valid for both
sides even when one side overrides it. UDS done-marker lines are removed
before relaying a response. `stoppedA`/`stoppedB` are true only after an owned
session was actually stopped; attached sides stay false.

## Known limits

- A draft in the TUI composer can merge with the pasted prompt. Changing
  placeholder text prevents reliable detection without terminal styling.
- `--thread auto` can be ambiguous when an ephemeral orchestrate thread
  remains loaded. The candidate-list error exposes this; choose a thread ID.
- A TUI's thread stays loaded in the shared daemon after that TUI exits
  (observed with codex-cli 0.156.1: a `tfx-live stop`ped peer session left its
  thread in `thread/loaded/list`). Stale threads in the same cwd make
  `--thread auto` ambiguous, so pin `--thread ID` for long-lived targets.

## Orchestrate (Claude UDS + Codex)

`orchestrate` exposes the `runUdsOrchestration` engine as a formal verb: Claude is driven over the daemon control socket (UDS) and Codex over a selectable transport, in one of three shapes.

```bash
# default: Codex over the stdio one-shot path (codex exec)
tfx-live orchestrate --task "이 변경의 위험을 한 줄로" --mode peer

# experimental: Codex over a real `codex app-server` WebSocket-over-UDS daemon
tfx-live orchestrate --task "이 변경의 위험을 한 줄로" \
  --mode codex-led --codex-transport app-server-uds --timeout 120

# Attach the shared daemon and create a new ephemeral thread for orchestration
tfx-live orchestrate --task "이 변경의 위험을 한 줄로" \
  --mode codex-led --codex-socket default --timeout 120
```

- `--mode` = `peer` (default) | `codex-led` | `claude-led`.
- `--codex-transport` = `exec` (default, `codex exec` stdio) | `app-server-uds` (experimental).
  - `app-server-uds` spawns a private `codex app-server --listen unix://<tmp>`, attaches over WebSocket-over-UDS (RFC 6455, masked client frames), runs `initialize`→`thread/start`→`turn/start`, and resolves on `turn/completed`. Transport proven against codex-cli 0.135.0 (see `experiments/native-bridge-feasibility/codex-app-server-uds-smoke.mjs`).
  - `--codex-socket PATH|default` implies `app-server-uds` and conflicts with explicit `--codex-transport exec`. It attaches without spawning or killing the daemon and still creates a new ephemeral thread.
  - Without `--codex-socket`, `app-server-uds` uses the private server path; the default transport remains `exec`.
- Requires a live Claude daemon (same as the UDS `ask` path) for the Claude side.

## Useful diagnostics

```bash
# Show CLI help
tfx-live --help

# Probe daemon sessions through Triflux bridge
tfx-live probe

# Discover existing Codex tmux sessions
tfx-live list-sessions --cli codex
```

If auto falls back, inspect `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json` (override with `$TFX_LIVE_BUG_REPORT_DIR` for tests).
