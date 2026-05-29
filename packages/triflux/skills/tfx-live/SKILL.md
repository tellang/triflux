---
name: tfx-live
description: >
  Use when Claude, Codex, or a Triflux worker needs live Claude↔Codex orchestration:
  start/ask/stop, multi-turn, peer relay, daemon UDS attach, or UDS-first with tmux fallback.
triggers:
  - tfx-live
  - claude-codex-live
  - codex-claude-live
argument-hint: "<start|ask|stop|probe|peer|converse|goal-driven> ..."
---

# tfx-live — Claude↔Codex live orchestration

`tfx-live` is the Triflux-owned live bridge for Claude Code and Codex TUI sessions.
It runs as a local CLI (`tfx-live`) and supports tmux TUI control plus Claude daemon UDS attach.

## Default transport

- Claude targets with `--short` or `--session-id`: **UDS-first `auto` by default**.
- If UDS probe/attach fails: write `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`, then tmux fallback when `--session` is provided.
- Codex targets and Claude targets without a daemon ref: tmux by default.
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
```

In `peer`, every hop sends the previous response as the next prompt to the opposite agent; the final JSON is only the transcript.

## Orchestrate (Claude UDS + Codex)

`orchestrate` exposes the `runUdsOrchestration` engine as a formal verb: Claude is driven over the daemon control socket (UDS) and Codex over a selectable transport, in one of three shapes.

```bash
# default: Codex over the stdio one-shot path (codex exec)
tfx-live orchestrate --task "이 변경의 위험을 한 줄로" --mode peer

# experimental: Codex over a real `codex app-server` WebSocket-over-UDS daemon
tfx-live orchestrate --task "이 변경의 위험을 한 줄로" \
  --mode codex-led --codex-transport app-server-uds --timeout 120
```

- `--mode` = `peer` (default) | `codex-led` | `claude-led`.
- `--codex-transport` = `exec` (default, `codex exec` stdio) | `app-server-uds` (experimental).
  - `app-server-uds` spawns a private `codex app-server --listen unix://<tmp>`, attaches over WebSocket-over-UDS (RFC 6455, masked client frames), runs `initialize`→`thread/start`→`turn/start`, and resolves on `turn/completed`. Transport proven against codex-cli 0.135.0 (see `experiments/native-bridge-feasibility/codex-app-server-uds-smoke.mjs`).
  - It is NOT the default — the existing `codex exec` path is unchanged.
- Requires a live Claude daemon (same as the UDS `ask` path) for the Claude side.

## Useful diagnostics

```bash
# Show CLI help
tfx-live --help

# Probe daemon sessions through Triflux bridge
tfx-live probe
```

If auto falls back, inspect `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json` (override with `$TFX_LIVE_BUG_REPORT_DIR` for tests).
