# Codex App-server Same-thread Dual-client Gating Probe Plan

**Goal:** Decide whether one persistent JSON-RPC controller and one human Codex TUI can safely write to the same durable app-server thread.

**Architecture:** One Node process owns a private WebSocket-over-UDS app-server and controller client A. The same process creates only its own tmux session through `hub/team/psmux.mjs`, launches `codex resume <thread> --remote unix://<socket>`, injects TUI keystrokes, records controller events and pane snapshots, reads durable history, and cleans every owned resource in `finally`.

**Files:**

- Create `experiments/native-bridge-feasibility/codex-app-server-dual-client-gating-probe.test.mjs` for pure correlation and collision-policy tests.
- Create `experiments/native-bridge-feasibility/codex-app-server-dual-client-gating-probe.mjs` for the gated live probe and JSON report generation.
- Create `experiments/native-bridge-feasibility/codex-app-server-dual-client-gating-latest-report.json` from the live run.
- Create `experiments/native-bridge-feasibility/codex-app-server-dual-client-gating-report.md` from measured evidence only.

## Task 1: Lock pure evidence classification

- [ ] Write a Node test that imports the not-yet-existing probe helpers and asserts nonce-to-turn correlation plus `steer` / `queue` / `reject` classification.
- [ ] Run the test and confirm it fails because the probe module does not exist.
- [ ] Implement only the pure helpers needed for the test.
- [ ] Run the test and confirm it passes.

## Task 2: Implement the resource-owning live harness

- [ ] Spawn exactly one `codex app-server --listen unix://<private socket>` from Node and keep it alive for the whole experiment.
- [ ] Connect controller A with the existing `JsonRpcWsUdsClient`, capture notifications and server requests, initialize, and start one non-ephemeral read-only/on-request thread.
- [ ] Create one uniquely named tmux session through `createPsmuxSession`, launch `codex resume <thread> --remote unix://<socket>`, and capture readiness evidence.
- [ ] Add scoped action/event/pane/history evidence recording with thread id, turn id, and client user-message id or explicit null.
- [ ] In `finally`, close A, kill only the owned tmux session, terminate only the spawned app-server, and remove only the private temp directory.

## Task 3: Execute the six required gates

- [ ] Verify P1 program input in both TUI capture and `thread/read` history.
- [ ] Verify H1 TUI input in A's same-thread `turn/started`, item, and `turn/completed` stream plus history.
- [ ] Interrupt a TUI-originated long turn through A's `turn/interrupt`.
- [ ] Interrupt an A-originated long turn by sending TUI Escape.
- [ ] Run two near-simultaneous submissions and compare the observed collision policy.
- [ ] Trigger an on-request approval without authorizing mutation; record whether A and/or TUI receives it, then decline or interrupt it.
- [ ] Detach the TUI, run an A turn, re-attach, verify history catch-up, submit one TUI turn, and detect duplicate/missing events or inputs.

## Task 4: Verify and report

- [ ] Run the targeted pure test and `node --check` for the new script only.
- [ ] Run the gated live probe and inspect the JSON report, stderr tail, cleanup evidence, and residual process/session checks.
- [ ] Classify every required gate as confirmed, disproved, or unconfirmed, cite concrete ids/nonces/events, and give exactly one final feasibility verdict.
- [ ] Confirm git status shows no tracked-file changes caused by this task and no git operation was performed.

Git add/commit/checkout/reset/stash and repository-wide lint/format are intentionally excluded by the task contract.
