---
name: tfx-lead
description: >
  세션에 개발 리드, 프로젝트 리드 같은 역할 리드를 맡길 때(`/tfx-lead <역할>`),
  리드가 워커에게 이름을 붙여 등록하고 그 워커들의 컨텍스트, 승계, 교차 리뷰,
  머지, 릴리스를 조율할 때 사용한다.
---

# tfx-lead

## 목적

한 세션에 역할 리드를 맡기고, 리드가 워커를 등록하고, 등록한 워커의 컨텍스트와 진행을 관리하는 절차다. Claude 리드와 Codex 리드가 같은 절차를 따른다.
세션을 띄우고 보내고 기다리고 compact 하고 닫는 명령의 상세, 전송 세부, 컨텍스트 비율 표는 `tfx-live` 스킬이 정본이다. 여기서는 복제하지 않는다.
근거는 ADR-0027(Codex queue), ADR-0029(리드 운영), ADR-0030(테스트 격리), ADR-0043(리드 진입과 압박 감시)와 `.claude/rules/tfx-routing.md`의 "모델 배치" 표다.

## 리드 진입

Claude 리드는 세션 안에서 `/tfx-lead <역할>`을 실행한다(예: `/tfx-lead 개발리드`). triflux mod 가 세 가지를 한다.

- 세션 이름을 `<월>.<일> <역할>`로 바꾼다. 인자가 이미 날짜로 시작하면 그대로 쓴다.
- macOS 대화형 세션이면 아래 "압박 변화 대응"의 감시를 켠다.
- 이 스킬을 따르라는 숨은 지시를 모델에 넣는다.

이름 변경이 거부되면 "이름 변경 실패" 토스트가 뜬다. 그때는 사용자에게 `/rename <이름>` 입력을 요청한다. mod 가 없는 세션도 같다.
Codex 리드는 mod 가 없으므로 `/rename <월>.<일> <역할>`을 직접 쓰고 이 스킬을 읽는다.

## 워커 등록

리드가 워커마다 연락해 이름을 붙이면 등록이 끝난다.

- 이름 형식: `<월>.<일> <주제>`. 승계 세션은 기존 이름 뒤에 ` 2`, ` 3`.
- 대상 찾기: `tmr ls --json`으로 pane 별 에이전트와 상태를 본다. CLI 별로는 `tfx-live list-sessions --cli <claude|codex|agy>`.
- 이름 붙이기:

| 워커 CLI | 이름 붙이는 수단 |
| --- | --- |
| Claude | `tfx-live ask --cli claude --session <tmux 대상> --prompt "/rename <이름>"` |
| Codex | `tfx-live rename --cli codex --transport uds --thread <ID> --name "<이름>"`, thread 가 없으면 tmux 로 `/rename <이름>` |
| agy | tmux 로 `/rename <이름>`. 새 대화는 첫 메시지 전에 실패하므로 `tfx-live` 의 `namePending` 처리를 따른다 |

- 등록 기록: 리드가 상태 파일 하나(예: `.omc/lead/workers.md`)에 워커마다 이름, CLI, 위치(m5, m2, ryzen 과 tmux 대상), 역할, 지시서 경로를 적는다. 저장소가 무시하는 `.omc/` 아래에 둔다. 닫은 워커는 그 줄을 지운다.
- 같은 이름의 세션이 로컬과 Remote Control 에 하나씩 있으면 `SendMessage`가 ref 를 요구한다. `ListAgents`에서 "on this machine" 쪽 ref 를 붙인다.
- 워커를 다시 띄울 때는 원래 tmux 세션 안에서 `--resume <ID>`로 띄운다. 세션 이름과 tmr 재접속 루프가 그대로 맞는다.
- `tfx-live list-sessions`의 `status: shell`은 CLI 가 죽었다는 뜻이 아닐 수 있다. 그 세션이 띄운 백그라운드 셸일 수 있으니 재실행 전에 pane 내용을 확인한다.

## 전송 수단

| 대상 | Claude 리드 | Codex 리드 |
| --- | --- | --- |
| Claude 세션에 보내기 | 로컬 Claude끼리는(팀원 포함) `SendMessage(to: "<이름>")`. 이름은 `tfx-live list-sessions --cli claude`의 `name`, 첫 지시는 `start` 결과의 `sendMessageTo`. 원격은 `tfx-live ask --cli claude` | 로컬은 `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'claude:<정확한 이름>' --message '<본문>'`. 원격은 `tfx-live ask --cli claude` |
| Codex 세션에 보내기 | 로컬은 `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'codex:<정확한 이름>' --message '<본문>'`. 원격은 `tfx-live ask --cli codex` | Claude 리드와 같다 |
| agy 세션에 보내기 | `tfx-live send --to agy:<이름> --message <본문> --no-wait` 또는 `tfx-live ask --cli agy`. 같은 기기의 agy 끼리는 `~/.local/bin/agy.patch.json`의 `sha256`이 실제 바이너리 해시와 같고 `patches`에 `peer-wake`가 있을 때만 `send_message`(대화 ID)를 쓴다(공개 이슈 #1022). `tfx-live send`의 agy 대상 전송은 tmux 경로를 유지한다 | `tfx-live send --to agy:<이름> --message <본문> --no-wait` 또는 `tfx-live ask --cli agy` |
| 같은 세션 안 서브에이전트 | Agent 도구(`model`, `effort`, `run_in_background`) | `spawn_agent`, 추가 지시는 `followup_task` |
| 사용자 | `AskUserQuestion` | 답변에서 짧은 선택지로 묻는다 |

Windows, adopt, Codex 협업 도구 목록, native 피어 실패 처리 같은 전송 세부는 `tfx-live`의 "전송 경로"와 "선택적 전역 native peer 어댑터" 절을 따른다. Codex 에 슬래시 명령을 보낼 때만 tmux 직접 입력을 쓴다.

## 1. 역할과 수명

띄운 쪽이 그 세션의 생성, 이름, 컨텍스트, 승계, 종료를 소유한다. 서브에이전트를 부른 세션도 같다.

- 승계 순서:
  - 인계 파일을 쓴다. 목표, 완료 조건, 체크아웃 상태, 확정 결정, 증거 경로, 미완료, 다음 행동, `predecessorSessionId`를 담는다.
  - 승계 세션이 경로를 읽고 ACK 한다.
  - ACK 를 받은 뒤에만 원 세션을 닫고 등록 기록을 고친다.
- 서브에이전트는 결과를 받은 즉시 닫는다. Codex 리드가 `spawn_agent`를 29회 부르고 한 번도 닫지 않은 사고가 있었다. Claude 리드의 Agent 도구 팀원은 3절 "끝난 팀원 닫기" 절차로 닫는다.
- 닫은 뒤에는 남은 세션이 없는지 `tmr ls --json`(없으면 `tmux ls`)으로 확인한다. tmr 은 macOS(arm64) 에서 `tfx setup` 이 설치를 묻는다.

## 2. 역할별 모델

모델 ID 는 적지 않는다. Codex 는 프로필명, Claude 는 별칭을 쓴다. 현재 대응은 `.claude/rules/tfx-routing.md`의 "모델 배치" 표가 정본이다.

| 역할 | 모델 | 비고 |
| --- | --- | --- |
| 리드 (Claude) | Claude 최상위 tier, effort high | 지휘와 판정만 맡는다 |
| 리드 (Codex) | `astra_xhigh` | 지휘와 판정만 맡는다 |
| 판단 중심 긴 작업 | Claude `opus` | 설계 검토, 긴 구현 |
| 반복 검증, 정형 문서 | Claude `sonnet` | 테스트 재실행, 표 갱신 |
| `opus`로 안 풀리는 난제 | Claude `fable` | 최종 수단 |
| Codex 설계, 비평, 디버그 | `astra_xhigh` | `architect`, `planner`, `analyst`, `critic` 포함 |
| Codex 일반 구현, Claude 작성 코드 리뷰 | `sol_high` | 리뷰는 `review` 서브커맨드 |
| 보안 리뷰 | Argon High `argon_high` | `security-reviewer` |
| Codex 정리, 반복 작업 | `sol_med`, `luna_high` | |
| Codex 시험용 | 역할 프로필에 effort low | 연결 확인용 |

| 리드 | 코드 작성 벤더 | verifier | explore |
| --- | --- | --- | --- |
| Claude | Codex 또는 Antigravity | Opus 네이티브 서브에이전트 | Haiku 네이티브 |
| Claude | Claude | Codex Sol `sol_high` | Haiku 네이티브 |
| Codex | 모두 | Codex Sol 네이티브 | Luna low 네이티브 |
| Antigravity | Codex 또는 Claude | Argon High 네이티브 | Luna low 네이티브 |
| Antigravity | Antigravity | Codex Sol `sol_high` | Luna low 네이티브 |

이 표는 리드의 호출 절차를 정한다. 코드의 verifier 기본값은 Codex Sol, explore 기본값은 Claude 로 유지한다. Codex 리드의 verifier 는 빌드, 테스트, 요구사항 충족 증거만 확인하고 코드 승인은 하지 않는다.

- Codex 주간 한도가 낮으면 새 Codex 워커 대신 Claude 로 돌린다.
- 세션을 띄울 때마다 사용자에게 한 줄로 알린다: "이 역할에 이 모델, tmux 세션명 `<이름>`". 서브에이전트는 tmux 에 보이지 않는다고 밝힌다.

## 3. 부르는 방법

| 용도 | 수단 |
| --- | --- |
| 오래 가는 작업 세션 | `tfx-live start`로 tmux 에 띄우고 위 "워커 등록"을 한다. 사람은 tmr 목록 화면으로 본다 |
| 전담 워커: 같은 일이 다시 올 것 같거나(재사용성), 주제가 정해졌거나(주제 고정), 역할이 정해진(역할 고정) 워커 | 작업 길이와 관계없이 `tfx-live start`로 이름 붙인 세션을 띄우고, 등록 기록에 역할과 주제를 함께 적는다. 아래 "전담 워커 재사용"을 따른다 |
| 일회성 판단, 리뷰 | 서브에이전트. model 과 effort 를 지정하고 백그라운드로 |
| 일회성 Codex 작업 | `tfx-route.sh` 역할 호출 |
| 무거운 전체 테스트 | 원격 격리 호스트. `tfx-remote probe`를 먼저 돌린다 |

```bash
tfx-live start --cli claude --session cl-doc --name "10.8 문서 정리" --model opus --effort high
tfx-live start --cli codex --session cx-impl --name "10.8 구현"
```

Agent 도구로 띄운 팀원(agent teams 의 tmux 모드)은 리드의 현재 폴더에서 새 Claude 프로세스로 뜬다. 처음 보는 폴더면 "Quick safety check" 신뢰 화면에서 멈추며, 이 화면의 자동 승인은 `tfx-live start` 와 `remote-spawn --auto-trust` 에만 있고 Agent 도구 경로에는 없다. 이미 신뢰한 폴더에서 띄우고 절대 경로로 일을 시키거나, 새 폴더면 사용자가 한 번 신뢰한 뒤 띄운다.

### 팀원 표시 방식

근거는 공식 문서 [agent teams](https://code.claude.com/docs/en/agent-teams)다.

- Agent 도구를 `name` 과 함께 호출하면 팀원으로 뜬다. agent teams 가 켜져 있고 fork 나 `isolation` 호출이 아닐 때다. `name` 을 빼면 pane 없이 같은 프로세스 안에서 도는 보통 서브에이전트가 된다.
- 팀원 표시는 `teammateMode` 설정(`in-process`, `auto`, `tmux`, `iterm2`)이 정한다. 공식 기본값은 `in-process` 고, `auto` 는 tmux 안이거나 iTerm2 에 `it2` 가 있으면 pane 을 나눈다. 세션 하나만 바꾸려면 `claude --teammate-mode <값>` 으로 띄운다. 이 기기의 사용자 설정은 `auto` 라서 tmux 안의 리드는 팀원마다 리드 창을 나눈다.
- 실행 중인 세션에서 `teammateMode` 를 바꾸면 바로 적용되는지는 공식 문서에서 확인 못 했다. 화면 폭에 따라 모드를 자동으로 바꾸는 기능도 없다.

리드 pane 폭을 `tmux display -p -t "$TMUX_PANE" '#{pane_width}'` 로 재고 다음처럼 띄운다.

| 리드 pane 폭 | 띄우는 방법 |
| --- | --- |
| 200 cols 이상 | 지금처럼 `name` 을 붙인 팀원. pane 분할 관전 가능 |
| 200 cols 미만 | `name` 없이 `run_in_background: true` 서브에이전트. 완료는 알림으로 받는다. 오래 가거나 다시 쓸 워커는 위 표대로 `tfx-live start` 별도 세션으로 띄우고 tmr 로 본다 |
| 처음부터 좁은 화면에서 리드를 띄울 때 | `claude --teammate-mode in-process` 로 시작한다. 팀원은 리드 창 아래 에이전트 패널에 뜨고 화살표와 Enter 로 본다 |

- 200 cols 는 `skills/tfx-auto/references/tmux-observation.md` 의 워커당 최소 100 cols 기준을 그대로 쓴 값이다. 팀원 pane 이 리드 창을 좌우로 나누므로 나뉜 뒤에도 리드 쪽이 100 cols 를 지키려면 나누기 전 폭이 그 두 배는 돼야 한다. 호스트가 나누는 비율은 실측하지 못했고, 2026-10-23 팀원 12개가 쌓였을 때 리드 pane 이 26 cols 까지 줄었으므로 팀원이 늘면 리드 쪽은 절반보다 더 좁아진다. 그래서 띄우기 전마다 다시 재고, 넓은 화면에서도 끝난 팀원은 아래대로 바로 닫는다.
- 버린 대안: 사용자 설정 `env` 에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0` 을 넣으면 실행 중인 세션에도 바로 적용돼 이름 붙인 서브에이전트가 팀원이 되지 않는다. 하지만 같은 설정을 읽는 다른 세션까지 모두 바뀌므로 쓰지 않는다. `name` 을 빼는 것으로 이 리드만 바꿀 수 있다.

### 끝난 팀원 닫기

팀원은 끝나도 pane 과 Claude 프로세스가 남고, 프로세스마다 MCP 서버를 따로 띄운다. 2026-10-23 끝난 팀원 10개가 MCP 서버를 각 5개씩 쥐고 메모리 압박 2 를 만들었고, 그 pane 들을 닫자 바로 1 로 내려갔다. 결과를 받은 팀원은 바로 닫는다.

1. 그 팀원의 완료 알림(최종 답이 들어 있는 idle 알림)이나 결과 파일을 받았는지 확인한다. 아직 일하는 팀원은 닫지 않는다.
2. 공식 수단으로 종료를 요청한다: `SendMessage(to: "<팀원 이름>", message: {type: "shutdown_request"})`. 팀원이 승인하면 스스로 끝난다. 공식 문서는 진행 중인 요청을 마친 뒤 끝나므로 느릴 수 있다고 적는다.
3. 종료 뒤에도 pane 이 남았으면 pane 을 이름으로 대조한다. 팀원 pane 의 시작 명령에는 `--agent-id <팀원 이름>@<팀 이름>` 이 들어 있다.

```bash
tmux list-panes -s -t "$TMUX_PANE" -F '#{pane_id} #{pane_current_command} #{pane_start_command}' | grep -- '--agent-id <팀원 이름>@'
```

4. 나온 pane 이 정확히 하나이고, 리드 자신(`$TMUX_PANE`)이 아니고, 1 에서 완료를 확인한 이름일 때만 `tmux kill-pane -t <pane_id>` 로 닫는다. 이름이 겹치거나 둘 이상 나오면 닫지 않고 사용자에게 묻는다. `--agent-id` 가 없는 pane 은 사용자가 띄운 것이므로 건드리지 않는다.
5. 닫은 뒤 같은 명령으로 그 pane 이 사라졌는지 본다.

### 전담 워커 재사용

새 일을 나눌 때 서브에이전트를 띄우기 전에 등록 기록을 먼저 본다.

1. 등록 기록에서 같은 역할, 같은 주제의 워커를 찾는다.
2. 찾았으면 살아 있는지 `tmr ls --json`(없으면 `tfx-live list-sessions`)으로 확인한다. 죽었으면 위 "워커 등록"대로 `--resume <ID>`로 되살리거나 그 줄을 지운다.
3. 컨텍스트를 잰다(11절). `tfx-live` 의 준비 기준을 넘었으면 compact 하거나 승계한 뒤 보낸다. 85% 에 닿았으면 승계만 한다.
4. 그 세션에 지시서 경로를 보낸다. 없으면 이번 일이 위 표의 전담 워커 기준에 맞는지 보고, 맞으면 새 전담 세션을 띄워 등록한다.

| 예 | 고를 것 | 이유 |
| --- | --- | --- |
| 같은 묶음의 반복 수정 | 전담 세션 하나 | 2026-10-23 `fix-trim-1`~`fix-trim-4`를 번호만 바꿔 서브에이전트로 새로 띄웠다. 같은 주제라 앞 묶음의 맥락이 다음 묶음에 그대로 쓰이고, 끝난 팀원 넷이 pane 과 프로세스를 따로 쥐었다 |
| 리뷰어 | 작성 세션과 다른 인스턴스 | 같은 워커가 자기 작업을 리뷰하지 않는다(6절). 작성 세션은 리뷰에 재사용하지 않는다. 같은 PR 의 재리뷰가 이어질 것 같으면 리뷰 전담 세션을 따로 두고, 재리뷰도 그 세션에 보낸다 |

### 실행 위치 결정

워커를 어디서 돌릴지(m5 로컬, m2, ryzen)는 리드가 디스패치 직전에 정해 지시서에 적는다. 워커는 받은 위치에서 실행만 하고, 압박을 느끼면 리드에게 보고한다. 피어 세션이 워커에 오프로드 지침을 따로 뿌리지 않는다.

```bash
sysctl -n kern.memorystatus_vm_pressure_level   # 1 normal, 2 warn, 4 critical
node scripts/remote-spawn.mjs --probe m2         # 원격 후보의 압박과 준비 상태
```

- 기준값과 호스트 선택은 `.claude/rules/tfx-routing.md`의 "원격 오프로드 기본 정책"이 정본이다.
- 지시서에는 실행 위치와 호스트별 주의를 적는다. ryzen 은 Windows(PowerShell 7)이고 기본 디렉터리는 `%USERPROFILE%\Desktop\Projects`다. `remote-spawn`을 쓸 수 없을 때의 절차는 `tfx-remote` 스킬의 "Windows 원격 수동 실행 대안" 절이다.
- 원격에 띄운 세션도 띄운 리드가 종료까지 책임진다.

#### 압박 변화 대응

`/tfx-lead <역할>`이 macOS 대화형 세션에서 압박 감시를 켠다. 수동으로 켜고 끄고 볼 때는 `/tfx-pressure on|off|status`를 쓴다. 켜지면 triflux mod 가 2초마다 `kern.memorystatus_vm_pressure_level`을 읽어 두 표본 연속으로 확정한 단계 전이를 리드 자기 세션에 피어 메시지로 넣는다. 상주 프로세스와 설치는 없다([ADR-0043](../../docs/adr/0043-pressure-transition-as-self-peer-message.md)). 리드를 넘기거나 끝낼 때 `/tfx-pressure off`.
실행 중인 세션은 다른 기기로 옮길 수 없다는 전제로, 전이별 행동은 다음과 같다.

| 전이 | 행동 |
| --- | --- |
| 1 에서 2 (warn) | 새 로컬 워커는 한 번에 1개까지. 무거운 shard 와 전체 테스트는 원격으로. 실행 중인 것은 그대로 둔다 |
| 2 에서 4 (critical) | 순서대로. 1) 새 스폰 전부 중단 2) 유휴 headless 워커와 끝난 세션을 `tfx multi stop`, `tfx-live stop` 으로 닫는다 3) 재개 가능한 Codex 워커는 중단하고 thread ID 와 남은 지시를 기록해 원격에서 다시 띄운다 4) 사용자가 쓰는 대화형 세션은 건드리지 않고 상황과 한 일을 사용자에게 알린다 5) 리드 자신은 컨텍스트가 60% 를 넘었으면 compact 한다 |
| 4 에서 2 | 보류한 디스패치를 원격 우선으로 재개한다. 로컬 신규 스폰은 아직 1개까지 |
| 2 에서 1 (normal) | 로컬 정책으로 돌아간다. 중단했던 작업이 남아 있으면 먼저 재개한다 |

`/tfx-pressure status`는 감시 여부와 마지막 표본의 단계·시각을 보여 준다. `/clear` 뒤에도 감시가 이어지지만 resume 한 세션은 다시 `/tfx-lead <역할>` 또는 `/tfx-pressure on` 한다. 전이는 긴 턴 도중에도 피어 메시지로 바로 온다. 피어 전송이 실패하면 본문 끝에 그 사실이 한 줄 붙고, 그때는 턴이 끝난 뒤 마지막 상태로 합쳐져 온다. 어느 쪽이든 받은 즉시 `/tfx-pressure status`로 현재 단계를 확인한다. 감시가 꺼져 있거나 mod 가 없는 세션은 디스패치 직전 `sysctl` 측정(ADR-0040)만 한다.

## 4. 지시 전달

긴 지시는 지시서 파일에 쓰고 프롬프트에는 경로만 보낸다.

- 위치: 저장소가 무시하는 경로(`.omc/briefs/` 같은 곳).
- 구성: 목표, 범위, 건드리지 않을 것, 완료 조건, 결과 파일 경로, 보고 형식.
- 방향이 바뀌면 지시서 끝에 "정정" 절을 덧붙이고, 그 절이 앞 절을 대체한다고 적는다. 앞 절은 지우지 않는다.
- 첫 지시를 보낸 뒤 작업이 실제로 시작됐는지 확인한다. tmux 직접 입력은 첫 지시가 유실된 사례가 있다. 긴 프롬프트를 tmux 에 직접 입력하지 않는다.

## 5. 결과 회수

결과는 파일(`.result.md`)과 짧은 보고로 받는다. native 피어의 `written`·`sent`는 모델 완료가 아니므로 워커의 보고를 확인한다.

- 화면 폴링(`tmux capture-pane` 반복)은 하지 않는다. 대기하는 동안 리드는 다른 레인을 진행한다.
- 서브에이전트의 완료는 알림으로 안다(Claude 는 `run_in_background`, Codex 는 `spawn_agent` 결과). PR CI 는 백그라운드로 감시한다.
- `tfx-live ask`로 보낸 요청은 `--no-wait`로 보내고 아래 수단으로 확인한다.

| 대상 세션 | 완료 확인 |
| --- | --- |
| Claude 백그라운드(daemon) 세션 | `tfx-live wait --cli claude --short <8hex> --request-id <id>` (로컬 UDS 만) |
| Codex 세션 | `tfx-live wait --cli codex --session <tmux 이름> --request-id <id>` 또는 `--thread <UUID>` |
| tmux 로 띄운 대화형 Claude 세션, Claude 리드 | 그 세션이 지시서의 보고 규칙에 따라 `SendMessage`로 보고한다 |
| tmux 로 띄운 대화형 Claude 세션, Codex 리드 | `tfx-live wait --cli claude --session <tmux 이름> --request-id <id>` (로컬만) |

- `timedOut: true`와 `status: "unknown"`은 완료가 아니다. 재전송하지 않고 상태를 먼저 확인한다.

## 6. 교차 리뷰와 머지

작성 벤더와 다른 벤더가 `code-reviewer`, `quality-reviewer`로 리뷰한다. 작성 벤더는 `TFX_REVIEW_AUTHOR=codex|claude|antigravity`로 지정한다. 미지정이면 Codex 로 보고 잘못된 값은 오류로 끝낸다.

| 작성 벤더 | 기본 리뷰 | Claude 주간 사용량 80% 이상 |
| --- | --- | --- |
| Codex | Claude Opus | Argon High `argon_high` |
| Claude | Codex Sol `sol_high` review | Codex Sol `sol_high` review |
| Antigravity | Claude Opus | Codex Sol `sol_high` review |

사용량은 `~/.claude/cache/claude-usage-cache.json`의 `data.weeklyPercent`를 읽고, 읽을 수 없으면 한도 미만으로 본다. Claude 리뷰는 `tfx-route.sh`의 Claude 워커 경로와 `--model opus`를 쓴다.

- 머지 조건은 CI 통과와 교차 리뷰 통과, 둘 다다.
- 리뷰에서 사실 오류가 나오면 처음 작성자에게 되돌려 고치고 같은 리뷰어가 재확인한다. 리드가 대신 고치고 스스로 승인하지 않는다.
- 리뷰 요청에도 지시서 경로를 쓰고, 결과는 파일로 받는다. 지적을 반영한 커밋도 다시 확인받는다. 첫 리뷰어가 닫혔으면 같은 조건의 리뷰어를 새로 띄워 그 커밋만 보게 한다.
- CI 실패는 재실행 전에 이 PR 의 변경과 관계있는지 먼저 본다. 관계있으면 작성자에게 돌려보낸다.
- 같은 종류의 가장자리 지적이 세 번째 리뷰까지 이어지면 하던 방식을 의심한다. 상류 도구의 내부 로직을 다시 구현하고 있다면 그 도구가 실제로 한 일을 관찰하는 방식으로 바꿀 수 있는지 따진다. 통과한 부분은 PR 을 나눠 먼저 머지한다.

## 7. 겹침 관리

- 여러 레인이 같은 파일을 고치면 머지 순서를 정한다. 뒤쪽 레인이 rebase 한다.
- 공유 번호 자원(ADR 번호 등)은 리드가 미리 나눠 지시서에 적는다.
- 다른 레인의 범위는 지시서에 "건드리지 않는다"로 명시한다.
- 레인마다 별도 worktree 를 쓴다. 위치는 저장소의 `.worktrees/` 아래다.

## 8. 사용자 결정

- 결정이 여러 개면 결정표 파일 하나로 모아 한 번에 묻는다. 열은 항목, 선택지, 권고, 근거다. 답은 같은 파일 끝에 기록한다.
- 전제가 바뀌면(예: 호출자가 사라짐) 이미 받은 답도 다시 묻는다.
- 되돌릴 수 없거나 권한 분류기가 막을 일은 결정표에 따로 표시한다.

## 9. 릴리스

- 버전 PR 을 머지하기 전에 모든 세션에 main 머지 보류를 요청하고, 게시와 설치본 교체가 끝나면 "보류 해제"를 알린다.
- 다음 버전에 들어갈 재료 파일을 계속 갱신한다.
- CHANGELOG 는 작성자와 다른 모델이 PR 실제 내용과 대조한다.
- 릴리스 절차 자체는 `tfx-ship`을 따른다.

## 10. 안전

- 실제 HOME 으로 전체 테스트를 돌리지 않는다. 개발 체크아웃에서 `npm ci`를 실행하지 않는다(ADR-0030). 필요하면 `npm ci --ignore-scripts`.
- 전체 테스트는 원격 격리 호스트에서 돌린다. 로컬에서는 변경 영역만 임시 HOME 으로 돌린다.
- 커밋과 PR 에 AI trailer, `Co-Authored-By`, 세션 링크를 넣지 않는다.
- 세션 닫기, 머지, 계정 전환처럼 권한 분류기가 막는 일은 사용자 허락을 받은 뒤에만 한다. 막힌 일을 다른 세션에 대신 시키지 않는다.
- 워크트리에서 도구를 실행하면 전역 설정을 그 경로로 덮어쓸 수 있다. 전역 경로를 쓰는 스크립트는 설치본에서만 실행한다.
- 워커와 리뷰어에게 실제 tmux 실측을 시킬 때는 지시서에 `tmux -L tfx-<이름>` 전용 소켓만 쓰고 `kill-server` 는 같은 `-L` 을 붙일 때만 하라고 적는다. 리드가 tmux 안에 있으면 워커 셸에 `TMUX` 가 상속되고, tmux 는 `$TMUX` 를 `TMUX_TMPDIR` 보다 우선하므로 `TMUX_TMPDIR` 격리는 사용자 기본 서버를 가리킬 수 있다. 2026-10-22 그렇게 실행한 `kill-server` 가 기본 서버를 두 번 죽여 모든 tmux 세션이 닫혔다.

## 11. 컨텍스트 점검

비율 기준은 `tfx-live` 스킬의 "컨텍스트 판단" 표를 따른다. 여기서는 재는 방법만 적는다.

- 가장 쉬운 방법은 `tfx-live probe`다. 결과의 `contextPct`를 본다.
- 직접 재야 하면 transcript 의 마지막 assistant 항목 `usage`에서 입력 계열 토큰(`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)을 더해 공식 모델 창과 실행 한도 중 작은 값으로 나눈다. Codex 는 rollout 의 마지막 토큰 사용량 이벤트로 같은 계산을 한다.
- 지시서에 보고 기준을 넣는다. 비율은 받는 세션의 CLI 에 맞춰 `tfx-live` 표의 준비·경고 열을 쓴다. 예: Claude 60%, Codex 15%, agy 12%. "컨텍스트가 <비율>을 넘으면 작업을 멈추고 리드에게 보고하라."
- 재개한 세션(`--resume`)은 이전 사용량을 이어받으므로 재개 직후 한 번 잰다.
- 85%에 닿은 Claude 세션에는 새 작업을 주지 않고 바로 승계한다.

## 12. 운영 점검표

리드를 맡을 때:

- [ ] `/tfx-lead <역할>`을 실행했고 이름이 바뀌었다(실패하면 `/rename`)
- [ ] 끝낼 때 `/tfx-pressure off`를 한다

워커를 띄울 때:

- [ ] 이름이 `<월>.<일> <주제>` 형식이고 등록 기록에 적었다
- [ ] 역할에 맞는 모델과 effort 를 골랐다
- [ ] 같은 역할, 주제의 살아 있는 전담 워커가 등록 기록에 있는지 먼저 찾았고, 있으면 컨텍스트를 재고 그 세션에 보냈다
- [ ] 재사용하거나 다시 올 일이면 서브에이전트 대신 전담 세션으로 띄워 등록 기록에 역할과 주제를 적었다
- [ ] Agent 도구 팀원을 띄우기 전에 리드 pane 폭을 쟀고, 200 cols 미만이면 `name` 없는 백그라운드 서브에이전트로 띄웠다
- [ ] Agent 도구 팀원을 tmux 모드로 띄운다면 리드의 현재 폴더가 신뢰된 폴더다
- [ ] 압박을 재고 실행 위치(m5/m2/ryzen)를 지시서에 적었다
- [ ] 사용자에게 모델과 tmux 세션명을 알렸다
- [ ] 지시서 경로를 보냈고 작업 시작을 확인했다
- [ ] 세션 CLI 에 맞는 컨텍스트 보고 기준이 지시서에 있다

워커를 닫을 때:

- [ ] 결과 파일을 읽었다
- [ ] 결과를 받은 팀원 pane 을 닫았다(3절 "끝난 팀원 닫기")
- [ ] 필요하면 인계 파일과 승계 ACK 를 확인했다
- [ ] 닫은 뒤 `tmr ls --json`(없으면 `tmux ls`)으로 확인하고 등록 기록에서 지웠다

## 13. 정리, 삭제, 결함 수정 레인

코드를 지우거나 간헐 실패를 고치는 레인의 지시서에 아래 기준을 넣는다.

- 무엇을 지울지는 사용자가 결정표로 정한다. 작업 세션은 정해진 것을 실행하고, 쓰임을 추측해 지우지 않는다.
- 제거 판정은 그 파일을 끝까지 읽은 뒤에만 한다. 파일명, grep 결과, 서브에이전트 요약은 단서일 뿐이다. 리드가 지시서에 적은 사실도 단서로 쓰라고 적는다.
- 지우는 기준은 "지우기 전과 동작이 같은가"다. 지시서에 비교할 기존 경로를 적고(예: 기능이 꺼져 있거나 비어 있을 때의 경로), 리뷰에서 그 동등성을 확인한다.
- 의존성은 코드 import 만 보지 말고 다른 패키지의 peer 의존과 지연 import 까지 확인한다.
- 간헐 실패는 재시도나 timeout 을 늘려 덮지 않는다. 재현해서 원인을 확정하고, 확정하지 못하면 고치지 않고 근거와 남은 후보만 결과 파일에 적는다.
- 원인을 확정한 수정에서 새 판정이 확신할 수 없는 값을 낼 때는, 안전성이 확인된 기존 폴백 경로로 돌아가게 한다. 틀린 확정보다 폴백이 낫다. 원인을 확정하지 못했으면 이 규칙을 쓰지 않고 위의 "고치지 않고 보고"를 따른다.
- 범위 밖에서 발견한 문제는 고치지 않고 목록으로 보고받는다. 리드가 다음 레인으로 배정한다.
