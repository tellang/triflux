---
name: tfx-lead
description: >
  여러 Claude, Codex 세션이나 워커를 띄워 지휘하는 리드 역할을 맡을 때,
  세션 승계, 컨텍스트 관리, 교차 리뷰, 머지, 릴리스 조율을 할 때 사용한다.
---

# tfx-lead

## 목적

여러 Claude, Codex 세션을 지휘하는 리드 세션의 일상 운영 절차다. 리드가 Claude 든 Codex 든 같은 절차를 따르고, 수단만 아래 표로 갈린다.
세션을 띄우고 보내고 기다리고 compact 하고 닫는 명령의 상세와 컨텍스트 비율 표는 `tfx-live` 스킬이 정본이다. 여기서는 복제하지 않는다.
근거는 ADR-0027(Codex queue), ADR-0029(리드 운영), ADR-0030(테스트 격리)과 `.claude/rules/tfx-routing.md`의 "모델 배치" 표다.

## 리드 CLI 별 수단

| 동작 | Claude 리드 | Codex 리드 |
| --- | --- | --- |
| 세션 띄우기, 보내기, 기다리기, compact, 닫기 | `tfx-live` 명령 (공통) | `tfx-live` 명령 (공통) |
| 같은 세션 안 서브에이전트 | Agent 도구 (`model`, `effort`, `run_in_background`) | `spawn_agent`, 추가 지시는 `followup_task`. `close_agent`가 있으면 끝나면 반드시 닫는다 |
| Claude 세션에 보내기 | 로컬 Claude끼리는(팀원 포함) `SendMessage(to: "<이름>")`. 이름은 `tfx-live list-sessions --cli claude`의 `name`, 첫 지시는 `start` 결과의 `sendMessageTo`. 이름을 못 찾으면 전송 실패로 두고 다시 찾는다. 원격은 `tfx-live ask --cli claude` | 로컬은 `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'claude:<정확한 이름>' --message '<본문>'`. 원격은 `tfx-live ask --cli claude` |
| Codex 세션에 보내기 | 로컬은 `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'codex:<정확한 이름>' --message '<본문>'`. 원격은 `tfx-live ask --cli codex` | 로컬은 `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'codex:<정확한 이름>' --message '<본문>'`. 원격은 `tfx-live ask --cli codex` |
| agy 세션에 보내기 | `tfx-live send --to agy:<이름> --message <본문> --no-wait` 또는 `tfx-live ask --cli agy`. 같은 기기의 agy 끼리는 `~/.local/bin/agy.patch.json`의 `sha256`이 실제 `agy` 바이너리 해시와 같고 `patches`에 `peer-wake`가 있을 때만 `send_message`(대화 ID)를 쓰고, 아니면 `tfx-live ask`를 쓴다(쉬는 세션이 깨지 않는 공개 이슈 #1022 때문). `tfx-live send`의 agy 대상 전송은 tmux 경로를 유지한다 | `tfx-live send --to agy:<이름> --message <본문> --no-wait` 또는 `tfx-live ask --cli agy` |
| 사용자에게 묻기 | `AskUserQuestion` | 답변에서 짧은 선택지로 묻는다 |
| 배경 대기 | `run_in_background`와 완료 알림 | 백그라운드 셸 또는 `tfx-live wait`(아래 5절의 지원 범위 안에서) |

- 로컬 Claude·Codex 대상은 어댑터가 설치되어 있다고 전제하고 native 피어를 먼저 쓴다. native 실패는 그대로 반환하며 tmux 입력이나 미설치 폴백으로 넘기지 않는다. `tfx-live send`는 agy 대상에만 쓴다.
- `<홈 절대경로>/.claude/scripts/tfx-peer`는 setup이 승인한 실제 절대경로로 바꿔 실행한다. 본문은 8000자까지이며 긴 본문은 파일 경로로 보낸다. Windows는 Claude 대상 전달만 지원하고 자동 승인용 래퍼나 Codex 규칙을 설치하지 않는다. PowerShell에서 `node "$env:APPDATA\npm\node_modules\triflux\bin\tfx-peer.mjs" send --to 'claude:<이름>' --message '<본문>'`을 직접 실행한다. Codex 대상은 미지원이다.
- npm의 `tfx-peer.cmd` shim은 cmd.exe가 본문을 다시 해석해 `%`, `&`, 줄바꿈을 깨뜨리므로 쓰지 않는다.
- 로컬 `tfx-live start --cli codex`와 resume은 공유 app-server 데몬에 붙고, 소켓이 없으면 `codex app-server daemon start`를 안내하며 실패한다. 손으로 띄운 Codex는 `tfx-live adopt --session <tmux 대상>`으로 연결한다. 리드가 그 pane에 nonce 메시지를 tmux로 한 번 입력하고, 그 메시지를 받은 공유 데몬 thread를 pane에 기록한다. 이 한 번은 상대 기록에 사용자 발화로 남는다. `-c` 설정 덮어쓰기나 `--no-daemon`으로 띄운 Codex는 공유 데몬 밖에서 돌아 adopt가 실패하므로 `tfx-live start --cli codex --resume <thread>`로 다시 띄운다.
- unknown 발신은 `회신: 경로 불명(보낸 세션을 판별하지 못함)`을 안내한다.
- Claude의 `SendMessage`에서 `codex:` 대상은 mods가 native 피어 경로로, `agy:`·`antigravity:` 대상은 `tfx-live send`로 전달한다.
- Codex 리드는 `spawn_agent`를 29회 부르고 `close_agent`를 한 번도 부르지 않은 사고가 있었다. 서브에이전트는 결과를 받은 즉시 닫는다.
- Codex 0.162.1 에서 모델에 노출된 협업 도구는 `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents`, `interrupt_agent`이고 `close_agent`와 `send_input`은 없었다. `send_message`는 하위 에이전트의 턴을 시작하지 않고 다음 `followup_task` 턴에 함께 전달된다. 대상은 자기가 띄운 하위 에이전트(`/root/...`)다.
- Codex 리드가 다른 로컬 Codex 세션에 보낼 때도 셸에서 `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'codex:<정확한 이름>' --message '<본문>'`을 실행한다.
- native 피어의 `written`·`sent`는 모델 완료가 아니다. 피어의 결과 보고를 확인한다. `ask`를 보낼 때는 `--no-wait`, 완료는 5절의 확인 수단을 쓴다.

## 1. 역할과 수명

띄운 쪽이 그 세션의 생성, 이름, 컨텍스트, 승계, 종료를 소유한다. 서브에이전트를 부른 세션도 같다.

- 이름: `<월>.<일> <주제>`. 승계 세션은 기존 이름 뒤에 ` 2`, ` 3`.
- 승계 순서:
  - 인계 파일을 쓴다. 목표, 완료 조건, 체크아웃 상태, 확정 결정, 증거 경로, 미완료, 다음 행동, `predecessorSessionId`를 담는다.
  - 승계 세션이 경로를 읽고 ACK 한다.
  - ACK 를 받은 뒤에만 원 세션을 닫는다.
- 닫은 뒤에는 남은 세션이 없는지 `tmr ls --json`으로 확인한다. tmr 이 없으면 `tmux ls`로 본다. tmr 은 macOS(arm64) 에서 `tfx setup` 이 설치를 묻는다.

```bash
tmr ls --json   # tmr 이 있으면
tmux ls         # 없으면
```

## 2. 역할별 모델

모델 ID 는 적지 않는다. Codex 는 프로필명, Claude 는 별칭을 쓴다. 현재 대응은 `.claude/rules/tfx-routing.md`의 "모델 배치" 표가 정본이다.

| 역할 | 모델 | 비고 |
| --- | --- | --- |
| 리드 (Claude) | Claude 최상위 tier, effort high | 지휘와 판정만 맡는다 |
| 리드 (Codex) | `astra_xhigh` | 지휘와 판정만 맡는다 |
| 판단 중심 긴 작업 | Claude `opus` | 설계 검토, 긴 구현 |
| 반복 검증, 정형 문서 | Claude `sonnet` | 테스트 재실행, 표 갱신 |
| `opus`로 안 풀리는 난제 | Claude `fable` | 최종 수단 |
| Codex 설계, 비평, 디버그 | `astra_xhigh` | |
| Codex 일반 구현, Claude 작성 코드 리뷰 | `sol_high` | 리뷰는 `review` 서브커맨드를 쓴다 |
| 보안 리뷰 | Argon High `argon_high` | `security-reviewer` |
| Codex 정리 | `sol_med` | |
| Codex 반복 작업 | `luna_high` | |
| Codex 시험용 | 역할 프로필에 effort low | 연결 확인용 |

설계 역할 `architect`, `planner`, `analyst`, `critic`은 `astra_xhigh`를 유지한다. 나머지 역할도 별도 결정이 없으면 현재 배정을 유지한다.

| 리드 | 코드 작성 벤더 | verifier | explore |
| --- | --- | --- | --- |
| Claude | Codex 또는 Antigravity | Opus 네이티브 서브에이전트 | Haiku 네이티브 |
| Claude | Claude | Codex Sol `sol_high` | Haiku 네이티브 |
| Codex | 모두 | Codex Sol 네이티브 | Luna low 네이티브 |
| Antigravity | Codex 또는 Claude | Argon High 네이티브 | Luna low 네이티브 |
| Antigravity | Antigravity | Codex Sol `sol_high` | Luna low 네이티브 |

이 표는 리드의 호출 절차를 정한다. 코드의 verifier 기본값은 Codex Sol로, explore 기본값은 Claude로 유지한다. Codex 리드의 verifier는 빌드, 테스트, 요구사항 충족 증거를 확인하고 코드 승인은 하지 않는다.

- Codex 주간 한도가 낮으면 새 Codex 워커 대신 Claude 로 돌린다.
- 세션을 띄울 때마다 사용자에게 한 줄로 알린다: "이 역할에 이 모델, tmux 세션명 `<이름>`(tmr 이나 tmux 로 여는 대상)".
- 서브에이전트(Agent 도구, `spawn_agent`)는 tmux 에 보이지 않는다. 알릴 때 그렇다고 밝힌다.

## 3. 부르는 방법

| 용도 | 수단 |
| --- | --- |
| 오래 가는 작업 세션 | `tfx-live start`로 tmux 에 띄운다. 사람이 tmr 의 목록 화면으로 본다. tmr 이 없으면 `tmux attach -r -t <세션>` |
| 일회성 판단, 리뷰 | 서브에이전트. 리드 CLI 별 도구는 위 표, model과 effort 를 지정하고 백그라운드로 |
| 일회성 Codex 작업 | `tfx-route.sh` 역할 호출 |
| 기존 Claude 세션에 요청 | 위 표의 "Claude 세션에 보내기" |
| 기존 Codex 세션에 요청 | 로컬은 `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'codex:<정확한 이름>' --message '<본문>'`, 원격은 `tfx-live ask --cli codex` |
| 무거운 전체 테스트 | 원격 격리 호스트. `tfx-remote probe`를 먼저 돌린다 |

```bash
tfx-live start --cli claude --session cl-doc --name "10.8 문서 정리" --model opus --effort high
tfx-live start --cli codex --session cx-impl --name "10.8 구현"
"$HOME/.claude/scripts/tfx-peer" send --to 'codex:10.8 구현' --message '<지시서 경로>를 읽고 시작해줘'
```

- Codex 에 슬래시 명령(`/compact`, `/rename`, `/new`)을 보낼 때만 tmux 직접 입력을 쓴다. queue 로 보내면 일반 텍스트가 된다.
- 원격 `ask`의 tmux 폴백은 결과의 `fallbackReason`으로 확인한다. 로컬 native 피어는 thread를 못 찾으면 실패한다.
- 같은 cwd에 Codex TUI가 여럿이면 피어의 정확한 이름을 지정한다. `ask`에는 `--thread UUID`를 명시한다.
- 잘못 보낸 queue 요청은 TUI 가 가져가기 전에만 `tfx-live queue --cli codex --session <이름> --request-id <id> --delete all`로 지운다. 결과의 `missing`은 이미 배달된 것이다.

### 실행 위치 결정

워커를 어디서 돌릴지(m5 로컬, m2, ryzen)는 리드가 디스패치 직전에 정해 지시서에 적는다. 워커는 받은 위치에서 실행만 하고, 압박을 느끼면 리드에게 보고한다. 피어 세션이 워커에 오프로드 지침을 따로 뿌리지 않는다.

```bash
sysctl -n kern.memorystatus_vm_pressure_level   # 1 normal, 2 warn, 4 critical
node scripts/remote-spawn.mjs --probe m2         # 원격 후보의 압박과 준비 상태
```

- 기준값은 `.claude/rules/tfx-routing.md`의 "원격 오프로드 기본 정책"이 정본이다. 4 는 무조건 원격, 2 는 무거운 shard 와 워커 3개 이상 신규 생성만 원격, 1 은 로컬
- 호스트는 작업 성격으로 고른다. 무거운 계산과 Claude 워커는 ryzen 우선. git push, PR, Codex 스킬이 필요한 작업은 m2 이고, m2 는 probe 압박이 1 일 때만 보낸다. 둘 다 안 되면 전체 테스트 스위트는 미루고(10절 안전) 나머지만 로컬 순차. 세부 조건은 위 정본의 호스트 선택 항목
- 지시서에는 실행 위치와 호스트별 주의를 적는다. ryzen 은 Windows(PowerShell 7)를 쓰며 기본 디렉터리는 `%USERPROFILE%\Desktop\Projects`다. 로컬 멀티플렉서와 원격 psmux 3.4.0 이상이 있으면 `remote-spawn`이 원격 psmux 세션 안에서 Claude를 실행한다
- 원격에 띄운 세션도 띄운 리드가 종료까지 책임진다

#### 압박 변화 대응

리드를 맡으면 세션 안에서 `/tfx-lead on` 을 실행한다. 그러면 triflux mod 가 2초마다
`kern.memorystatus_vm_pressure_level` 을 읽어 두 표본 연속으로 확정한 단계 전이를 턴으로 넣어 준다. 상주 프로세스와
설치는 없다([ADR-0041](../../docs/adr/0041-memory-pressure-watcher.md)). 리드를 넘기거나 끝낼 때 `/tfx-lead off`.
실행 중인 세션은 다른 기기로 옮길 수 없다는 전제로, 전이별 행동은 다음과 같다.

| 전이 | 행동 |
| --- | --- |
| 1 → 2 (warn) | 새 로컬 워커는 한 번에 1개까지. 무거운 shard 와 전체 테스트는 원격으로. 실행 중인 것은 그대로 둔다 |
| 2 → 4 (critical) | 순서대로. 1) 새 스폰 전부 중단 2) 유휴 headless 워커와 끝난 세션을 `tfx multi stop`, `tfx-live stop` 으로 닫는다 3) 재개 가능한 Codex 워커는 중단하고 thread ID 와 남은 지시를 기록해 원격에서 다시 띄운다 4) 사용자가 쓰는 대화형 세션은 건드리지 않고 상황과 한 일을 사용자에게 알린다 5) 리드 자신은 컨텍스트가 60% 를 넘었으면 compact 한다 |
| 4 → 2 | 보류한 디스패치를 원격 우선으로 재개한다. 로컬 신규 스폰은 아직 1개까지 |
| 2 → 1 (normal) | 로컬 정책으로 돌아간다. 중단했던 작업이 남아 있으면 먼저 재개한다 |

`/tfx-lead status` 는 등록 여부와 마지막 표본의 단계·시각을 보여 준다. `/clear` 뒤에도 등록이 이어지지만 resume 한
세션은 다시 `/tfx-lead on` 한다. 긴 턴 중의 전이는 턴이 끝난 뒤 마지막 상태로 합쳐져 오므로 받은 즉시 `/tfx-lead status` 로
현재 단계를 확인한다. 등록이 꺼져 있거나 mod 가 없는 세션은 디스패치 직전 `sysctl` 측정(ADR-0040)만 한다.

#### Windows 원격 수동 실행 대안

기본 경로는 `remote-spawn --host <host>`다. 지원 버전의 psmux가 있으면 원격 세션을 감싸고,
`--attach`로 다시 붙으며 `--kill`로 소유를 확인한 뒤 분리·종료·파일 정리를 한다.
psmux가 없거나 지원 버전 미만이면 기존 직접 실행 경로를 쓰며, SSH가 끊기면 Claude도 종료된다.

`remote-spawn`을 쓸 수 없지만 psmux 3.4.0 이상이 있는 경우에는 아래 수동 절차를 쓴다.
psmux도 없으면 Windows Terminal/PowerShell에서 Claude를 직접 실행한다.
원격 스크립트는 `scp`로 올리고, 공백·따옴표가 든 경로는 `pwsh -EncodedCommand` 안에서 호출한다.

```powershell
# start-worker.ps1 (ryzen 에서 실행). 세션 이름은 tfx- 접두사, 경로는 Windows 형식
psmux new-session -d -s tfx-1015-fulltest -c "$env:USERPROFILE\Desktop\Projects\triflux"
psmux send-keys -t tfx-1015-fulltest "claude -n '10.15 전체 테스트' --model sonnet" Enter
```

```bash
scp start-worker.ps1 ryzen:start-worker.ps1 && ssh ryzen pwsh -File start-worker.ps1
ssh ryzen psmux capture-pane -p -t tfx-1015-fulltest          # 확인
```

```powershell
# stop-worker.ps1. 연결을 먼저 끊고 2초 뒤 세션을 지운다(WT ConPTY 종료 경쟁 회피)
# detach-client 의 -t 는 클라이언트 이름이라 세션을 분리하지 못한다. 세션은 -s 로 지정한다
psmux detach-client -s tfx-1015-fulltest
if ($LASTEXITCODE -ne 0) { Write-Error "detach 실패. psmux list-clients 로 확인한 뒤 다시 실행"; exit 1 }
Start-Sleep -Seconds 2
psmux kill-session -t tfx-1015-fulltest
```

`send-keys` 로 보내는 명령은 PowerShell 문법이다. `&&`, `export`, `$(...)`, Unix 경로를 쓰지 않는다.

## 4. 지시 전달

긴 지시는 지시서 파일에 쓰고 프롬프트에는 경로만 보낸다.

- 위치: 저장소가 무시하는 경로(`.omc/briefs/` 같은 곳).
- 구성: 목표, 범위, 건드리지 않을 것, 완료 조건, 결과 파일 경로, 보고 형식.
- 방향이 바뀌면 지시서 끝에 "정정" 절을 덧붙이고, 그 절이 앞 절을 대체한다고 적는다. 앞 절은 지우지 않는다.
- 첫 지시를 보낸 뒤 작업이 실제로 시작됐는지 확인한다. tmux 직접 입력은 첫 지시가 유실된 사례가 있다.
- 긴 프롬프트를 tmux 에 직접 입력하지 않는다. 화면이 깨진다.

## 5. 결과 회수

결과는 파일(`.result.md`)과 짧은 보고로 받는다. 로컬 피어 보고도 전송 경로 표를 따른다. 아래 `wait`와 `requestId`는 `tfx-live ask`로 보낸 요청에만 적용한다.

- 화면 폴링(`tmux capture-pane` 반복)은 하지 않는다.
- 대기하는 동안 리드는 다른 레인을 진행한다.
- 서브에이전트의 완료는 알림으로 안다(Claude 는 `run_in_background`, Codex 는 `spawn_agent` 결과). PR CI 는 백그라운드로 감시한다.
- 띄워 둔 세션의 완료는 `tfx-live wait`가 지원하는 범위에서만 쓴다.

| 대상 세션 | 완료 확인 |
| --- | --- |
| Claude 백그라운드(daemon) 세션 | `tfx-live wait --cli claude --short <8hex> --request-id <id>` (로컬 UDS 만, `--session`은 받지 않는다) |
| Codex 세션 | `tfx-live wait --cli codex --session <tmux 이름> --request-id <id>` 또는 `--thread <UUID>` |
| tmux 로 띄운 대화형 Claude 세션, Claude 리드 | 그 세션이 지시서의 보고 규칙에 따라 `SendMessage`로 보고한다 |
| tmux 로 띄운 대화형 Claude 세션, Codex 리드 | `tfx-live wait --cli claude --session <tmux 이름> --request-id <id>` (로컬만) |

```bash
tfx-live ask --cli claude --transport uds --short <8hex> --prompt "<지시서 경로>" --no-wait
tfx-live wait --cli claude --short <8hex> --request-id <requestId> --timeout 600
```

- `timedOut: true`는 완료가 아니다. 재전송하지 않고 상태를 먼저 확인한다.
- `status: "unknown"`도 재전송하지 않는다.

## 6. 교차 리뷰와 머지

작성 벤더와 다른 벤더가 `code-reviewer`, `quality-reviewer`로 리뷰한다. 작성 벤더를 `TFX_REVIEW_AUTHOR=codex|claude|antigravity`로 지정한다. 미지정이면 Codex로 보고 잘못된 값은 오류로 끝낸다.

| 작성 벤더 | 기본 리뷰 | Claude 주간 사용량 80% 이상 |
| --- | --- | --- |
| Codex | Claude Opus | Argon High `argon_high` |
| Claude | Codex Sol `sol_high` review | Codex Sol `sol_high` review |
| Antigravity | Claude Opus | Codex Sol `sol_high` review |

사용량은 `~/.claude/cache/claude-usage-cache.json`의 `data.weeklyPercent`를 읽는다. 없거나 읽을 수 없으면 한도 미만으로 본다. Claude 리뷰는 `tfx-route.sh`의 Claude 워커 경로와 `--model opus`를 쓴다. 명시 CLI 선택의 기존 우선순위는 유지한다. verifier의 증거 확인과 코드 리뷰의 승인은 구분한다.

- 머지 조건은 CI 통과와 교차 리뷰 통과, 둘 다다.
- 리뷰에서 사실 오류가 나오면 처음 작성자에게 되돌려 고친다. 같은 리뷰어가 재확인한다.
- 리드가 대신 고치고 스스로 승인하지 않는다.
- 리뷰 요청에도 지시서 경로를 쓰고, 리뷰 결과는 파일로 받는다.
- 리뷰 지적을 반영한 커밋도 다시 확인받는다. 첫 리뷰어가 이미 닫혔으면 같은 조건의 리뷰어를 새로 띄워 그 커밋만 보게 한다.
- CI 실패는 재실행 전에 실패한 테스트가 이 PR 의 변경과 관계있는지 먼저 본다. 관계있으면 작성자에게 돌려보낸다.
- 같은 종류의 가장자리 지적이 리뷰 세 번째까지 이어지면 하던 방식을 의심한다. 상류 도구의 내부 로직을 다시 구현하고 있다면, 그 도구가 실제로 한 일을 관찰하는 방식으로 바꿀 수 있는지 먼저 따진다. 통과한 부분은 PR 을 나눠 먼저 머지한다.

## 7. 겹침 관리

- 여러 레인이 같은 파일을 고치면 머지 순서를 정한다. 뒤쪽 레인이 rebase 한다.
- 공유 번호 자원(ADR 번호 등)은 리드가 미리 나눠 지시서에 적는다.
- 다른 레인의 범위는 지시서에 "건드리지 않는다"로 명시한다.
- 레인마다 별도 worktree 를 쓴다. 위치는 저장소의 `.worktrees/` 아래다.

## 8. 사용자 결정

- 결정이 여러 개면 결정표 파일 하나로 모아 한 번에 묻는다. 열은 항목, 선택지, 권고, 근거다.
- 답을 받으면 같은 파일 끝에 기록한다.
- 전제가 바뀌면(예: 호출자가 사라짐) 이미 받은 답도 다시 묻는다.
- 되돌릴 수 없거나 권한 분류기가 막을 일은 결정표에 따로 표시한다.

## 9. 릴리스

- 버전 PR 을 머지하기 전에 모든 세션에 main 머지 보류를 요청한다.
- 게시와 설치본 교체가 끝나면 "보류 해제"를 알린다.
- 다음 버전에 들어갈 재료 파일을 계속 갱신한다.
- CHANGELOG 는 작성자와 다른 모델이 PR 실제 내용과 대조한다.
- 릴리스 절차 자체는 `tfx-ship`을 따른다.

## 10. 안전

- 실제 HOME 으로 전체 테스트를 돌리지 않는다. 개발 체크아웃에서 `npm ci`를 실행하지 않는다(ADR-0030). 필요하면 `npm ci --ignore-scripts`.
- 전체 테스트는 원격 격리 호스트에서 돌린다. 로컬에서는 변경 영역만 임시 HOME 으로 돌린다.
- 커밋과 PR 에 AI trailer, `Co-Authored-By`, 세션 링크를 넣지 않는다.
- 세션 닫기, 머지, 계정 전환처럼 권한 분류기가 막는 일은 사용자 허락을 받은 뒤에만 한다.
- 막힌 일을 다른 세션에 대신 시키지 않는다. 우회가 되기 때문이다.
- 워크트리에서 도구를 실행하면 전역 설정을 그 경로로 덮어쓸 수 있다. 전역 경로를 쓰는 스크립트는 설치본에서만 실행한다.

## 11. 컨텍스트 점검

비율 기준은 `tfx-live` 스킬의 "컨텍스트 판단" 표를 따른다. 여기서는 재는 방법만 적는다.

- 가장 쉬운 방법은 `tfx-live probe`다. 결과의 `contextPct`를 본다.
- 직접 재야 하면 세션 transcript 의 마지막 assistant 항목 `usage`에서 입력 계열 토큰(`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)을 더한다. 이 합을 공식 모델 창과 실행 한도 중 작은 값으로 나눈다.
- Codex 는 rollout 의 마지막 토큰 사용량 이벤트로 같은 계산을 한다.
- 지시서에 보고 기준을 넣는다. 비율은 받는 세션의 CLI 에 맞춰 `tfx-live` 표의 준비·경고 열을 쓴다. 예: Claude 는 60%, Codex 는 15%, agy 는 12%. 예시: "컨텍스트가 <비율>을 넘으면 작업을 멈추고 리드에게 보고하라."
- 재개한 세션(`--resume`)은 이전 사용량을 그대로 이어받는다. 재개 직후 한 번 잰다.
- 85%에 닿은 Claude 세션에는 새 작업을 주지 않고 바로 승계한다.

## 12. 운영 점검표

세션을 띄울 때:

- [ ] 이름이 `<월>.<일> <주제>` 형식이다
- [ ] 역할에 맞는 모델과 effort 를 골랐다
- [ ] 압박을 재고 실행 위치(m5/m2/ryzen)를 지시서에 적었다
- [ ] 리드 세션에서 `/tfx-lead on` 을 했다(끝낼 때 `/tfx-lead off`)
- [ ] 사용자에게 모델과 tmux 세션명을 알렸다
- [ ] 지시서 경로를 보냈고 작업 시작을 확인했다
- [ ] 세션 CLI 에 맞는 컨텍스트 보고 기준이 지시서에 있다

세션을 닫을 때:

- [ ] 결과 파일을 읽었다
- [ ] 필요하면 인계 파일과 승계 ACK 를 확인했다
- [ ] 닫은 뒤 `tmr ls --json`(없으면 `tmux ls`)으로 확인했다

## 13. 정리, 삭제, 결함 수정 레인

코드를 지우거나 간헐 실패를 고치는 레인의 지시서에 아래 기준을 넣는다.

- 무엇을 지울지는 사용자가 결정표로 정한다. 작업 세션은 정해진 것을 실행하고, 쓰임을 추측해 지우지 않는다.
- 제거 판정은 그 파일을 끝까지 읽은 뒤에만 한다. 파일명, grep 결과, 서브에이전트 요약은 단서일 뿐이다. 리드가 지시서에 적은 사실도 단서로 쓰라고 적는다.
- 지우는 기준은 "지우기 전과 동작이 같은가"다. 지시서에 비교할 기존 경로를 적고(예: 기능이 꺼져 있거나 비어 있을 때의 경로), 리뷰에서 그 동등성을 확인한다.
- 의존성은 코드 import 만 보지 말고 다른 패키지의 peer 의존과 지연 import 까지 확인한다.
- 간헐 실패는 재시도나 timeout 을 늘려 덮지 않는다. 재현해서 원인을 확정하고, 확정하지 못하면 고치지 않고 근거와 남은 후보만 결과 파일에 적는다.
- 원인을 확정한 수정에서 새 판정이 확신할 수 없는 값을 낼 때는, 안전성이 확인된 기존 폴백 경로로 돌아가게 한다(값을 비워 기존 경로를 타게 하는 식). 틀린 확정보다 폴백이 낫다. 원인을 확정하지 못했으면 이 규칙을 쓰지 않고 위의 "고치지 않고 보고"를 따른다.
- 범위 밖에서 발견한 문제는 고치지 않고 목록으로 보고받는다. 리드가 다음 레인으로 배정한다.

