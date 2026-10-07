---
name: tfx-live
description: >
  Use when Claude, Codex, or a Triflux worker needs live Claude↔Codex orchestration:
  start/ask/compact/stop, multi-turn, peer relay, daemon UDS attach, or UDS-first with tmux fallback.
argument-hint: "<start|ask|wait|compact|stop|interrupt|probe|list-sessions|peer|converse|goal-driven|orchestrate> ..."
---
## Codex host contract

Invoke this skill as `$tfx-live` in Codex. The CLI `--cli` flag selects the target session, not the current host.


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

Name every new Claude or Codex session as `<month>.<day> <topic>`, for example
`10.8 오케스트레이션 개선`. Pass `start --name "10.8 오케스트레이션 개선"` or let
`start` generate `<month>.<day> <session>` and report `nameGenerated: true`.
For a successor, append ` 2`, then ` 3` to the existing name. Results include
`name`; if Codex TUI naming fails, `nameApplied: false` reports that outcome.
Rename a loaded Codex UDS thread with
`tfx-live rename --cli codex --transport uds --thread ID --name "<name>"`
and optionally `--codex-socket PATH|default`. The app-server call is
`thread/name/set` with `{ threadId, name }`; success returns `{}`.

`tfx-live --help`, `tfx-live <verb> --help`, and `-h` print usage and exit 0.

## 리드 운영

세션을 띄운 리드가 생성, 컨텍스트 관리, compact 지시, 종료를 책임진다.
작업 연속성과 소유권을 먼저 판단하고, 컨텍스트 비율은 개입 시점으로 쓴다.
`--resume`은 이전 컨텍스트를 가져오므로 재개 직후 compact 필요 여부를 확인한다.

### compact, clear, handoff, close 선택

| 동작 | 고르는 조건 | CLI별 실행 |
|------|-------------|-------------|
| compact | 같은 목표와 담당이 이어지고 파일과 git에서 상태를 복구할 수 있을 때 | Claude: `/compact <보존 지침>` 또는 `/rewind`의 Summarize from here. Codex: `/compact` 뒤 리드가 파일 경로와 검증 명령을 다시 전달한다. agy: 수동 명령이 없어 handoff한다. |
| clear | 무관한 작업으로 전환, 같은 문제를 두 번 넘게 고쳐도 실패, 스펙 완료 후 구현 착수, 작성자에서 리뷰어로 전환할 때. 넘길 미완료 상태가 없어야 한다. | Claude: `/rename` 뒤 `/clear`. Codex: `/new <이름>`이며 `/new`와 `/clear`는 진행 중인 작업이 끝나거나 중단된 뒤 쓴다. agy: `/clear` 또는 `/new`. |
| handoff | 담당, CLI, 모델, 소유자가 바뀌거나 긴 자율 작업이 창을 넘길 때. compact 뒤 다시 임계에 닿거나 아래 handoff 비율에 닿을 때 | 인계 파일을 작성하고 기존 이름에 ` 2`를 붙인 승계 세션을 시작한다. 인계 확인 뒤 소유권을 넘기고 이전 세션을 닫는다. |
| close | 결과를 받고 인계를 확인했을 때 | Claude 백그라운드: `claude stop <id>`, 세션 안 `/stop`, agent view Ctrl+X. Claude 팀원: shutdown. Codex 서브에이전트: `close_agent`. agy 서브에이전트: `/agents` 패널 K, TUI: `/exit`. |

두 번째 compact 전에는 handoff가 맞는지 먼저 점검한다. compact 횟수를 고정하지 않는다.
인계 파일에는 목표와 완료 조건, 체크아웃과 변경 상태, 확정 결정, 증거 경로,
PASS/FAIL/SKIP, 미완료 작업과 프로세스, 다음 행동과 소유자, `predecessorSessionId`를 적는다.
승계 세션이 인계 경로를 확인한 ACK를 받은 뒤 이전 세션을 닫는다.

### 공식 모델 창 대비 운영 비율

분모는 공식 모델 창이다. 실제 실행 한도가 더 작으면 그 아래에서 운영한다.
아래 비율은 공식 권고가 아닌 **[추론] 운영값**이다.

| CLI와 모델 | 공식 창 | 준비와 경고 | compact | 신규 배정 중지와 handoff | 전송 거부 |
|------------|---------|-------------|---------|-------------------------|-----------|
| Claude Code: Fable 5.1, Opus 5.5, Sonnet 5.5 | 1,000,000 | 60% | 75% | 85% | 90% |
| Codex: Sol 6.1, Astra 6, Terra 6, Luna 6 | 1,050,000 | 15% | 18% | 20% | 22% |
| agy: Gemini 3.8 Flash | 1,048,576 | 12% | 없음 | 15% | 18% |

Claude의 85%와 90% 사이 여유는 50,000토큰이므로 85%에 닿으면 즉시 handoff를 지시한다.
agy는 기존 tfx-live transport가 지원하지 않으므로 위 표는 운영 지침으로만 적용한다.

컨텍스트 결과는 `estimatedContextTokens`, `contextLimitTokens`,
`contextLimitSource`, `contextPct`를 담는다. `contextLimitTokens`는 공식 모델 창이며
`contextPct`는 추정 토큰을 공식 창으로 나눈 백분율이다. 모르는 모델은 한도와 비율을
`null`로 두고 경고만 한다. `probe`는 사용량이 없으면 `context: null`을 반환한다.
Claude 추정 토큰은 마지막 assistant usage의 `input_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens` 합이다.

전송 가드는 Claude와 Codex의 tmux/UDS 경로에서 토큰을 확인할 수 있을 때 적용한다.
`--warn-context-pct`와 `--max-context-pct`로 경고와 거부 비율을 덮어쓴다.
각각 0이면 해당 가드를 끈다. 기본값은 위 표의 경고와 전송 거부 열이며,
거부 결과는 `context-limit`과 컨텍스트 필드 네 개를 반환한다.

Codex 실행 한도는 공식 창과 별도로 관리한다. 카탈로그 창은 272,000,
실제 사용 창은 258,400(95%), 기본 자동 압축 계산값은 244,800(90%)이다.
실측 압축 발동 구간은 209k~235k이며 Terra 6의 동일 사양 여부는 미확인이다.
agy의 실측 예산 약 200,000은 필드 의미를 확인하지 못했다.
`model_context_window`와 `model_auto_compact_token_limit`은 올리지 않는다.
272K는 API의 짧은 문맥과 긴 문맥 가격 경계이며 넘으면 입력 단가가 2배,
출력 단가가 1.5배다. 창을 올려도 90% 자동 압축은 꺼지지 않는다.

### 수동 compact와 수명 관리

```bash
tfx-live compact --cli claude --session cl1 \
  --instructions "변경 파일, 확정 결정, 검증 명령을 보존하라" --timeout 120

tfx-live stop --cli claude --short <8hex>
tfx-live stop --cli claude --session-id <id>
tfx-live stop --session cl1
```

`compact`는 로컬 Claude tmux `--session`만 지원한다. `/compact <instructions>`를
중계 표식 없이 보내며 `--if-busy` 기본값은 `fail`이다. 바쁜 세션에는 보내지 않는다.
전송 뒤 transcript의 새 `compact_boundary`를 확인하면 `compacted: true`와
`compactMetadata`에서 읽은 `preTokens`, `postTokens`를 반환한다.
시간 안에 확인하지 못하면 `compacted: false, timedOut: true`다.
UDS 슬래시 명령 실행 근거가 없어 UDS compact는 보류한다.

`stop --short`와 `stop --session-id`는 `claude stop <id>`를 호출하고
`stopped: true, conversationKept: true`를 반환한다. 보존된 대화는 `claude attach`로 재개한다.
`stop --session`은 소유한 tmux 세션을 종료한다. 다른 소유자의 세션은 그 소유자가 정리한다.
Claude 백그라운드에서 `/exit`, `←`, Ctrl+Z는 연결만 끊으므로 종료로 취급하지 않는다.
완료된 Codex 서브에이전트도 `close_agent` 전까지 동시 실행 한도를 차지한다.
macOS의 `sysctl -n kern.memorystatus_vm_pressure_level`이 2 이상이면 새 세션을 띄우기 전에 정리한다.

원격 배정 전에는 `scripts/remote-spawn.mjs --probe` 결과의 `ready`와 `warnings`를 확인한다.
POSIX probe는 메모리 압박과 여유율, load average, 홈 디스크 여유, Node/Claude/Codex/agy와
triflux 버전, Codex 인증 파일 존재를 보고한다. 압박 4는 배정 불가이며, 압박 2,
디스크 5GiB 미만, 로컬과의 버전 차이는 경고다. PowerShell probe는 기존 동작을 유지한다.

### 요청 전송과 완료 확인

```bash
tfx-live ask --cli claude --transport uds --short <8hex> \
  --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli claude --short <8hex> --request-id <requestId> \
  --timeout 120 --poll-interval 500
```

`ask --no-wait`는 전송 후 `status: "submitted"`, `inputSent: true`, `done: false`,
`submittedAt`, `target`, `requestId`를 반환하며 `timedOut`은 넣지 않는다.
모든 ask 결과는 `requestId`를 담는다. ask, peer, converse, goal-driven은 기본적으로
`[tfx-live req=<requestId>]`를 프롬프트 앞에 붙인다. `--no-relay-tag`로 빼면
`wait --request-id`가 그 요청을 찾을 수 없다.

`wait`는 Claude transcript에서 요청 표식이 있는 user turn과 다음 user turn 전의 마지막
assistant 텍스트를 읽는다. `--request-id`가 없으면 최신 user turn을 확인한다.
daemon의 idle 상태만으로 완료를 판정하지 않는다. `status`는 `submitted`, `working`,
`completed`, `failed`, `unknown`이며 timeout은 `status: "working"`, `timedOut: true`,
`done: false`다. 결과는 컨텍스트 필드를 포함한다. Codex UDS `wait`는 지원하지 않는다.
Claude JSONL의 `end_turn`, `turn_duration` 완료 표식은 실측 근거이며 안정된 공식 스키마가 아니다.

직접 `tmux capture-pane`과 `tmux send-keys`를 쓸 때는 전송과 pane 상태 진단에 한정한다.
Claude pane에 `C-c`를 보내지 않는다. 자동화의 세션 탐색에는 `tmr ls --json`을 쓴다.
`tmr attach`는 사람용 선택기로, 터미널이 없으면 exit 1이다.

### 근거 (2026-10-08 확인)

- Claude: [모델 설정](https://code.claude.com/docs/en/model-config), [컨텍스트 창](https://platform.claude.com/docs/en/build-with-claude/context-windows), [운영 지침](https://code.claude.com/docs/en/best-practices), [명령](https://code.claude.com/docs/en/commands), [agent view](https://code.claude.com/docs/en/agent-view).
- Codex: [명령](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [설정](https://learn.chatgpt.com/docs/config-file/config-reference), [API 가격](https://developers.openai.com/api/docs/pricing). 실행 한도와 자동 압축 계산의 합의 근거는 Codex rust-v0.160.1이며 실측 구간은 공식 보장이 아니다.
- agy: [모델 목록](https://ai.google.dev/gemini-api/docs/models), [CLI](https://antigravity.google/docs/cli/reference), [agents](https://antigravity.google/docs/cli/commands/agents).

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

If a selected daemon directory is missing or its control socket returns
ENOENT before input is sent, `ask` and `probe` rediscover live daemons and
retry the requested short or session ID once. Results identify the old
endpoint in `recoveredFrom`. If delivery is uncertain, `ask` reports
`status: "unknown"` and does not resend.

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

### Claude discovery and Codex registry

`tfx-live list-sessions --cli claude [--cwd DIR]` lists local tmux sessions from
`~/.claude/sessions/*.json` (`TFX_CLAUDE_SESSIONS_DIR` overrides the directory).
It returns `session`, `target`, `paneId`, pane `cwd`, `pid`, `sessionId`, `short`,
`name`, `title`, `nameSource`, and `status` only for live PIDs matching the pane process
or a descendant within four levels. Claude discovery rejects `--remote` and
`--transport uds`; `--transport auto` uses local tmux, and `--cwd` matches the
pane cwd exactly.

`title` equals `name` unless `nameSource` is `derived` or the name is empty.
In those cases it uses the latest non-empty, trimmed `custom-title` or `ai-title`
from the last 262144 bytes of `~/.claude/projects/*/<sessionId>.jsonl`
(`TFX_CLAUDE_PROJECTS_DIR` overrides the projects directory). `customTitle`
takes precedence over `aiTitle` on the same line; no matching title yields null.

Codex SessionStart and UserPromptSubmit hooks atomically write `<pid>.json` to
`${XDG_STATE_HOME:-$HOME/.local/state}/triflux/codex-sessions`
(`TFX_CODEX_SESSION_REGISTRY_DIR` overrides it). Version 1 contains
`{ version: 1, writer: "triflux", pid, sessionId, cwd, tmux, tmuxPane, source,
startedAt, updatedAt }`: `tmux` is `<session>:@<window_id>.%<pane_id>` or null,
`tmuxPane` is `%<pane_id>` or null, `source` defaults to null, and timestamps
are milliseconds. `startedAt` stays unchanged for the same PID and thread.
Local Codex discovery adds `threadId` and `name` to matching entries in `panes`;
names come from `$CODEX_HOME/session_index.jsonl` (default `~/.codex`), and are
null when absent. Dead PID records are pruned after writes.
Records are written only when the Codex process is inside the hook's tmux pane, so TUIs attached to a shared app-server daemon (`daemon_auto_start`) are not recorded.

`ask` and tmux `interrupt` accept session names, `name:window`, and
`name:window.pane`. `start` and tmux `stop --session` require a session name only;
tmux `stop` rejects pane targets because it kills the entire session. `--remote HOST`
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
