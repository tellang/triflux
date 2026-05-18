# macOS Process Lifecycle Leak Report

Date: 2026-05-18
Host: macOS / darwin
Repo: `triflux`
Scope: read-only investigation and problem definition. No process cleanup or code changes were performed.

## Executive Summary

This is not a single macOS compatibility bug. The observed RAM/process issue is a layered failure:

1. A runaway orphaned `node --test` process is the direct high-memory offender.
2. Detached `hub/server.mjs` instances accumulate because hub lifecycle cleanup is not global enough.
3. macOS multiplexer detection incorrectly reports `psmux` even though this host is tmux-only.
4. Detached tmux sessions and zombie processes are secondary cleanup-policy symptoms, not the main RAM source.

The biggest RAM symptom is a design/lifecycle bug in the test runner supervision path, not a psmux/tmux issue. The true macOS compatibility regression is the multiplexer identity mismatch: `session.mjs` reports `"psmux"` on darwin while the resolved primary multiplexer is `"tmux"` and no `psmux` binary exists.

## Current Live Evidence

### High-memory test process

Current process:

```text
PID: 72215
PPID: 1
Started: Sat May 16 13:29:06 2026
Age at sampling: about 2 days
Command: /opt/homebrew/Cellar/node/26.0.0/bin/node --test --test-force-exit --test-concurrency=8 ...
```

`top` sample:

```text
PID    PPID COMMAND MEM RSIZE STATE    TIME
72215  1    node    30G 30G   sleeping 49:25:37
```

`vmmap -summary` sample:

```text
Physical footprint:         29.7G
Physical footprint (peak):  29.7G
Writable regions: Total=31.4G written=29.7G resident=22.4M swapped_out=29.7G
MALLOC_SMALL                      26.9G
DefaultMallocZone_0x103a6c000     31.0G ... 29.7G ...
```

Interpretation:

- Stats.app showing Node around 24-30 GB is materially correct when reading footprint/pressure, even if RSS-only tools undercount it.
- Most of the footprint is swapped/compressed rather than resident, but it is still real memory pressure.
- `PPID=1` means the test process has been reparented to launchd and is no longer supervised by its original parent.

### Hub server accumulation

Current aggregate:

```text
hub_server_count=46
hub_server_ppid1=46
hub_server_total_rss_kb=693312
hub_server_total_rss_mb=677.1
```

All observed `hub/server.mjs` processes are orphan-like `PPID=1` detached processes.

The pid file is stale or at least not the active source of truth:

```json
{
  "pid": 86156,
  "port": 29196,
  "version": "10.21.0-867d18a3",
  "url": "http://127.0.0.1:29196/mcp"
}
```

But the default live health endpoint responds on port `27888`:

```json
{
  "ok": true,
  "version": "10.20.2-efabb91b",
  "platform": "darwin",
  "uptime_s": 260690,
  "node": "v26.0.0",
  "sessions": 8
}
```

Interpretation:

- The active hub and the pid-file hub do not agree.
- Multiple detached hubs can survive across sessions, versions, and worktrees.
- The total hub memory is not the 30 GB problem, but it is a persistent process leak.

### Multiplexer identity mismatch

Host state:

```text
psmux_path=MISSING
tmux_path=/opt/homebrew/bin/tmux
tmux 3.6a
```

Runtime module state:

```json
{
  "platform": "darwin",
  "sessionDetectMultiplexer": "psmux",
  "psmuxModuleMultiplexerType": "tmux",
  "hasMultiplexer": true,
  "hasPsmuxAlias": true
}
```

Terminal opener command generation:

```text
psmux: new-window -n 'Demo' 'psmux attach-session -t '\''demo-session'\'''
tmux:  new-window -n 'Demo' 'tmux attach-session -t '\''demo-session'\'''
```

Interpretation:

- macOS is correctly configured as tmux-only at the host level.
- `psmux.mjs` internally resolves the primary multiplexer to `tmux`.
- `session.mjs` still converts the backward-compatible `hasPsmux` alias into the literal mux identity `"psmux"`.
- Any caller that uses the literal detected mux to build attach commands may emit `psmux attach-session` on macOS, which will fail on this host.

### Detached tmux sessions and zombies

Detached sessions observed:

```text
omx-projects-detached-1778545119011-924vgc
omx-projects-detached-1778550044173-9cxefn
omx-projects-detached-1778804860192-a4p8pm
omx-tpcg-mailrouter-main-1778811369664-0uuxot
omx-triflux-fix-codex-exec-stdin-redirect-1778823416380-nujufh
omx-work-detached-1778633591273-xqcz4d
tfx-mac-multi-smoke-6ncsss
tfx-multi-wsn7jknb
tpcg-brief-53631
tpcg-brief-8878
tpcg-demo-server
```

Zombie count:

```text
zombie_count=8
```

Interpretation:

- tmux is preserving detached sessions exactly as designed.
- Some sessions are old and unattended, so lifecycle policy is too weak for this workflow.
- Zombies have zero meaningful memory footprint, but they are evidence of missing reap/cleanup in some parent chains.

## Code Evidence

### Test runner supervision gap

Relevant files:

- `package.json`
- `scripts/test-lock.mjs`
- `scripts/release/prepare.mjs`

`package.json` routes normal tests through the lock wrapper:

```json
"test": "node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 \"tests/**/*.test.mjs\" \"scripts/__tests__/**/*.test.mjs\"",
"test:unit": "node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/unit/**/*.test.mjs",
"test:integration": "node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/**/*.test.mjs"
```

`scripts/test-lock.mjs` is explicitly designed to avoid concurrent test memory explosions:

```js
// npm test 동시 실행 방지. conductor 같은 child-spawn 테스트가
// 3중 실행되면 WT ConPTY 수백 개 -> 16GB RAM 사고 발생.
```

But the wrapper only guards concurrent start, not child lifetime:

```js
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(143);
});

const child = spawn(process.execPath, args, {
  stdio: ["pipe", "inherit", "inherit"],
  env: { ...process.env, TEST_LOCK_PID: String(process.pid) },
});

child.on("exit", (code) => {
  releaseLock();
  process.exit(code ?? 1);
});
```

Missing pieces:

- No timeout in `scripts/test-lock.mjs`.
- No signal forwarding to the child.
- No child kill on parent exit.
- No process group / detached group management.
- No stale child detection when a lock is older than 10 minutes.
- Stale lock removal does not imply stale process cleanup.

`scripts/release/prepare.mjs` has a 10-minute timeout for the release path:

```js
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
...
options: {
  timeoutMs: TEST_TIMEOUT_MS,
  maxBuffer: 128 * 1024 * 1024,
  shell: false,
}
```

But normal `npm test`, `npm run test:unit`, and `npm run test:integration` do not inherit that timeout unless they are executed through the release prepare command.

Classification: design error. macOS exposes the failure clearly because orphaned children are reparented to launchd and memory pressure is visible in footprint/swap metrics, but the underlying supervision gap is cross-platform.

### Hub detached singleton gap

Relevant file:

- `scripts/hub-ensure.mjs`

The hub is started as a detached, unreferenced process:

```js
const child = spawn(process.execPath, [serverPath], {
  env,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
child.unref();
```

The startup path checks only the target host/port health:

```js
if (await isHubHealthy(host, port)) {
  await syncHubConfigsIfAvailable({ hubUrl });
  snapshotUserStateBestEffort();
  return { code: 0, stdout: "hub: ok", stderr: "" };
}

const started = startHubDetached(port);
```

Missing pieces:

- No repo-wide or user-wide stale hub reaper.
- No active validation that `~/.claude/cache/tfx-hub/hub.pid` points to a live current hub.
- No cleanup of older hub processes on random ports.
- No version-aware retirement when newer/older hubs coexist.

Classification: design/operational lifecycle error. This is not the immediate 30 GB offender, but it is a real leak pattern.

### macOS tmux/psmux compatibility regression

Relevant files:

- `hub/team/psmux.mjs`
- `hub/team/session.mjs`
- `hub/team/terminal-opener.mjs`

`hub/team/psmux.mjs` correctly documents and resolves mac/Linux primary mux as tmux:

```js
//   - mac/Linux: tmux 가 primary (POSIX 표준)
//   - Windows: psmux 가 primary (Windows pwsh7 전용)
...
// mac/Linux primary: tmux (POSIX 표준). silent fallback 아님 — 정식 primary.
```

It also preserves a backward-compatible alias:

```js
export function hasMultiplexer() { ... }
export const hasPsmux = hasMultiplexer;
export function getMultiplexerType() {
  return PSMUX_BIN;
}
```

`hub/team/session.mjs` treats that alias as literal psmux identity:

```js
if (hasPsmux()) {
  _cachedMux = "psmux";
  return _cachedMux;
}
if (hasTmux()) {
  _cachedMux = "tmux";
  return _cachedMux;
}
```

That is the regression. On macOS, `hasPsmux()` means "the OS primary mux is available", not "literal psmux binary is available".

`hub/team/terminal-opener.mjs` then builds literal attach commands from the mux identity:

```js
function buildAttachCommand(mux, sessionName) {
  if (mux === "psmux") {
    return `${shellCommandName(process.env.PSMUX_BIN || "psmux")} attach-session -t ${shellQuote(sessionName)}`;
  }
  return `tmux attach-session -t ${shellQuote(sessionName)}`;
}
```

Classification: macOS compatibility regression. It does not explain the 30 GB test process, but it can break attach/open/doctor/team-session behavior on tmux-only macOS hosts.

### SessionEnd cleanup is intentionally report-only

Relevant file:

- `hooks/session-end-cleanup.mjs`

The hook states its boundary:

```js
// Report-only by default. Opt-in cleanup only removes the repo-local
// .triflux/subagents/subagents.json file when stale running lifecycle state is
// present. It never kills processes or touches external HOME/MCP configs.
```

Classification: cleanup-policy gap. This is safe by design, but it means stale sessions and child processes require separate lifecycle management.

## Root Cause Classification

| Symptom | Primary classification | Evidence | RAM relevance |
| --- | --- | --- | --- |
| `node --test` PID 72215, 29.7G footprint, `PPID=1` | Design/lifecycle bug | `test-lock` has no timeout or child-kill supervision | Direct high-memory root |
| 46 orphan-like `hub/server.mjs` processes | Design/operational lifecycle bug | detached `unref()` start; no stale hub reaper | Medium, about 677 MB RSS |
| mac detects `"psmux"` while psmux is missing and tmux exists | macOS compatibility regression | `hasPsmux` alias used as literal mux identity | Indirect; breaks attach/cleanup surfaces |
| Detached tmux sessions | Cleanup-policy gap | tmux sessions all `attached=0`; no destructive cleanup by default | Indirect |
| 8 zombies | Process reap gap | `<defunct>` entries | Negligible memory |

## Why Existing Tests Did Not Catch This

Targeted tests run during investigation passed:

```text
node --test --test-force-exit tests/unit/runtime-strategy.test.mjs tests/unit/terminal-opener.test.mjs tests/unit/process-cleanup.test.mjs tests/unit/hub-ensure-port-cascade.test.mjs tests/integration/hub-singleton.test.mjs

55 tests passed
```

```text
node --test --test-force-exit tests/unit/multiplexer-resolution.test.mjs tests/unit/env-detect.test.mjs tests/unit/doctor-macos-hooks.test.mjs

14 tests passed
```

Likely coverage gaps:

- No test asserts that darwin `detectMultiplexer()` returns `"tmux"` when `getMultiplexerType()` resolves `tmux`.
- No test exercises `hasPsmux` alias misuse in `session.mjs`.
- No test verifies that `test-lock` kills or forwards signals to its child.
- No test verifies a max runtime for normal `npm test` outside release prepare.
- No test verifies stale hub process retirement across multiple ports or versions.
- Hub singleton tests likely validate "current target port is healthy" rather than "only one repo/user hub remains alive".

## Recommended Fix Plan

### P0: Stabilize local machine state after explicit cleanup approval

No cleanup was performed in this investigation. If cleanup is requested, handle it as a separate execution step because it kills live processes.

Candidate cleanup targets:

- Kill orphaned `node --test` PID `72215`.
- Retire stale `hub/server.mjs` processes that are not the active default hub.
- Review old detached tmux sessions before killing them, especially cross-project sessions.

### P1: Fix macOS multiplexer identity

Goal: darwin/Linux must report and use literal `tmux`, not `psmux`, unless a user override explicitly points somewhere else.

Implementation direction:

- Replace `session.mjs` `hasPsmux()` first check with a literal mux-type resolver.
- Use `getMultiplexerType()` or equivalent from `psmux.mjs`.
- Preserve Windows behavior: Windows primary remains `psmux`.
- On darwin/Linux, `detectMultiplexer()` should return `"tmux"` when tmux is available.
- `terminal-opener` should never emit `psmux attach-session` on darwin unless `PSMUX_BIN` is explicitly set to a real psmux-compatible binary and the detection type is intentionally `psmux`.

Regression tests:

- darwin + tmux available + psmux missing -> `detectMultiplexer() === "tmux"`.
- darwin terminal opener -> attach command contains `tmux attach-session`.
- Windows path remains psmux.
- Backward-compatible `hasPsmux` alias does not leak into literal mux identity.

### P2: Harden `scripts/test-lock.mjs` into a real supervisor

Goal: the wrapper must own the child test process lifetime.

Implementation direction:

- Add a default timeout to `test-lock`, preferably configurable via env.
- Forward `SIGINT`, `SIGTERM`, and `SIGHUP` to the child.
- On parent shutdown, kill the child and wait briefly.
- Consider spawning the child in a process group where platform behavior permits.
- Treat stale lock as a diagnostic signal; do not silently overwrite when the recorded process or child is still alive.
- Persist child PID in the lock file so cleanup can target the correct process.

Regression tests:

- Parent receives `SIGTERM` -> child receives termination.
- Child exceeds timeout -> wrapper exits non-zero and child is not left alive.
- Stale lock with live child -> fail with actionable diagnostic instead of overwrite.
- Stale lock with dead child -> cleanup and proceed.

### P3: Add hub stale-process diagnostics and bounded retirement

Goal: one intended hub per effective user/repo/default-port context, with explicit diagnostics when drift exists.

Implementation direction:

- Validate pid file against live process, port, version, and health endpoint.
- Detect stale `hub/server.mjs` processes for this repo/worktree.
- Add a safe doctor/report mode first.
- Add opt-in cleanup mode that kills only known stale hubs, never arbitrary node processes.
- Prevent random-port cascade from becoming long-lived source of truth.

Regression tests:

- Stale pid file does not mask active default hub.
- Multiple old hubs are reported.
- Cleanup excludes the active healthy hub.
- Different repo/worktree hubs are either isolated by policy or explicitly reported as cross-worktree.

### P4: Define tmux session cleanup policy

Goal: avoid unbounded detached team/session accumulation without surprising users.

Implementation direction:

- Keep default report-only behavior for external/destructive cleanup.
- Add `doctor` diagnostics showing detached session age, cwd, command, and estimated process tree memory.
- Add explicit cleanup command for known `tfx-*` sessions after an age threshold.
- Keep psmux-specific Windows cleanup separate from tmux macOS cleanup.

Regression tests:

- macOS cleanup path uses `tmux`, not `psmux`.
- Report-only path never kills sessions.
- Explicit cleanup refuses sessions outside configured prefix/scope.

## Acceptance Criteria

The issue should be considered fixed only when all claims below are true:

1. On macOS tmux-only hosts, `detectMultiplexer()` returns `"tmux"` and attach commands use `tmux attach-session`.
2. Normal `npm test` cannot leave an orphaned `node --test` process after parent termination or timeout.
3. `test-lock` stale handling distinguishes dead lock files from live stale test processes.
4. `tfx doctor` or an equivalent diagnostic reports stale hub clusters and stale tmux sessions with counts and memory estimates.
5. Hub startup does not leave multiple stale `hub/server.mjs` instances across routine session starts.
6. Regression tests cover darwin mux identity, test child cleanup, and stale hub detection.

## Current Severity

Severity: high for local development reliability.

Reason:

- The runaway `node --test` process has a roughly 30 GB physical footprint on a 16 GB machine.
- The process is orphaned and no longer controlled by the original test wrapper.
- Hub leakage is smaller but persistent and cumulative.
- macOS mux identity is wrong and can break cleanup/attach flows, making recovery harder.

## Final Classification

The RAM incident is primarily a process lifecycle design failure. The macOS-specific compatibility regression exists, but it is the tmux/psmux identity bug, not the high-memory root cause.

Short form:

```text
RAM root cause: test runner lifecycle design bug
Persistent process leak: hub detached lifecycle design bug
mac compatibility regression: tmux host misreported as psmux
secondary cleanup smell: old detached tmux sessions and zombies
```
