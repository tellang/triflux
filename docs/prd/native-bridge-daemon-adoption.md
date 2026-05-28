# Native Bridge Daemon Adoption Gap

## Status

- PR #359 is merged into `origin/main` at `284b7b91` and CI `test` passed.
- The remaining `checkpoint restoration native bridge` gap is not the PR #359 EPIPE/E2E work; it is the manual `claude agents` adoption path for interactive facade workers.
- Current worktree `.claude/worktrees/native-bridge-c8-e2e` contains an uncommitted partial change in `hub/team/interactive-native-launcher.mjs` that moves facade sockets from `os.tmpdir()` into the Claude daemon `rv/` and `pty/` directories. This aligns socket placement with daemon-managed workers, but it is not sufficient as a standalone fix.

## Observed failure

`launchAdoptedInteractiveWorker()` starts a local interactive facade and writes a roster entry, but the worker does not appear in `claude agents` and no daemon `bg-pty-host` process attaches to the facade pty socket.

The recovered live probe found a deeper mismatch:

1. Visible `claude agents` workers are daemon-dispatched jobs.
2. The daemon dispatch path sends `{ proto: 1, op: "dispatch", d: payload }` to `control.sock`.
3. That payload has `launch.mode: "exec"`, `cmd: "/bin/zsh"`, and `args: ["-lc", command]`.
4. The daemon then exposes a job pid and bridge session id.
5. The facade launcher currently writes only roster state; it does not ask the daemon to dispatch or adopt anything.

## Code evidence

- `hub/team/claude-daemon-control.mjs:956-992` builds the daemon `exec` dispatch payload.
- `hub/team/headless.mjs:961-1058` sends `op: "dispatch"`, waits for a daemon job pid, resolves the bridge session id, then writes the session projection.
- `hub/team/claude-native-bridge.mjs:483-520` uses the same dispatch path for non-interactive native bridge swarm shards.
- `hub/team/claude-native-bridge.mjs:394-480` takes a different interactive path: it starts a local facade, starts the tmux transport, writes roster, and returns without dispatch.
- `hub/team/interactive-native-launcher.mjs` likewise starts a facade and writes roster only.

## Decision

Do not PR the socket-location-only change as a fix. Socket placement may be part of a future fix, but the missing behavior is daemon dispatch/adoption.

## Fix shape to investigate next

A real fix needs one of these designs:

### Option A — daemon owns process, Triflux wraps command

Use the existing daemon `exec` dispatch path for interactive workers and run a Triflux bridge command that connects daemon-owned pty I/O to the existing tmux transport. This matches known daemon semantics and should make `claude agents` rows visible.

Likely touchpoints:

- `hub/team/interactive-native-launcher.mjs`
- `hub/team/claude-native-bridge.mjs`
- `hub/team/claude-daemon-control.mjs`
- `hub/team/headless.mjs` dispatch helpers, if they can be shared rather than duplicated

### Option B — daemon adopts an existing facade socket

Only viable if the Claude daemon supports an undocumented attach/adopt-existing-socket operation. Current repo evidence does not show such a mode; `buildDaemonExecDispatchPayload()` only emits `launch.mode: "exec"`.

## Verification requirements for any future fix

- A visible `claude agents` row is created by the daemon, not by roster-only mutation.
- The row has a daemon job pid and bridge session id resolvable through the `control.sock` list/job state path.
- Human input through `claude agents` reaches the tmux-backed interactive transport.
- Teardown removes daemon job/projection/roster state without leaving sockets or tmux sessions behind.
- PR #359 opt-in real-tmux E2E remains green; it proves the lower transport hop but not daemon adoption.
