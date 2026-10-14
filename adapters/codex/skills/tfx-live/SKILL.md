---
name: tfx-live
description: >
  Claude·Codex·agy 세션을 실시간으로 생성·질의·대기·압축·종료하거나,
  tmux/daemon UDS 연결과 peer 중계를 운영할 때 사용한다.
argument-hint: "<start|ask|send|wait|queue|goal|compact|stop|rename|interrupt|probe|list-sessions|peer|converse|goal-driven> [--cli codex|claude|agy] ..."
---

# tfx-live

## Codex 호스트 계약

Codex에서는 `$tfx-live`로 호출한다. CLI의 `--cli`는 현재 호스트가 아니라 대상 세션을 선택한다.

`tfx-live`는 Claude Code와 Codex 세션을 tmux 또는 daemon UDS로, agy 세션을 로컬 tmux로 제어한다.
`tfx-live --help`와 `tfx-live <동사> --help`로 사용법을 확인한다.

## 전송 경로

- Claude `--short` 또는 `--session-id`는 기본 `auto`로 UDS를 먼저 시도한다. `--session`이 있고 입력 미전송이 확인된 UDS 실패라면 tmux로 전환하고 `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`을 남긴다. 컨텍스트 가드 거부 시에는 전환하지 않는다.
- Codex `ask`는 Codex 큐(app-server `thread/queue/add`)가 기본이다. 아래 "Codex 메시지 전송" 순서를 따른다. 기존 Codex thread의 UDS 연결은 `--transport uds --thread <id|auto>`를 명시한다.
- daemon 참조가 없는 Claude는 tmux가 기본이다.
- 보내는 쪽이 Claude이고 대상이 같은 기기의 Claude 세션이면 `ask` 대신 SendMessage 도구로 보낸다. `tfx-live`는 CLI라 SendMessage를 대신 보낼 수 없다. 대상의 SendMessage 이름은 `tfx-live list-sessions --cli claude` 결과의 `name`이고, 세션 ID 앞 8자리는 `short`로 맞춘다. 이름을 못 찾거나 원격 세션이면 `ask`를 쓴다. `start` 직후의 첫 지시도 SendMessage로 보낸다. 로컬 Claude `start` 결과의 `sendMessageTo`가 그 이름이다. Claude 안에서 로컬 Claude tmux 세션에 `ask`를 하면 보내지 않고 `reason: "use-send-message"`와 `sendMessageTo`를 돌려준다. 슬래시 명령은 SendMessage로 실행되지 않으므로 그대로 보내고, tmux 입력이 꼭 필요하면 `--via-tmux`를 붙인다.
- 같은 기기의 agy 끼리는 `~/.local/bin/agy.patch.json`의 `sha256`이 실제 `agy` 바이너리 해시와 같고 `patches`에 `peer-wake`가 있을 때만 `send_message`(대화 ID)를 쓰고, 아니면 `tfx-live ask`를 쓴다(쉬는 세션이 깨지 않는 공개 이슈 #1022 때문). `tfx-live send`의 agy 대상 전송은 tmux 경로를 유지한다.
- 세션 이름으로 다른 세션에 바로 보낼 때는 `tfx-live send --to <이름|cli:이름> --message <본문> [--from <보낸 세션 이름>] [--no-wait]`를 쓴다. `send`는 `list-sessions`의 `name`, `sessionName`, `sessionId`, `shortId`를 조회해 대상 CLI의 `ask` 경로로 전달하며 본문 앞에 `[from <발신 세션>]` 머리말을 붙인다.
- UDS 결과는 `matchedCompletion === true`일 때만 `done: true`다. timeout이나 연결 종료는 완료가 아니다.
- bridge 선택 순서는 `--bridge`, `$TFX_BRIDGE`, `$TFX_REPO_ROOT/hub/bridge.mjs`, 번들된 `hub/bridge.mjs`다.

```bash
tfx-live start --cli codex --session cx1 --cwd ~/Projects --name "10.8 구현 검토"
tfx-live ask --cli codex --session cx1 --prompt "현재 변경사항을 요약해줘" --timeout 120
tfx-live send --to "codex:10.8 구현 검토" --message "추가 검토 사항을 반영해줘" --no-wait
tfx-live stop --cli codex --session cx1
```

macOS의 iTerm2에서 로컬 tmux `start`는 프로젝트별 창에 attach 탭이나 패인을 연다. `LC_TERMINAL=iTerm2` 또는 `TERM_PROGRAM=iTerm.app`일 때만 적용하며 원격·daemon 경로와 리드 창을 찾지 못한 경우는 제외한다. 프로젝트 키는 git 공통 디렉터리의 실제 경로이므로 같은 저장소의 워크트리는 함께 묶이고, git 밖에서는 cwd의 실제 경로를 쓴다. 기존 프로젝트 창을 우선 쓰고, 없으면 다른 프로젝트 세션이 없는 리드 창을 쓰거나 새 창을 만든다. 기본 그룹은 프로젝트 키이며 `--group NAME`으로 바꾼다. 한 탭은 최대 4분할이며 2개는 세로, 3·4개는 2x2 배치로 나누고 그다음은 같은 창의 새 탭을 쓴다. `peer`는 실행마다 참여자들을 한 그룹에 모으며 `--group`을 주면 그 값을 쓴다. 로컬 tmux 제목은 `--name`, 자동 이름, 세션 이름 순으로 고정하고 기존 Python 제목 스크립트도 유지한다. `stop`은 저장된 iTerm ID가 없거나 유효하지 않으면 `user.tfx_session`으로 찾아 닫으며, 남은 패인이 tmux에 연결되지 않은 셸 프롬프트임을 확인할 때만 탭을 닫는다. 연동 실패는 시작·종료를 막지 않고 `itermWarning`에 남긴다.

새 세션 이름은 `<월>.<일> <주제>`로 짓는다. `start --name`을 생략하면 자동으로 만들고 `nameGenerated: true`를 보고한다. `--resume` 또는 `--resume-last`는 `--name`을 명시한 경우에만 이름을 적용한다. 승계 세션에는 기존 이름 뒤에 ` 2`, 이후 ` 3`을 붙인다. 이름 적용을 요청한 경우 결과의 `nameApplied: false`는 미적용을 뜻한다. agy의 `namePending: true`는 첫 일반 ask에서 적용할 이름이 보류됐다는 뜻이다. Codex `start`는 `/rename` 제출을 입력창이 빌 때까지 확인하고, 이름으로 찾은 thread UUID를 `threadId`로 돌려주며 tmux 세션 옵션 `@tfx_codex_thread`에 남긴다. 로컬 Codex `--resume-last`는 Codex가 고른 thread를 사후에 찾는다. 띄운 뒤 공유 app-server daemon에 로드된 같은 cwd의 thread 중 rollout에 그 시각 이후의 resume 기록(`thread_settings_applied`)이 생긴 것이 정확히 하나이고 1.5초 뒤에도 같을 때만 `threadId`로 쓴다. 이 확인은 5초 안에 끝난다. TUI가 daemon을 쓰지 않거나 같은 cwd에서 동시에 resume이 일어나면 `null`이다. 기존 Codex UDS thread는 `tfx-live rename --cli codex --transport uds --thread ID --name "<이름>"`으로 이름을 바꾼다.

Codex 폴더 신뢰 화면이나 Claude 프로젝트 MCP 승인 화면이 뜨면 `start`는 화면에 답하지 않고 `ready: false`, `blockedBy`(`codex-trust-folder` 또는 `claude-mcp-approval`), 할 일을 적은 `warning`을 반환한다. 세션은 남아 있으므로 tmux 세션에 붙어 직접 고른 뒤 지시를 보낸다.

Claude, agy, 예전 Codex 문구(`Do you trust the contents of this directory`)의 폴더 신뢰 화면은 기본으로 자동 승인한다. `start --no-auto-trust`를 주면 이 화면에도 키를 보내지 않고 같은 형식으로 `blockedBy`(`claude-trust-folder`, `agy-trust-folder`, `codex-trust-folder`)를 반환한다. `--resume`, `--resume-last`, `--remote`에도 똑같이 적용된다.

## agy 세션

```bash
tfx-live start --cli agy --session ag1 --cwd ~/Projects --name "10.11 구현 검토" --effort low --unset-env 'TOSSINVEST_*,PRIVATE_KEY'
tfx-live ask --cli agy --session ag1 --prompt "현재 변경사항을 요약해줘" --no-wait
tfx-live wait --cli agy --session ag1 --request-id <requestId> --timeout 120
tfx-live list-sessions --cli agy --cwd ~/Projects
tfx-live stop --cli agy --session ag1
```

`start`는 `--model ID`, `--effort low|medium|high|xhigh|max`, `--sandbox`를 agy에 넘긴다. `--sandbox`의 실효는 미검증이다. `--resume ID`와 `--resume-last 1`로 대화를 재개한다. 준비 뒤 `/rename <이름>`의 확인 문구가 보이면 `nameApplied: true`다. 새 대화는 첫 메시지 전 `/rename`이 실패하므로 이름을 tmux 옵션 `@tfx_agy_name`에 남기고 `nameApplied: false`, `namePending: true`로 보류한다. 첫 일반 ask는 제출 확인 뒤 현재 대화 DB에 사용자 step이 생길 때까지 최대 5초 기다리고, 유휴를 기다리지 않고 `/rename`을 보낸다. 확인 문구가 보이면 옵션을 지우고 `nameApplied: true`를 반환하며, 실패하면 옵션을 남기고 `nameApplied: false`를 반환한다. `--no-wait`에도 적용한다. 열린 presence lock에서 찾은 대화 ID는 `conversationId`로 보고한다.

agy `ask`의 기본 `--if-busy queue`는 바쁜 턴에도 바로 전송한다. agy 자체 대기열에 쌓이며 앞 입력을 덮어쓰지 않는다. `wait|fail|interrupt`도 선택할 수 있다. `ask --no-wait`는 `inputSent: true`, `requestId`와 함께 유휴 시 `status: "submitted"`, 바쁠 때 `status: "queued"`를 반환한다. `queue` 정책은 agy 전용이다. 슬래시 명령은 중계 표식 없이 보내고 바빠도 즉시 실행한다. DB step을 만들지 않아 `wait`로 추적하지 않으며, `--no-wait` 여부와 무관하게 제출 확인 뒤 `status: "submitted"`, `slashCommand: true`로 반환한다. `/clear`는 대화 ID를 바꾼다.

`wait`는 `node:sqlite`(Node 22.13+)로 대화 DB의 사용자 입력 표식과 뒤따르는 step 상태를 읽는다. 요청 뒤부터 다음 사용자 입력 전까지 모델 응답 step이 하나 이상 있고 그 구간의 모든 step이 끝났으며, pane이 유휴 상태이거나 다음 요청이 시작됐으면 완료다. 같은 구간의 마지막 비어 있지 않은 모델 텍스트를 응답으로 쓴다. Escape로 취소된 step도 완료 상태로 기록된다. 네트워크 오류처럼 턴이 오류 step으로 끝나고 모델 응답이 뒤따르지 않으면 `status: "failed"`와 화면 문구 `error`를 반환한다. agy는 이 오류에서 스스로 재시도하지 않으므로 같은 요청을 다시 보낸다. `--timeout 0`은 한 번만 확인한다. `/clear`는 대화 ID를 바꾸며 진행 중 `wait`는 처음 연 DB를 계속 본다. agy 설정의 `toolPermission`에 따라 도구 승인 화면이 뜰 수 있다. 승인을 기다리는 동안 턴이 멈추고 `wait`는 `working`으로 남는다. `tfx-live`는 agy에 `--dangerously-skip-permissions`를 쓰지 않는다. agy에는 compact가 없으므로 `/clear` 또는 handoff를 쓴다. `peer` relay는 로컬에서만 지원한다. `--remote`, `converse`, `goal-driven`은 지원하지 않는다.

`start --unset-env 'PREFIX_*,EXACT_NAME'`은 모든 CLI에 쓸 수 있다. 쉼표로 구분한 환경변수 이름과 끝의 `*`로 지정한 접두만 허용한다. tmux pane 셸의 환경에서 변수를 지우고 CLI를 실행하며 resume에도 적용한다. 로컬에서는 준비 후 CLI 프로세스 환경을 확인한다. macOS는 `ps -E` 출력에 `PATH=`가 있고 Linux는 `/proc/PID/environ`이 비어 있지 않을 때만 환경을 읽은 것으로 판정한다. 일치하는 변수가 실제로 남은 경우에만 생성한 세션을 종료하고 오류를 낸다. 환경을 읽지 못하면 세션을 유지하고 `unsetEnvVerified: false`, `unsetEnvWarning: "CLI environment unreadable; removal not verified"`를 반환한다. 결과의 `unsetEnv`는 요청 목록이고 `unsetEnvVerified`는 확인 여부다. 원격에서는 확인하지 않아 `false`이고 Windows에서는 이 옵션을 지원하지 않는다.

## 리드 운영

세션을 띄운 리드가 생성, 컨텍스트 관리, 수동 compact, 종료를 책임진다. 작업 연속성과 소유권을 먼저 판단하고 컨텍스트 비율은 개입 시점으로 쓴다. `--resume`은 이전 사용량을 유지하므로 재개 직후 compact 필요 여부를 확인한다.

| 동작 | 적용 조건과 실행 |
| --- | --- |
| compact | 같은 목표와 담당이 이어지고 파일과 git에서 상태를 복구할 수 있을 때. Claude와 Codex는 `tfx-live compact --then "다음 지시" --no-wait`로 압축 제출을 확인하고 다음 지시를 미리 넣는다. 압축 뒤에 필요한 파일 경로와 검증 명령도 `--then`에 싣는다. agy는 수동 compact가 없어 handoff한다. |
| clear | 무관한 작업으로 전환하거나 같은 문제를 두 번 넘게 고쳐도 실패할 때, 스펙에서 구현으로 또는 작성자에서 리뷰어로 바뀔 때. 미완료 상태를 정리한 뒤 Claude는 `/rename`과 `/clear`, Codex는 작업 종료 뒤 `/new <이름>`, agy는 `/clear`를 쓴다. |
| handoff | 담당·CLI·모델·소유자가 바뀌거나 긴 작업이 창을 넘길 때. 인계 파일에 목표, 완료 조건, 체크아웃과 변경 상태, 확정 결정, 증거 경로, PASS/FAIL/SKIP, 미완료 작업과 프로세스, 다음 행동과 소유자, `predecessorSessionId`를 적는다. 승계 세션이 경로를 확인하면 이전 세션을 닫는다. |
| close | 결과와 인계를 확인한 즉시 닫는다. Claude 백그라운드는 `claude stop <id>`, tmux는 `tfx-live stop --session`, Claude 팀원은 shutdown, Codex 서브에이전트는 `close_agent`(Codex 0.162.1 의 도구 목록에는 없다), agy 서브에이전트는 `/agents` 패널의 K를 쓴다. |

Claude TUI는 바쁠 때 들어온 입력을 대기열에 넣고 현재 턴(압축 포함)이 끝나면 순서대로 처리한다. transcript에는 `queue-operation`의 `enqueue`와 `dequeue`로 남는다. Codex app-server 큐도 바쁜 턴 뒤에 순서대로 처리한다. 리드는 compact를 보내고 `--then`으로 다음 지시를 넣는 것을 기본 절차로 쓴다.

두 번째 compact 전에는 handoff가 맞는지 점검한다. compact 횟수는 고정하지 않는다.

리드 역할 절차(역할별 모델, 지시서, 교차 리뷰, 릴리스 조율)는 `tfx-lead` 스킬을 따른다.

### Codex 메시지 전송

1. 기본은 app-server 실험 API `thread/queue/add`로 쌓는 것이다. 프롬프트가 프로세스 인자에 보이지 않는다. 입력창을 건드리지 않고, 바쁘면 쌓였다가 앞 턴이 끝난 직후 순서대로 들어간다. 유휴 TUI는 약 20초 주기로 큐를 가져간다. add가 없는 Codex에서만 `codex queue --thread <UUID> --message`로 보내며, 이때 프롬프트가 argv에 보이고 결과에 `queueVia: "codex-queue-argv"`와 `queueFallbackReason`이 남는다. 평소 값은 `queueVia: "app-server"`다.
2. 첫 줄 머리말은 `[from <보낸 세션 이름>] [tfx-live req=<id>]`다. 이름은 `--from`, `$TFX_LIVE_FROM`, Claude 세션 기록, Codex `session_index` 순으로 찾고 없으면 머리말 없이 표식만 붙인다. Codex TUI는 Claude처럼 접어 보여 주지 않고 사용자 입력으로 그대로 표시한다.
3. thread는 `--thread UUID`, `start`가 남긴 `@tfx_codex_thread`, Codex 세션 레지스트리, pane 프로세스의 `resume <UUID>` 인자, pane cwd와 같은 rollout 하나 순으로 찾는다. cwd 대응은 그 cwd의 Codex TUI가 하나일 때만 쓰고 exec 워커와 서브에이전트 thread는 뺀다. 이름으로는 보내지 않는다(`codex queue`의 이름 조회가 실패한다).
4. tmux 직접 입력은 queue를 못 쓸 때만 쓴다: 원격 호스트, thread를 못 찾음(`start` 밖에서 `resume --last`로 띄운 세션, `start --resume-last`의 `threadId: null`, 같은 cwd의 TUI 여럿 포함), `codex queue` 오류(0.160 미만 포함). 결과에 `transport: "tmux"`, `transportRequested: "queue"`, `fallbackReason`이 남는다. 시간 초과처럼 queue가 이미 쌓았을 수도 있는 오류는 `status: "unknown"`으로 끝내고 재전송하지 않는다.
5. 슬래시 명령(`/rename`, `/compact`, `/new`)과 interrupt(Escape)는 tmux 직접 입력 전용이다. queue로 보낸 슬래시 명령은 실행되지 않고 일반 텍스트로 모델에 들어간다. `/명령`으로 시작하는 프롬프트(절대 경로는 제외)와 `--if-busy fail|interrupt`는 tmux로 보내고 `transportReason`을 남긴다. 슬래시 명령에는 표식을 붙이지 않으므로 `wait`로 추적할 수 없다.

보내는 쪽이 Codex여도 같은 경로다. Codex가 셸에서 `tfx-live ask --cli codex`를 실행하면 되고, Codex 0.162.1 의 workspace-write 샌드박스에서 queue 전송과 상대 응답을 확인했다. Codex 협업 도구(`spawn_agent`, `send_message`, `followup_task`)는 자기가 띄운 하위 에이전트(`/root/...`)를 대상으로 한다. 다른 최상위 Codex 세션에 닿는지는 확인하지 않았다.

결과의 `status`는 `queued`(쌓임), `working`(TUI가 가져가 턴 시작), `completed`, `failed`로 나뉘고 `delivered`, `deliveredAt`, `turnId`가 배달을 구분한다. queue는 바쁜 세션에도 쌓으므로 `--if-busy wait`는 의미가 없다.

```bash
tfx-live queue --cli codex --session cx1
tfx-live queue --cli codex --session cx1 --request-id <requestId> --delete all
tfx-live queue --cli codex --thread <UUID> --delete <queuedMessageId>
```

`queue`는 TUI가 아직 가져가지 않은 항목을 보고 지운다. Codex app-server의 실험 API `thread/queue/list`·`thread/queue/delete`를 stdio로 호출하며 큐 저장소 파일은 건드리지 않는다. 목록 항목은 `id`(ask 결과의 `queuedMessageId`와 같다), `requestId`, `text`다. 삭제 결과의 `missing`은 이미 TUI가 가져갔거나 없는 항목이다. 유휴 TUI는 쌓인 항목을 곧 가져가므로 지울 수 있는 것은 사실상 바쁜 세션과 닫힌 세션의 항목이다. 가져간 뒤의 처리 여부는 `wait`로 확인한다.

### 네이티브 goal

```bash
tfx-live goal set --session cl1 --condition "관련 단위 테스트가 모두 통과한다"
tfx-live goal set --session cx1 --cli codex --condition "관련 단위 테스트가 모두 통과한다" --budget 100000
tfx-live goal status --session cx1
tfx-live goal clear --session cx1
```

`--cli`를 생략하면 세션 프로세스에서 추정한다. 로컬 Claude와 Codex만 지원하며 `--remote`와 agy는 거부한다. `--budget`은 Codex set의 daemon 경로에서만 받고 Claude와 tmux 폴백에서는 오류로 거부한다.

Claude는 tmux로 `/goal <조건>`과 `/goal clear`를 보내고 transcript의 마지막 `goal_status`로 상태를 읽는다. 별도 평가자의 완료는 `complete`, 수동 해제는 `none`이며 `judgedBy: "evaluator"`와 평가 이유를 보고한다. transcript를 찾지 못하면 상태는 `null`이고 경고를 남긴다. set/clear 뒤 새 sentinel을 최대 15초 확인하며 없으면 `confirmed: false`와 경고를 반환한다. 이미 해제된 goal의 clear는 입력 없이 `alreadyCleared: true`로 답한다. set은 기본 `--if-busy wait`, clear는 미충족 goal이 턴을 계속 이어 가도 끊을 수 있게 기본 `--if-busy interrupt`다. 평가자가 해제하지 않고 멈춘 goal은 `active`로 남으므로 리드가 `goal clear`로 정리한다.

Codex는 공유 daemon UDS의 `thread/goal/*`를 우선 쓴다. `--codex-socket PATH|default`로 소켓을 고르고 기존 thread 해석 순서와 `--thread UUID`를 따른다. 새 goal은 `origin: "user"`로 clear 후 active set한다. 소켓이 없거나 thread가 미적재면 set/clear는 tmux 슬래시로, status는 `$CODEX_HOME/goals_1.sqlite`의 읽기 전용 조회로 폴백한다. `node:sqlite`를 지원하지 않는 Node에서는 상태를 `null`로 두고 경고한다. 결과에 `transport: "daemon"|"tmux"|"sqlite"`와 폴백 이유를 남긴다. tmux 폴백의 set/clear는 sqlite로 최대 15초 확인하고, 확인하지 못하면 재전송을 막으려고 오류 대신 `confirmed: false`와 경고를 반환한다. Codex의 `judgedBy: "model"`, `complete`는 모델 자기 판정이므로 리드의 교차 검증이 필요하다.

Claude와 Codex는 네이티브 goal을 우선 쓰고, goal-driven은 agy처럼 네이티브 goal이 없을 때 쓰는 방식이다. 현재 agy의 goal-driven 실행은 지원하지 않는다.

### 컨텍스트 판단

Claude의 분모는 공식 모델 창과 실행 한도 중 작은 값이다. Codex의 분모는 rollout이 보고한 실행 창이고, 없을 때만 공식 창이다. 아래 비율은 공식 권고가 아닌 **[추론] 운영값**이다. 모델 문서가 바뀌면 한도도 갱신한다.

| CLI | 준비와 경고 | compact | 신규 배정 중지·handoff | 전송 거부 |
| --- | ---: | ---: | ---: | ---: |
| Claude Code 1M 모델 | 60% | 75% | 85% | 90% |
| Codex rollout 실행 창 | 60% | - | - | 85% |
| Codex 실행 창 없음(1.05M 분모) | 15% | 18% | 20% | 22% |
| agy | 12% | 없음 | 15% | 18% |

Claude는 85% 도달 시 바로 handoff를 지시한다. Codex 실행 창 행의 compact와 handoff 비율은 아직 정하지 않았다. agy 행은 운영 지침이며 agy도 `tfx-live` 전송 대상이지만 컨텍스트 비율은 자동으로 읽지 못해 `null`로 보고하고 가드를 건너뛴다. `model_context_window`와 `model_auto_compact_token_limit`은 올리지 않는다.

결과에는 `estimatedContextTokens`, `contextLimitTokens`, `contextLimitSource`, `contextPct`가 포함된다. Claude 실행 한도는 `executionContextLimitTokens`로 별도 보고하며 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`이면 200,000이다. Codex는 rollout `token_count`의 `model_context_window`를 `executionContextLimitTokens`로 보고한다. 이 값이 있으면 모델 표에 없는 모델이라도 그 창으로 판정하고, 없으면 1,050,000 표 값을 분모로 쓴다. 한도를 모르면 비율은 `null`로 두고 경고만 한다. 사용량이 없는 `probe`는 `context: null`이다. 컨텍스트를 확인하려면 직접 `tfx-live probe`를 실행한다. `interrupt`, 자동 `ask`의 daemon probe, `stop --short`는 transcript를 읽지 않는다.

`ask`의 `--warn-context-pct`와 `--max-context-pct`는 경고·거부 비율을 덮어쓰며 0이면 해당 가드를 끈다. 기본값은 표의 경고·전송 거부 열이다. Codex는 `executionContextLimitTokens`가 있으면 실행 창 행을, 없으면 1.05M 분모 행을 쓴다. 거부 결과는 `status: "failed"`, `done: false`, `context-limit`, 컨텍스트 필드와 적용한 거부 비율 `thresholdPct`를 돌려준다. 경고의 `thresholdPct`는 적용한 경고 비율이다. 자세한 근거와 실측은 [컨텍스트 정책 연구](../../docs/research/tfx-live-context-policy-2026-10.md)에 둔다.

### 수동 compact와 종료

```bash
tfx-live compact --cli claude --session cl1 --instructions "변경 파일과 검증 명령을 보존하라" --then "인계 파일을 읽고 검증을 이어가라" --no-wait
tfx-live compact --cli codex --session cx1 --then "src/main.mjs를 확인하고 지정된 단위 테스트를 실행하라" --no-wait
tfx-live wait --cli codex --session cx1 --request-id <then.requestId> --timeout 120
tfx-live stop --cli claude --short <8hex>
tfx-live stop --cli claude --session-id <id>
tfx-live stop --session cl1
```

tmux 안에서 도는 Claude 세션은 자기 자신도 compact 할 수 있다. 자기 턴이 도는 동안에는 세션이 바쁘므로, 백그라운드로 띄우고 `--if-busy wait`로 턴이 끝나기를 기다리게 한다. 기본 `fail`로 두면 턴이 끝나기 전에 거부된다. 결과는 파일에 남겨 다음 턴에 확인한다. 사용자에게 `/compact` 입력을 부탁하기 전에 이 방법을 쓴다.

```bash
tfx-live compact --session "$TMUX_PANE" --if-busy wait --busy-timeout 600 --instructions "상태 파일 경로와 남은 일을 보존하라" --then "상태 파일을 다시 읽고 이어가라" --no-wait > "${TMPDIR:-/tmp}/tfx-self-compact.json" 2>&1 &
```

`compact --session S [--cli claude|codex] [--instructions TEXT] [--then PROMPT] [--no-wait]`는 로컬 tmux에서 `/compact`를 중계 표식 없이 보낸다. CLI 기본값은 Claude다. `--instructions`는 Claude에서만 받으며 Codex는 인자를 받지 않아 거부한다. 기본 `--if-busy fail`이며 바쁜 세션에는 compact를 전송하지 않는다. UDS compact는 지원하지 않는다.

`--no-wait`는 압축 진행 표시 또는 새 완료 기록으로 제출을 확인한 뒤 반환한다. Codex에서 확인되지 않으면 Enter를 한 번 더 보내고, 그래도 확인되지 않으면 `--then`을 보내지 않고 오류로 끝낸다. `--then`은 일반 텍스트 지시만 받으며 슬래시 명령은 거부한다. 제출 확인 직후 Claude에는 표식을 붙여 tmux로 보내고 화면의 `queued messages` 또는 transcript의 `enqueue`로 확인한다. Claude 압축이 먼저 끝나 지시가 이미 처리에 들어갔으면 `then.queued: false, delivered: true`로 보고한다. Codex에는 기존 queue 경로로만 보내며 tmux로 전환하지 않는다. 결과의 `then.requestId`로 `wait --request-id`에서 압축 뒤 응답을 받는다.

`--no-wait`가 없으면 Claude의 새 `compact_boundary`, Codex rollout의 새 `compacted`까지 기다린다. 결과에 `compact: {submitted: true, done}`과 `then: {requestId, queued, transport}`를 추가하고 기존 `compacted`, `preTokens`, `postTokens`를 유지한다. 토큰 수는 기록에 있는 값만 보고하며 Codex의 압축 후 token_count가 아직 없으면 `postTokens`는 `null`이다. 시간 안에 완료 기록이 없으면 `compacted: false, timedOut: true`다.

`stop --short`와 `stop --session-id`는 `claude stop <id>`를 호출하고 `stopped: true, conversationKept: true`를 반환한다. `claude attach`로 대화를 재개할 수 있다. `/exit`, `←`, Ctrl+Z는 백그라운드 세션의 연결만 끊는다. macOS의 `sysctl -n kern.memorystatus_vm_pressure_level`이 2 이상이면 새 세션을 띄우기 전 정리한다. 원격 배정 전에는 `tfx-remote probe <host>`의 `ready`와 `warnings`를 확인한다.

## 요청과 완료 확인

```bash
tfx-live ask --cli claude --transport uds --short <8hex> --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli claude --short <8hex> --request-id <requestId> --timeout 120 --poll-interval 500
tfx-live ask --cli claude --session cl1 --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli claude --session cl1 --request-id <requestId> --timeout 120
tfx-live ask --cli codex --session cx1 --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli codex --session cx1 --request-id <requestId> --timeout 120
```

`ask --no-wait`는 Claude와 tmux에서 `status: "submitted"`, Codex queue에서 `status: "queued"`와 함께 `inputSent: true`, `done: false`, `submittedAt`, `target`, `requestId`를 반환한다. `ask`, `peer`, `converse`, `goal-driven`은 `[tfx-live req=<requestId>]`를 프롬프트 앞에 붙인다. `--no-relay-tag`로 제거하면 `wait --request-id`가 해당 요청을 찾을 수 없다. 슬래시 명령(`/rename`, `/clear` 등)은 CLI와 상관없이 표식 없이 보낸다. 응답 턴이 없는 Claude 내장 명령(`/rename`, `/clear`, `/compact`, `/model`, `/effort`, `/color`)은 기다리지 않고 `status: "submitted"`로 반환한다. 압축 완료까지 기다리려면 `compact` 명령을 쓴다.

`wait`는 Claude transcript에서 표식을 user 메시지, `queue-operation`의 `enqueue` content, queued command attachment에서 찾는다. 표식이 소비된 턴이 끝난 뒤 마지막 assistant 텍스트를 응답으로 쓴다. 표식 없는 `wait`는 최신 user turn을 본다. `isSidechain`과 합성 API 오류 메시지는 정상 응답에서 제외한다. 요청을 소비한 턴에서 합성 오류가 나타나면 오류 문구와 `status: "failed"`를 반환한다. daemon의 `idle`만으로 완료를 단정하지 않는다. timeout은 `status: "working"`, `timedOut: true`, `done: false`다.

tmux로 띄운 대화형 Claude는 `wait --session <tmux 대상>`을 쓴다. pane에 붙은 Claude 세션 기록(`~/.claude/sessions`)에서 sessionId를 찾아 같은 transcript 규칙으로 판정하고, daemon의 idle 대신 세션 기록의 `status: "idle"`을 쓴다. transcript는 처음 찾은 것을 끝까지 쓰므로 대기 중 `/clear`로 바뀐 세션은 따라가지 않는다. 로컬 전용이다.

Codex `wait`는 `--session` 또는 `--thread UUID`의 rollout에서 표식이 든 user 메시지의 `turn_id`를 찾고, 같은 턴의 `task_complete.last_agent_message`를 응답으로 쓴다. `turn_aborted`는 `status: "failed"`다. 표식이 아직 없으면 `status: "queued"`, `timedOut: true`다. `--timeout 0`은 한 번만 확인한다.

명시한 `--config-dir`은 정확히 일치하는 daemon만 선택한다. `CLAUDE_CONFIG_DIR`도 해당 env 디렉터리로 제한한다. stale endpoint 복구는 같은 source configDir 안에서만 재시도한다. attach 전 예외는 `inputSent: false`이므로 `auto`의 tmux fallback이 가능하다. attach 뒤 전송 여부가 불명확하면 `status: "unknown"`으로 보고하고 재전송하지 않는다.

직접 `tmux capture-pane`과 `tmux send-keys`를 쓸 때는 전송·pane 진단에 한정한다. Claude pane에 `C-c`를 보내지 않는다. 자동 세션 탐색에는 `tmr ls --json`으로 pane 별 에이전트, 상태, 클라이언트 수, 마지막 활동을 본다. tmr 이 없으면 아래 `tfx-live list-sessions`와 `tmux ls -F '#{session_name} #{session_attached}'`를 쓴다. tmr 은 macOS(arm64) 에서 `tfx setup` 이 설치를 묻는다.

## 세션 탐색과 연결

`tfx-live probe`는 Claude daemon을 찾는다. `tfx-live list-sessions --cli codex [--cwd DIR]`는 기존 Codex tmux pane을 찾고 `target`, `cwd`, `command`, `threadId`, `name` 등을 보고한다. `--cwd`는 pane 경로와 정확히 일치해야 한다. `tfx-live list-sessions --cli claude [--cwd DIR]`는 살아 있는 Claude pane만 찾는다. `--remote`와 `--transport uds`는 Claude tmux 탐색에 쓸 수 없다.

`ask`와 tmux `interrupt`는 세션명, `name:window`, `name:window.pane`을 받는다. `start`와 tmux `stop --session`은 세션명만 받는다. `stop`은 pane·window 대상과 `%12`, `@3` 같은 ID를 거부한다. `--remote HOST`는 대상을 그대로 원격에 전달한다.

tmux `ask`는 pane의 작업 상태와 Codex `model: loading`을 확인한다. tmux의 `--if-busy wait|fail|interrupt` 기본값은 `wait`다. `--busy-timeout` 기본값은 `--timeout`이고 `--poll-interval`은 밀리초다. timeout이면 프롬프트를 보내지 않는다. `interrupt`는 Escape 후 idle을 기다린다. 기존 입력 초안이 있으면 붙여넣기와 합쳐질 수 있으므로 전송 전 pane을 확인한다.

### Codex UDS 스레드

공유 daemon 소켓 기본값은 `$CODEX_HOME/app-server-control/app-server-control.sock`이며 `CODEX_HOME`이 없으면 `~/.codex` 아래를 쓴다. `--codex-socket PATH|default`로 기존 소켓을 선택한다. 없으면 `codex app-server daemon start`로 시작한다.

```bash
tfx-live list-sessions --cli codex --transport uds --cwd ~/Projects/my-worktree
tfx-live ask --cli codex --transport uds --thread auto --cwd ~/Projects/my-worktree --prompt "현재 변경사항을 요약해줘" --if-busy wait --timeout 120
```

`--thread auto`는 선택 조건에 맞는 로드된 thread가 정확히 하나일 때만 쓴다. 여러 개면 목록에서 ID를 골라 `--thread ID`를 지정한다. UDS의 `--if-busy wait|fail|steer` 기본값은 `wait`다. `thread/resume`으로 알림을 구독한 뒤 `turn/start`를 호출하고 반환된 turn ID의 완료만 인정한다. 완료 응답은 `final_answer`를 우선하고 중간 commentary는 따로 반환한다. `--max-turn`은 활동 연장 상한을 지정한다. Codex UDS `interrupt`는 지원하지 않으므로 tmux pane이 있으면 `interrupt --session <target>`을 쓴다.

## peer

```bash
tfx-live peer --cli-a codex --cli-b claude --session-a cx-peer --session-b cl-peer --cwd ~/Projects --mode freeform --seed "변경을 함께 검토해줘" --rounds 2 --timeout 180
tfx-live peer --cli-a codex --transport-a uds --thread-a <id|auto> --cli-b claude --transport-b uds --short-b <8hex> --cwd ~/Projects/my-worktree --mode freeform --seed "변경을 검토해줘"
tfx-live peer --via message --cli-a claude --cli-b claude --session-a cl-a --session-b cl-b --attach-a --attach-b --seed "변경을 함께 검토해줘" --rounds 3
tfx-live peer --cli-a codex --cli-b claude --cli-c agy --session-c peerC --mode freeform --seed "변경을 함께 검토해줘" --rounds 2
tfx-live peer --cli-a codex --cli-b claude --mode debate --seed "변경을 검토하고 수정한 입장을 제시해줘" --rounds 2
```

`peer`는 이전 응답을 반대쪽의 다음 프롬프트로 전달한다. 기존 tmux pane은 `--attach-a`·`--attach-b`로 연결하며 종료하지 않는다. UDS 쪽도 기존 세션으로 취급한다. Codex 쪽은 `ask`와 같이 queue가 기본이고 응답은 rollout에서 읽는다. thread를 못 찾으면 tmux 직접 입력으로 바꾸고 hop에 `fallbackReason`을 남긴다. `--remote`이거나 `--if-busy fail|interrupt`이면 처음부터 tmux로 보낸다. `--if-busy-a`·`--if-busy-b`로 각 쪽의 정책을 정한다. 소유한 세션을 실제 종료한 경우에만 `stoppedA`·`stoppedB`가 참이다.

`--cli-c`를 지정하면 A, B, C 순서로 진행하며 한 라운드는 세 hop이다. C의 기본 세션은 `peerC`이며 `--session-c`, `--model-c`, `--effort-c`, `--attach-c`, `--transport-c`, `--if-busy-c`, `--short-c`, `--session-id-c`, `--thread-c`, `--codex-socket-c`, `--bridge-c`를 받는다. 각 hop과 마지막 closure에는 다른 두 참여자의 최근 답을 `Participant A`, `Participant B`, `Participant C`로 표시한다. C의 연결과 종료 여부는 `attachedC`, `stoppedC`로 보고한다. C는 relay에서만 쓴다.

`--mode debate`는 첫 hop에 seed를 보내고 이후에는 다른 참여자의 최근 답을 검토하여 동의와 이견의 이유 및 수정한 입장을 요구한다. 2자와 3자 모두에서 쓰며 답의 길이는 제한하지 않는다. 마지막 hop은 기존과 같은 closure 차례다.

Claude끼리는 `--via message`를 쓴다. tfx-live는 양쪽에 상대 세션 이름과 끝낼 조건을 한 번씩 보내고 `status: "started"`로 바로 끝난다. 그 뒤 두 세션은 `SendMessage`로 직접 주고받는다. 왕복 횟수는 `--rounds`를 지시문으로만 전하므로 tfx-live가 강제하지 않는다. transcript도 남기지 않는다. A는 끝나면 합의 JSON을 `--report-to` 세션에 `SendMessage`로 보낸다. `--report-to`가 없으면 tfx-live를 호출한 Claude 세션에 보내고, 그 세션도 찾지 못하면 A 세션 화면에 남긴다. 띄운 세션은 대화가 이어지도록 종료하지 않으므로 끝나면 `stop`으로 닫는다. 로컬 tmux 대화형 Claude만 지원하고 세션 이름을 찾지 못하면 실패한다.

## 진단

```bash
tfx-live --help
tfx-live probe
tfx-live list-sessions --cli codex
```

`auto`가 tmux로 전환되면 `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`을 확인한다. 테스트에서는 `$TFX_LIVE_BUG_REPORT_DIR`로 위치를 바꿀 수 있다.
