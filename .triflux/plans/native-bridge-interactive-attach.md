# PRD: native-bridge interactive attach

## 1. 문제 정의, 목표, 비목표

문제: Triflux native-bridge는 Claude Agents row를 만들 수 있지만, Codex 워커를 row에서 라이브 TUI로 보고 조작하는 경로가 없다. 현재 row 등록은 `kind: "bg"` projection을 생성하고 `bridgeSessionId`를 정규화하는 방식이다(`hub/team/claude-session-projection.mjs:33-49`). swarm local shard도 `registerSwarmShard()`를 통해 Claude daemon dispatch와 projection 생성을 수행한다(`hub/team/claude-native-bridge.mjs:290-303`, `hub/team/claude-native-bridge.mjs:364-401`). 그러나 이 row가 실제 Codex TUI PTY에 붙어 있지는 않다.

목표:

- local swarm shard 또는 headless worker 중 명시적으로 interactive 타입인 Codex 워커를 실제 TTY/PTY에서 실행한다.
- Claude Agents row attach 화면에 Codex TUI 출력을 계속 흘려보낸다.
- attach 화면에서 들어온 키 입력을 같은 Codex TUI stdin으로 라우팅한다.
- 기존 headless `codex exec` 기반 projection과 공존한다.
- 첫 구현 범위는 local shard로 제한한다. remote shard는 현재 local registration을 skip하는 계약이 이미 있다(`hub/team/claude-native-bridge.mjs:316-328`, `tests/unit/swarm-native-bridge-registration.test.mjs:115-140`).

비목표:

- Codex CLI 내부에 새로운 native injection API를 만드는 일은 범위 밖이다.
- Claude private UDS 필드에 제품 경로를 강결합하지 않는다. 기존 live bridge 계획도 private `messagingSocketPath` 의존을 런타임 경로로 쓰지 말라고 기록한다(`docs/superpowers/plans/2026-05-26-triflux-live-tui-bridge.md:620-631`).
- 기존 headless worker 출력 수집, result file, sentinel completion 로직을 재설계하지 않는다.
- remote shard interactive attach는 이번 PRD의 구현 대상이 아니다.

사용자 제공 전제:

- `20260521-145106-native-bridge-default-expansion-pr-323.md`는 D항목(attach 풀 인터랙티브)과 E항목(codex/agy 자체 TUI 통합)을 defer했다.
- 당시 "codex는 surface 부재라 사실상 불가"라고 봤지만, 이후 `codex-live`/`tfx-live`의 tmux PTY PoC가 Codex interactive surface를 제공할 수 있음을 증명했다.

## 2. 현재 상태

### row/projection은 이미 있다

- `buildClaudeSessionProjection()`은 Claude Agents가 배경 row로 볼 수 있는 shape를 만든다: `kind: "bg"`, `entrypoint: "cli"`, `agent`, `jobId`, `bridgeSessionId`를 포함한다(`hub/team/claude-session-projection.mjs:33-49`).
- `writeClaudeSessionProjection()`은 projection을 `sessionsDir/<pid>.json`으로 쓴다(`hub/team/claude-session-projection.mjs:52-58`).
- headless daemon mode는 daemon job pid를 기다린 뒤 `agent: resolvedCli || "codex"`로 projection을 생성한다(`hub/team/headless.mjs:992-1009`).
- projection 테스트는 `kind: "bg"`와 기본 `bridgeSessionId` shape를 고정한다(`tests/unit/claude-session-projection.test.mjs:13-42`).

### swarm local shard row 등록도 이미 있다

- swarm hypervisor는 `nativeBridge`가 켜진 경우 `registerSwarmShard()`를 호출하고, parent project cwd를 `cwd`로 넘긴다(`hub/team/swarm-hypervisor.mjs:591-613`).
- 같은 shard의 실제 실행 `sessionConfig.workdir`은 shard worktree로 설정된다(`hub/team/swarm-hypervisor.mjs:643-666`, `hub/team/swarm-hypervisor.mjs:750-760`).
- 테스트는 row 등록 cwd가 parent cwd이고 conductor workdir이 shard worktree임을 고정한다(`tests/unit/swarm-hypervisor.test.mjs:574-625`).
- local shard row display name은 `Triflux swarm <run> <ordinal> <agent> <shard>` 형식이다(`hub/team/claude-native-bridge.mjs:255-275`, `tests/unit/swarm-native-bridge-registration.test.mjs:50-103`).

### 현재 PTY frame은 출력 중심이다

- `buildPtyDataFrame()`은 kind `0`으로 raw bytes를 감싼다(`hub/team/claude-native-bridge.mjs:65-72`).
- `buildPtyControlFrame()`은 kind `1`로 JSON control payload를 감싼다(`hub/team/claude-native-bridge.mjs:74-81`).
- `extractPtyFrames()`는 kind `0`과 `1`만 해석하고 다른 kind는 에러 처리한다(`hub/team/claude-native-bridge.mjs:83-101`).
- `startNativeWorkerFacade()`는 `ptySockets` set을 만들고 attach socket에 `hello`, transcript, `live` control frame을 쓴다(`hub/team/claude-native-bridge.mjs:494-513`, `hub/team/claude-native-bridge.mjs:556-563`).
- 현재 `broadcastPty()`는 `ptySockets`에 frame을 write만 한다(`hub/team/claude-native-bridge.mjs:511-513`).
- 현재 attach socket에서 들어오는 PTY data frame은 worker stdin이 아니라 `appendOutput()`으로 다시 output transcript에 추가된다(`hub/team/claude-native-bridge.mjs:563-577`). control frame은 `resize`에 `live`를 응답하고 `kill`에 exit를 보낸다(`hub/team/claude-native-bridge.mjs:577-590`).
- 따라서 현재 path는 "attach socket -> worker PTY stdin" 라우팅이 없다. 사용자 제공 전제에 따르면 product code 안의 `messagingSocketPath`, `rv8`, `ov8` 식별자는 grep 0건이다. 현재 `hub/bridge.mjs`의 command switch도 `daemon-probe`와 `daemon-attach`를 노출하지 않는다(`hub/bridge.mjs:1266-1333`).

### 현재 worker launch는 headless 또는 placeholder다

- `buildNativeWorkerRosterEntry()`는 roster에 `rendezvousSock`, `ptySock`을 요구하지만 dispatch launch는 `{ mode: "prompt", args: ["--", prompt || name] }`로 고정된다(`hub/team/claude-native-bridge.mjs:427-463`).
- `startClaudeNativeBridge()`는 실제 Codex worker가 아니라 sentinel node process를 띄우고, facade socket을 만든 뒤 progress snapshot을 PTY output처럼 쓴다(`hub/team/claude-native-bridge.mjs:675-710`, `hub/team/claude-native-bridge.mjs:731-761`).
- swarm shard bridge command는 banner를 출력한 뒤 sleep loop만 돈다(`hub/team/claude-native-bridge.mjs:229-232`).
- headless Codex command builder는 `codex exec`를 기본으로 만든다(`hub/cli-adapter-base.mjs:147-213`). execution-mode도 headless Codex argv에 `exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never`를 넣는다(`hub/team/execution-mode.mjs:149-180`).
- `runHeadless()`의 `nativeBridgeMode === "agents"` 경로는 `dispatchDaemonBatch()`로 daemon batch를 실행한다(`hub/team/headless.mjs:1588-1618`).

### live Codex TUI PoC는 있다

- machine-local `codex-live` skill은 tmux 안의 live Codex TUI를 `start/ask/stop`으로 구동하고 `tmux send-keys`와 `capture-pane`를 쓴다고 명시한다(`/Users/tellang/.claude/skills/codex-live/SKILL.md:6-18`, `/Users/tellang/.claude/skills/codex-live/SKILL.md:71-87`).
- `codex-live` driver는 local/SSH tmux 명령을 구성한다(`/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:143-178`).
- driver는 Codex adapter에 bare `codex` launch key를 둔다(`/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:509-529`).
- driver의 `doStart()`는 detached tmux session을 만들고 launch key를 전송한다(`/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:709-733`).
- driver의 `doAskViaTmux()`는 prompt를 `send-keys`, 지연, 별도 Enter로 넣고, visible/capture output에서 완료와 응답을 판정한다(`/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:735-786`).
- interview artifact는 m2에서 `PONG-4242` round trip이 검증됐다고 기록한다(`/Users/tellang/Projects/.tfx/plans/interview-codex-live-bridge-20260526.md:23-33`).
- user-local `tfx-live` skill은 Triflux-owned live bridge로 tmux TUI control과 daemon UDS attach를 지원한다고 설명한다(`/Users/tellang/.claude/skills/tfx-live/SKILL.md:13-24`).

## 3. 설계 A: interactive Codex launch mode

### 권장안: tfx-live 계열 tmux PTY transport를 native-bridge worker facade에 붙인다

추천 구현은 "tmux PTY 재사용"이다. 새 worker type을 `interactive`로 두고, interactive Codex는 shard worktree에서 bare `codex` TUI를 detached tmux session으로 띄운다. 이 transport의 output은 native-bridge `ptySock`에 `buildPtyDataFrame()`으로 흘리고, input은 새 messaging socket을 통해 tmux `send-keys` 또는 raw-key adapter로 보낸다.

이유:

- Codex interactive TUI가 tmux에서 실제로 동작한다는 근거가 있다(`/Users/tellang/.claude/skills/codex-live/SKILL.md:8-12`, `/Users/tellang/Projects/.tfx/plans/interview-codex-live-bridge-20260526.md:31-37`).
- 현재 package dependency에는 `node-pty`가 없고 새 native dependency를 넣으면 install/build blast radius가 커진다(`package.json:79-88`).
- 기존 `codex-live`는 startup prompt 처리, trust prompt 처리, update prompt skip, send-keys 2단계, output extraction 경험을 이미 갖고 있다(`/Users/tellang/.claude/skills/codex-live/SKILL.md:71-87`).
- Claude private UDS 기반 product path는 기존 live bridge 계획에서 명시적으로 배제됐다(`docs/superpowers/plans/2026-05-26-triflux-live-tui-bridge.md:620-631`).

### 옵션 비교

| 옵션 | 장점 | 단점 | 판정 |
|---|---|---|---|
| tfx-live tmux PTY 재사용 | 검증된 Codex TUI surface. 새 native dependency 없음. local/SSH 확장 경험 있음. | raw byte PTY보다는 key mapping이 필요. `capture-pane`만 쓰면 live frame 품질이 낮음. | 채택 |
| node-pty 직접 spawn | stdout/stdin/resize fidelity가 가장 좋음. Claude attach PTY 모델과 잘 맞음. | 현재 dependency 없음(`package.json:79-88`). native module install 리스크. remote story 별도 필요. | 후순위 |
| 기존 daemon PTY proxy 확장 | Claude row/daemon 모델과 이름이 맞음. | 현재 `claude-daemon-control.mjs`는 control request, dispatch payload, kill helper 중심이고 PTY proxy API가 없다(`hub/team/claude-daemon-control.mjs:43-130`, `hub/team/claude-daemon-control.mjs:221-260`). `hub/bridge.mjs`도 `daemon-probe`/`daemon-attach` command를 노출하지 않는다(`hub/bridge.mjs:1266-1333`). | 이번 PRD에서는 주 transport로 쓰지 않음 |

### worker type 분기

명시적 분기를 추가한다.

- `workerType: "headless"`: 기존 `dispatchDaemonBatch()`, `startClaudeNativeBridge()`, `registerSwarmShard()` 경로를 유지한다. 이 경로는 `codex exec` 또는 daemon exec payload를 쓴다(`hub/team/headless.mjs:973-985`, `hub/team/claude-daemon-control.mjs:95-130`).
- `workerType: "interactive"`: 새 `startInteractiveNativeWorker()` 경로를 탄다. 이 경로는 shard worktree에서 tmux Codex TUI를 시작하고, native-bridge row는 같은 worker의 output/input socket으로 연결한다.

분기 기준:

- swarm shard: `nativeBridgeInteractive === true` 또는 shard metadata `interactive: true`일 때만 interactive. 기본은 기존 headless row 등록 유지.
- headless team: `--native-bridge-mode interactive-attach` 같은 명시 flag에서만 interactive. 기존 `agents`, `roster`, `claude-wrapper reserved` 의미는 바꾸지 않는다(`hub/team/headless.mjs:1422-1455`, `hub/team/headless.mjs:1588-1618`).
- provider: 1차는 `cli === "codex"`만 허용한다. Claude interactive는 `claude-live`/`tfx-live` 별도 경로가 이미 있으므로 이 PRD의 product target이 아니다(`/Users/tellang/.claude/skills/tfx-live/SKILL.md:26-59`).

### launch 세부안

1. `registerInteractiveSwarmShard()` 또는 `startInteractiveNativeWorker()`가 `short`, `sessionId`, `displayName`, `workerCwd`를 만든다.
2. `workerCwd`는 shard worktree다. row display/projection cwd는 현재 테스트와 같이 parent project cwd를 유지해도 된다(`tests/unit/swarm-hypervisor.test.mjs:604-614`). 단, launch cwd는 실제 shard worktree여야 한다.
3. tmux session 이름은 `tfx-int-${short}`처럼 short 기반으로 충돌을 줄인다.
4. launch command는 bare `codex`를 기본으로 한다. profile/env는 기존 AccountBroker lease에서 받은 `CODEX_HOME`/env를 적용하되, projection이나 public snapshot에는 노출하지 않는다.
5. output stream은 가능하면 `tmux pipe-pane` 기반으로 live bytes를 받고, 첫 구현에서 어렵다면 `capture-pane -e` polling을 100-250ms 주기로 시작한다. `codex-live`가 현재 `capture-pane`으로 응답을 회수한다는 근거는 있다(`/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:382-391`, `/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:771-785`).
6. startup prompt 처리는 `codex-live`의 trust/update prompt 처리 규칙을 포팅한다(`/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:428-479`, `/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:553-611`).

## 4. 설계 B: 양방향 attach protocol

### 원칙

기존 `ptySock`은 output/control compatibility channel로 유지한다. input은 새 `messagingSocketPath`로 받는다. 이유는 기존 `extractPtyFrames()`가 kind `0` data frame을 output data로 해석하고, 현재 inbound data frame도 `appendOutput()`에 넣기 때문이다(`hub/team/claude-native-bridge.mjs:83-101`, `hub/team/claude-native-bridge.mjs:563-577`). 기존 kind 의미를 바꾸면 현재 `native-bridge-tui` 회귀가 날 수 있다(`tests/unit/native-bridge-tui.test.mjs:196-224`).

### roster 확장

product `buildNativeWorkerRosterEntry()`에 `messagingSock` 또는 `messagingSocketPath`를 추가한다. 실험 코드에는 `messagingSock`이 roster entry에 들어갈 수 있는 shape가 이미 있다(`experiments/native-bridge-feasibility/claude-native-worker-protocol.mjs:185-197`, `tests/unit/claude-native-worker-protocol.test.mjs:106-125`). product code는 현재 `rendezvousSock`과 `ptySock`만 요구한다(`hub/team/claude-native-bridge.mjs:427-445`).

권장 field 이름:

- `messagingSocketPath`: 새 product-facing 이름.
- `messagingSock`: Claude daemon compatibility alias가 필요하면 같이 쓴다.

### frame helpers

가정: `rv8()`/`ov8()`는 8-byte unsigned big-endian length prefix와 UTF-8 JSON payload를 읽고 쓰는 helper다. 이 이름은 현재 product code에 없으므로 새 helper는 작은 순수 함수로 둔다.

권장 schema:

```json
{
  "proto": 1,
  "channel": "pty",
  "kind": "input",
  "short": "feedface",
  "seq": 42,
  "auth": "<capability-token>",
  "encoding": "base64",
  "data": "..."
}
```

frame 종류:

| kind | 방향 | payload | 처리 |
|---|---|---|---|
| `data` | worker -> attach | PTY stdout bytes | 기존 `buildPtyDataFrame()`로 `ptySock`에 계속 송신 |
| `control` | 양방향 | `hello`, `live`, `resize`, `kill`, `exit`, `error` | 기존 `buildPtyControlFrame()`와 호환. messaging에서는 JSON frame으로도 수용 |
| `input` | attach -> worker | base64 bytes 또는 named key | interactive worker stdin으로 라우팅 |

### 라우팅 흐름

1. Claude Agents가 row attach를 열면 기존처럼 `ptySock`에서 output/control frame을 읽는다.
2. attach side key 입력은 `messagingSocketPath`로 `kind: "input"` JSON frame을 보낸다.
3. `startInteractiveNativeWorker()`의 messaging server가 `rv8()`로 frame을 읽는다.
4. frame auth, proto, kind, size, seq를 검증한다.
5. `kind: "input"`이면 tmux transport에 write한다.
6. tmux transport는 printable text는 `send-keys -l -- <text>`, Enter/Backspace/Arrow/Esc/Ctrl-C 같은 control key는 tmux key name mapping으로 보낸다.
7. transport output은 `appendOutput()`을 거쳐 transcript를 trim하고 `broadcastPty(buildPtyDataFrame(payload))`로 attach socket에 송신한다(`hub/team/claude-native-bridge.mjs:514-518`).
8. `resize` control은 transport resize API로 전달하고, 기존 `live` ack도 보낸다.
9. `kill` control은 tmux session stop, broker release, facade close 순서로 처리한다.

### 최소 변경 경로

- `buildPtyDataFrame()`, `buildPtyControlFrame()`, `extractPtyFrames()`는 그대로 둔다.
- 새 helper `buildMessagingFrame()`/`readMessagingFrames()` 또는 `rv8()`/`ov8()`만 추가한다.
- `startNativeWorkerFacade()`에 `messagingSock`, `onInput`, `onResize`, `onKill` callback을 추가한다.
- 기존 `ptyServer` inbound `kind: 0` 동작은 headless/roster compatibility를 위해 유지하되, interactive worker에서는 input을 `messagingSock`으로만 받는다.
- `broadcastPty()`는 이름은 유지하고 역할을 "output broadcast"로 문서화한다.

## 5. 워크트리와 원격 통합

결정: 이번 PRD 범위는 local shard만 다룬다.

근거:

- `registerSwarmShard()`는 host가 local이 아니면 warning 후 local registration을 skip한다(`hub/team/claude-native-bridge.mjs:316-328`).
- 테스트도 remote shard가 local dispatch를 하지 않고 skip되는 것을 고정한다(`tests/unit/swarm-native-bridge-registration.test.mjs:115-140`).
- swarm hypervisor는 remote shard를 probe하고 remote worktree를 만드는 별도 경로를 이미 갖고 있다(`hub/team/swarm-hypervisor.mjs:695-731`, `hub/team/swarm-hypervisor.mjs:750-760`).
- remote interactive attach까지 이번에 넣으면 remote daemon registration, remote socket forwarding, tmux key quoting, account auth propagation이 한 번에 섞인다.

local 통합 규칙:

- row registration host는 `"local"`일 때만 생성한다.
- launch cwd는 shard worktree다.
- row display/projection cwd는 기존 parent cwd behavior를 유지한다. 현재 test가 이 contract를 고정한다(`tests/unit/swarm-hypervisor.test.mjs:604-614`).
- worktree cleanup 전에 interactive tmux session과 sockets를 닫는다. 현재 worker entry는 `nativeBridgeRegistration`을 들고 close를 호출하는 경로가 있다(`hub/team/swarm-hypervisor.mjs:809-817`, `hub/team/swarm-hypervisor.mjs:831-838`).

remote 확장 조건:

- remote host에서 같은 `registerInteractiveSwarmShard()`를 실행해 remote Claude daemon에 row를 등록한다.
- remote attach socket을 local Claude Agents에서 볼 방법이 필요하다. 없으면 remote row는 remote Claude Agents에서만 보인다.
- remote tmux transport의 quoting은 `codex-live`가 가진 SSH/tmux command builder를 재사용한다(`/Users/tellang/.claude/skills/codex-live/scripts/codex-live.mjs:143-178`).

## 6. 보안

위험:

- attach input은 임의 keystroke injection이다. Codex TUI에서 shell command, tool approval, destructive prompt가 실행될 수 있다.
- socket path를 아는 같은 user process가 input frame을 보낼 수 있다.
- frame payload를 로그로 남기면 prompts, secrets, auth material이 노출될 수 있다.
- interactive Codex가 AccountBroker auth lease를 쓸 경우 `authFile`, `CODEX_HOME`, env가 projection 또는 public snapshot으로 새면 안 된다.

현재 관련 근거:

- AccountBroker lease는 `authFile`, `env`, `profile`을 반환할 수 있다(`hub/account-broker.mjs:973-982`).
- Codex adapter는 lease `authFile`의 dirname을 `CODEX_HOME`으로 쓰고 lease env를 spawn env에 병합한다(`hub/codex-adapter.mjs:158-195`).
- AccountBroker `publicSnapshot()`은 id/provider/tier/busy/cooldown/remaining/circuit/failure count만 내보내고 env/authFile/path는 내보내지 않는다(`hub/account-broker.mjs:1073-1090`).
- active lease snapshot도 id/provider/busy/timestamps/circuit state만 낸다(`hub/account-broker.mjs:1092-1106`).
- lease는 30분 TTL pruning이 있다(`hub/account-broker.mjs:68`, `hub/account-broker.mjs:827-839`).

보안 요구사항:

- socket directory는 `0700`으로 생성한다. 현재 `startNativeWorkerFacade()`는 socket parent directory를 recursive mkdir하지만 mode를 지정하지 않는다(`hub/team/claude-native-bridge.mjs:489-490`).
- `messagingSocketPath`에는 random capability token을 별도로 요구한다. token은 projection, roster public fields, event log에 쓰지 않는다.
- input frame은 최대 크기 제한을 둔다. 권장값은 64 KiB 이하.
- `kind`, `proto`, `encoding`, `seq`를 검증한다. unknown kind는 close한다.
- input payload는 event log에 원문 저장하지 않는다. bytes length와 frame kind만 기록한다.
- `resize`는 cols/rows positive integer만 허용한다.
- `kill`은 해당 short/session의 worker만 종료한다.
- interactive lease는 start 시 acquire, stop/kill/exit 시 release한다. 30분 넘는 live session을 허용하려면 lease renewal 또는 explicit long-lived lease 상태가 필요하다.

## 7. packages/ 3-layer mirror 영향

현재 package assembly 근거:

- root `package.json`은 workspaces로 `packages/core`, `packages/remote`, `packages/triflux`를 둔다(`package.json:33-37`).
- `packCore()`는 `CORE_FILES`, `CORE_DIRS`, `scripts/lib`, `hooks`, `hud`를 `packages/core`로 copy한다(`scripts/pack.mjs:23-66`, `scripts/pack.mjs:252-263`).
- `packRemote()`는 `REMOTE_FILES`, `REMOTE_DIRS`, `scripts/lib`를 `packages/remote`로 copy하고 remote import를 `@triflux/core/...`로 rewrite한다(`scripts/pack.mjs:68-78`, `scripts/pack.mjs:141-180`, `scripts/pack.mjs:266-278`).
- `packTriflux()`는 `TRIFLUX_FILES`, `TRIFLUX_DIRS`를 `packages/triflux`로 copy한다(`scripts/pack.mjs:79-90`, `scripts/pack.mjs:281-304`).
- release mirror check는 `packages/triflux/<top>`이 root top-level과 byte-equal인지 검사한다(`scripts/release/check-packages-mirror.mjs:1-40`, `scripts/release/check-packages-mirror.mjs:60-110`).
- root package `files`는 `tests`를 포함하지 않는다(`package.json:16-31`). tests는 mirror 대상이 아니다.

변경 파일별 영향:

| 파일 | core | remote | triflux | 비고 |
|---|---|---|---|---|
| `hub/team/claude-native-bridge.mjs` | 해당 없음 | `packages/remote/hub/team/claude-native-bridge.mjs`, import rewrite 가능 | `packages/triflux/hub/team/claude-native-bridge.mjs`, byte-identical | `REMOTE_DIRS`가 `hub/team` 전체를 포함한다(`scripts/pack.mjs:77`). |
| `hub/team/claude-daemon-control.mjs` | 해당 없음 | `packages/remote/hub/team/claude-daemon-control.mjs`, import rewrite 가능 | `packages/triflux/hub/team/claude-daemon-control.mjs`, byte-identical | native bridge helper이므로 remote package에도 필요. |
| `hub/team/headless.mjs` | 해당 없음 | `packages/remote/hub/team/headless.mjs`, import rewrite 가능 | `packages/triflux/hub/team/headless.mjs`, byte-identical | headless/interactive worker type 분기. |
| `hub/team/swarm-hypervisor.mjs` | 해당 없음 | `packages/remote/hub/team/swarm-hypervisor.mjs`, import rewrite 가능 | `packages/triflux/hub/team/swarm-hypervisor.mjs`, byte-identical | swarm local shard registration 분기. |
| `hub/team/interactive-tui-transport.mjs` 신규 | 해당 없음 | `packages/remote/hub/team/interactive-tui-transport.mjs`, import rewrite 가능 | `packages/triflux/hub/team/interactive-tui-transport.mjs`, byte-identical | 새 transport. `hub/team` 아래에 두면 remote/triflux에 포함된다. |
| `hub/bridge.mjs` | `packages/core/hub/bridge.mjs`, byte-identical cp | 직접 파일 없음. remote에서 필요 시 `@triflux/core/bridge.mjs` import | `packages/triflux/hub/bridge.mjs`, byte-identical | `daemon-probe`/`daemon-attach`를 추가한다면 core와 triflux mirror 영향. |
| `scripts/tfx-live.mjs` 또는 `bin/tfx-live.mjs` | 해당 없음 | 해당 없음 | `packages/triflux/scripts/...`, `packages/triflux/bin/...`, byte-identical | productized tfx-live를 함께 넣을 때만. |
| `tests/unit/*.test.mjs` | mirror 제외 | mirror 제외 | mirror 제외 | `package.json` files와 mirror tops에 tests가 없다(`package.json:16-31`, `scripts/release/check-packages-mirror.mjs:25-34`). |

## 8. 테스트 계획

단위 테스트:

- frame codec: 기존 kind `0`/`1` round trip 유지(`tests/unit/claude-native-worker-protocol.test.mjs:47-83`) + 새 `rv8()`/`ov8()` partial frame, oversize frame, invalid JSON 테스트.
- roster shape: `buildNativeWorkerRosterEntry()`가 `messagingSocketPath`/`messagingSock`를 포함하고 기존 `rendezvousSock`/`ptySock`를 유지하는지 테스트.
- input routing: fake messaging socket에 `kind: "input"` frame을 보내면 fake transport stdin sink에 bytes가 도착하는지 테스트.
- control routing: resize/kill frame이 transport resize/stop callback으로 가고 기존 `ptySock` `resize`/`kill` behavior가 깨지지 않는지 테스트.
- worker type branch: `workerType: "headless"`는 기존 `launch.mode === "prompt"`/daemon exec behavior를 유지하고, `workerType: "interactive"`만 tmux transport를 시작하는지 테스트. 현재 `native-bridge-tui`는 `dispatch.launch.mode`가 `"prompt"`임을 고정한다(`tests/unit/native-bridge-tui.test.mjs:155-194`).
- local/remote registration: remote shard skip 테스트 유지(`tests/unit/swarm-native-bridge-registration.test.mjs:115-140`).
- security: invalid auth token, missing auth, large payload, unknown kind는 stdin으로 전달되지 않는지 테스트.

통합 테스트:

- fake transport integration: interactive facade를 fake PTY transport로 시작한다. messaging input `"abc\n"`를 보내면 fake transport가 `"echo: abc"`를 output으로 내고, attach `ptySock` client가 data frame으로 읽는다.
- tmux local smoke: `TFX_INTERACTIVE_ATTACH_E2E=1`일 때만 실제 `codex`를 tmux에서 띄우고 attach input/output round trip을 검증한다. login과 model cost 때문에 기본 unit suite에는 넣지 않는다.
- regression suite: `node --test tests/unit/native-bridge-tui.test.mjs tests/unit/claude-session-projection.test.mjs tests/unit/swarm-native-bridge-registration.test.mjs`.
- packaging guard: 변경이 끝난 구현 PR에서는 `npm run release:check-mirror`와 `npm run release:check-sync`를 실행한다. scripts는 이 검증 entry를 이미 제공한다(`package.json:60-63`).

## 9. 단계별 구현 계획

## Shard: frame-protocol
- agent: codex
- files: hub/team/claude-native-bridge.mjs, hub/team/claude-daemon-control.mjs, tests/unit/native-bridge-interactive-frame.test.mjs
- mcp:
- depends:
- critical: true
- prompt: |
    목표: 기존 PTY output frame 계약을 깨지 않고 messagingSocketPath 기반 input frame 프로토콜을 추가한다.
    작업:
    - rv8()/ov8() JSON frame helper를 추가한다.
    - startNativeWorkerFacade()에 messagingSock/messagingSocketPath와 onInput/onResize/onKill callback을 추가한다.
    - 기존 ptySock output/control behavior를 유지한다.
    - invalid auth, oversize, unknown kind, partial frame 테스트를 작성한다.
    lease 충돌: attach-routing shard도 claude-native-bridge.mjs를 만질 가능성이 높다. 이 shard가 먼저 merge되어야 한다.

## Shard: interactive-launch
- agent: codex
- files: hub/team/interactive-tui-transport.mjs, hub/team/claude-native-bridge.mjs, hub/team/headless.mjs, hub/team/swarm-hypervisor.mjs, tests/unit/native-bridge-interactive-launch.test.mjs
- mcp:
- depends: frame-protocol
- critical: true
- prompt: |
    목표: Codex interactive worker type을 추가하고 local shard worktree에서 tmux Codex TUI를 시작한다.
    작업:
    - tmux 기반 transport를 만든다. start/stop/write/resize/onData 인터페이스를 둔다.
    - codex-live의 launch/startup prompt 처리 규칙을 필요한 만큼 포팅한다.
    - workerType headless/interactive 분기를 명시적으로 추가한다.
    - swarm local shard는 worktree에서 launch하고 row display/projection은 기존 display contract를 유지한다.
    - AccountBroker lease env/authFile을 projection/roster public field에 노출하지 않는다.
    lease 충돌: frame-protocol과 claude-native-bridge.mjs 충돌 가능. frame-protocol 완료 후 진행.

## Shard: attach-routing
- agent: codex
- files: hub/team/claude-native-bridge.mjs, hub/team/claude-daemon-control.mjs, hub/bridge.mjs, tests/unit/native-bridge-interactive-attach.test.mjs
- mcp:
- depends: frame-protocol, interactive-launch
- critical: true
- prompt: |
    목표: attach input을 interactive worker stdin으로 라우팅하고 필요한 bridge verbs를 정리한다.
    작업:
    - messaging input frame을 transport.writeInput으로 연결한다.
    - resize/kill control frame을 transport resize/stop으로 연결한다.
    - hub/bridge.mjs에 daemon-probe/daemon-attach가 필요하면 추가하되, Codex interactive path를 private UDS에 강결합하지 않는다.
    - fake transport로 input->output 왕복 통합 테스트를 만든다.
    lease 충돌: claude-native-bridge.mjs 공통 변경이 많다. interactive-launch 이후에만 시작한다.

## Shard: tests-docs-mirror
- agent: codex
- files: tests/unit/native-bridge-tui.test.mjs, tests/unit/claude-session-projection.test.mjs, tests/unit/swarm-native-bridge-registration.test.mjs, packages/remote/hub/team/claude-native-bridge.mjs, packages/triflux/hub/team/claude-native-bridge.mjs, packages/core/hub/bridge.mjs, packages/triflux/hub/bridge.mjs
- mcp:
- depends: attach-routing
- critical: true
- prompt: |
    목표: 회귀 테스트와 package mirror를 맞춘다.
    작업:
    - 기존 native-bridge/projection/swarm registration 테스트를 유지하거나 필요한 assertion만 확장한다.
    - tests/는 package mirror 대상이 아님을 유지한다.
    - root 변경을 packages/triflux mirror와 packages/remote copy/import rewrite, packages/core bridge copy에 반영한다.
    - npm run release:check-mirror, npm run release:check-sync를 통과시킨다.
    lease 충돌: package mirror 파일은 구현 shard가 끝난 뒤 한 번에 반영한다. 구현 shard와 병렬로 mirror를 편집하지 않는다.

## 10. 리스크, open questions, E항목 재평가

리스크:

- raw TUI fidelity: tmux `capture-pane` polling은 완전한 raw PTY stream이 아니다. 첫 구현은 동작성을 우선하고, 실제 attach rendering 품질이 낮으면 node-pty 또는 tmux pipe-pane 전환을 별도 follow-up으로 둔다.
- key mapping: printable text는 쉽지만 Ctrl/Alt/arrow/function keys는 tmux key name mapping이 필요하다.
- Claude Agents private attach behavior: `messagingSocketPath`가 실제 attach input path인지, ptySock data frame으로 input이 오는지 live smoke로 재확인해야 한다. 사용자 제공 grep 전제상 관련 식별자는 아직 없고, 현재 command switch와 roster entry shape도 해당 input socket을 노출하지 않는다(`hub/bridge.mjs:1266-1333`, `hub/team/claude-native-bridge.mjs:427-463`).
- lease TTL: interactive session이 30분을 넘으면 현재 lease pruning과 충돌할 수 있다(`hub/account-broker.mjs:68`, `hub/account-broker.mjs:827-839`).
- startup prompt automation: `folder-trust` 자동 yes는 편하지만 민감 디렉터리에서는 위험하다. `codex-live`도 이 한계를 기록한다(`/Users/tellang/.claude/skills/codex-live/SKILL.md:79-84`).

open questions:

- Claude Agents row가 input socket field로 `messagingSock`, `messagingSocketPath`, 또는 다른 이름을 요구하는지 live session JSON으로 확정해야 한다.
- tmux transport output은 `capture-pane -e` polling으로 충분한가, 아니면 처음부터 `pipe-pane` 또는 node-pty가 필요한가.
- AccountBroker lease renewal을 native-bridge layer에 넣을지, Codex interactive session을 별도 single-account mode로 둘지 결정해야 한다.
- `daemon-probe`/`daemon-attach` bridge verbs는 이 feature의 필수 dependency인가, 아니면 `tfx-live --cli claude --transport uds` 전용 follow-up인가.

E항목 재평가 결론:

- "Codex 내부 injection surface가 없다"는 문장은 여전히 맞다. interview artifact도 Codex TUI에 native prompt injection API가 없고 tmux send-keys만 가능하다고 기록한다(`/Users/tellang/Projects/.tfx/plans/interview-codex-live-bridge-20260526.md:16-22`).
- 그러나 "Codex TUI 통합은 사실상 불가"라는 제품 결론은 뒤집힌다. tmux가 Codex interactive surface 공급원이 될 수 있고, m2 round trip도 검증됐다(`/Users/tellang/Projects/.tfx/plans/interview-codex-live-bridge-20260526.md:23-33`).
- 따라서 E항목은 "Codex private/native API 통합"이 아니라 "tmux PTY 기반 Codex TUI surface를 native-bridge attach row에 연결"로 재정의해 구현 가능하다.

## 검증 및 완료 조건

- 이 문서는 Codex가 작성했다. 동일 모델 self-approve는 금지한다.
- 구현 착수 전 Claude가 이 PRD를 교차 리뷰해야 한다.
- 구현 완료 판정은 다음 증거가 있어야 한다: frame unit tests 통과, fake transport input->output 왕복 통과, 기존 native bridge/projection/swarm registration 회귀 테스트 통과, package mirror/sync 검증 통과.
- 실제 Codex TUI E2E는 credential/model 비용이 있으므로 기본 suite에는 넣지 않고 opt-in smoke로 둔다.

## 11. 구현 잠금 — Smoke 검증 + PR #354 반영 (Claude 교차리뷰, 2026-05-27)

> 이 섹션이 §1-10의 stale 부분을 **supersede**한다. PRD 본문은 base `9e13afdd` 기준 작성됐고, 현재 worktree base는 `25bf41ab`(PR #354 `feat/daemon-attach-peer-return` 머지 후)다. 충돌 시 §11 우선.

### 11.1 입력 경로: B2 확정, B1 폐기

증거:
1. facade ptySock가 inbound kind-0 frame을 이미 수신 + 에코한다 (`hub/team/claude-native-bridge.mjs:564-576`). 이 로컬 에코 wiring 자체가 실제 Claude Agents attach 클라이언트가 키 입력을 kind-0 frame으로 facade에 써넣는다는 강한 정황이다.
2. Claude daemon `dispatch.messagingSock: ""` (2026-05-26 02:20Z·09:00Z 2회 동일, 출력 스트리밍은 정상). private messaging socket 입력 경로는 미제공.
3. 결정문서 `docs/superpowers/plans/2026-05-26-triflux-live-tui-bridge.md:619-631`: 입력=tmux send-keys, private UDS `messagingSocketPath` 의존 금지.

결론: **신규 messagingSocketPath/rv8/ov8 소켓·프로토콜을 추가하지 않는다.** interactive worker일 때만 facade `ptyServer` inbound kind-0 처리(576행)를 `appendOutput` 대신 interactive transport `writeInput`(tmux send-keys)로 분기. headless worker는 기존 echo 유지(native-bridge-tui 회귀 없음).

### 11.2 PR #354 반영 — 재사용 가능 인프라 (PRD "없음" 서술 정정)

- `hub/bridge.mjs:1520-1524`에 `daemon-probe`/`daemon-attach`/`daemon-interrupt` verb가 **이미 존재**한다. §2/§4/open-Q#4의 "daemon-probe/daemon-attach 없음"은 stale. 신규 추가 불필요 — 기존 verb 재사용/확장. `daemon-interrupt`(attach→PTY에 ESC→close)는 kill/abort 계약에 직접 활용.
- `bin/tfx-live.mjs`(48KB)가 main에 **productized**. codex-live를 machine-local skill에서 포팅할 필요 없음. tfx-live의 tmux PTY 구동(send-keys 입력 / capture-pane 또는 pipe-pane 출력)을 interactive transport로 재사용.
- 기존 tmux 코드 자산: `hub/team/{conductor,headless,session,pane,tui-viewer}.mjs`, `hub/team/psmux.mjs`. 신규 transport 작성 시 재사용 우선.

### 11.3 revised shard 계획 (B2 + 재사용)

- **frame-protocol**: workerType("headless"|"interactive") 분기 + 기존 `extractPtyFrames` kind-0 경로 재사용. rv8/ov8 신규 불필요 → 대폭 축소.
- **interactive-launch**: `bin/tfx-live.mjs` tmux transport를 재사용해 shard worktree에서 bare `codex` 인터랙티브를 띄움(포팅 아님, wiring). AccountBroker lease env/authFile은 projection/roster public field 비노출.
- **attach-routing**: facade inbound kind-0 → transport `writeInput` 라우팅. resize/kill control → transport + 기존 `daemon-interrupt` verb 재사용.
- **tests-docs-mirror**: 동일. packages/ 3-layer mirror + `npm run release:check-mirror`/`check-sync`.

### 11.4 load-bearing 잔여 불확실

실제 `claude agents` attach에서 사람 타이핑 시 kind-0가 facade에 도달하는지의 직접 관측은 미완(코드 정황 95% yes). interactive-launch/attach-routing shard의 fake-transport 단위 테스트 + opt-in tmux E2E로 구현 중 검증. 또는 probe facade row 1개로 사용자가 즉시 확인 가능.
