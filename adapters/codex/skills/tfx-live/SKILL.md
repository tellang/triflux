---
name: tfx-live
description: >
  Claude·Codex·agy 세션을 실시간으로 생성·질의·대기·압축·종료하거나,
  tmux/daemon UDS 연결과 peer 중계를 운영할 때 사용한다.
argument-hint: "<start|ask|send|wait|queue|goal|compact|clear|stop|rename|interrupt|probe|inspect|reconcile|list-sessions|peer> [--cli codex|claude|agy] ..."
---

# tfx-live

## Codex 호스트 계약

Codex에서는 `$tfx-live`로 호출한다. CLI의 `--cli`는 현재 호스트가 아니라 대상 세션을 선택한다.

`tfx-live`는 Claude Code와 Codex 세션을 tmux 또는 daemon UDS로, agy 세션을 로컬 tmux로 제어한다.
`tfx-live --help`와 `tfx-live <동사> --help`로 사용법을 확인한다.

## 상시 규칙

compact 뒤에는 스킬마다 앞부분만 다시 붙고, 한 세션에서 여러 스킬을 호출했으면 오래된 스킬은 통째로 빠질 수 있다. 이 절이나 아래 절이 문맥에 없으면 이 스킬 파일을 다시 읽는다. 괄호 안은 상세 절이다.

- 로컬 Claude 끼리는 `SendMessage`, 그 밖의 로컬 대상은 어댑터가 설치된 macOS/Linux 에서 `<홈 절대경로>/.claude/scripts/tfx-peer send`를 쓴다. Windows 는 Claude 대상만 지원한다. 원격 피어에는 `tfx-peer remote-send`, 원격 세션에 사용자 입력으로 보낼 때만 `tfx-live ask`를 쓴다. native 전송 실패를 tmux 입력으로 바꾸지 않는다("전송 경로", "원격 native peer 발신과 회신").
- 새 agy 세션의 첫 입력은 `tfx-live ask --no-wait`로 보낸다. 같은 기기 agy 끼리의 피어 전송은 `peer-wake` 패치가 확인될 때만 쓴다("전송 경로").
- 표식이 붙은 로컬 요청은 `ask --no-wait` 뒤 `wait --request-id`로 확인한다. 원격 요청, 슬래시 명령, `--no-relay-tag` 요청은 이 방법으로 추적하지 못한다. `submitted`, `queued`, `inputSent`, `written`, `sent`는 완료가 아니다("요청과 완료 확인").
- `unknown`, `partial`, `timedOut`은 자동 재전송하지 않고 상태부터 확인한다.
- Codex 슬래시 명령과 interrupt 는 tmux 직접 입력만 된다. queue 로 보낸 슬래시는 실행되지 않는다("Codex ask 메시지 전송").
- `ready: false`와 `blockedBy`가 오면 키와 지시를 보내지 않는다. MCP 승인과 훅 검토는 사람이 attach 해 처리한다.
- 공유 daemon 에 로드된 Codex thread 에 `start --resume`을 반복하거나, 새 thread 를 만들거나, daemon 을 재시작하지 않는다. 권한 readback 은 다음 턴 적용 증거가 아니다.
- 컨텍스트는 "컨텍스트 판단" 표를 쓴다. Claude 85% 는 바로 handoff, agy 12% 는 한 번 보고하고 계속한다. `--resume`한 세션은 재개 직후 잰다.
- 같은 목표가 이어지면 compact, 담당, CLI, 모델이 바뀌면 handoff 다. 결과와 인계를 확인하면 바로 닫는다("리드 운영").
- 리드 자기 세션의 compact, clear, exit 는 `tfx_control`을 먼저 쓴다. 도구가 없으면 compact 와 clear 만 `tfx-live compact`, `tfx-live clear`를 `--if-busy wait`로 백그라운드에 보낸다("수동 compact와 종료").
- Claude pane 에 `C-c`를 보내지 않는다.

## 전송 경로

- Claude `--short` 또는 `--session-id`는 기본 `auto`로 UDS를 먼저 시도한다. `--session`이 있고 입력 미전송이 확인된 UDS 실패라면 tmux로 전환하고 `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`을 남긴다. 컨텍스트 가드 거부 시에는 전환하지 않는다.
- Codex `ask`는 Codex 큐(app-server `thread/queue/add`)가 기본이다. 아래 "Codex ask 메시지 전송" 순서를 따른다. 기존 Codex thread의 UDS 연결은 `--transport uds --thread <id|auto>`를 명시한다.
- daemon 참조가 없는 Claude는 tmux가 기본이다.
- 어댑터가 설치된 로컬 Claude, Codex, agy 대상은 native 피어를 먼저 쓴다. Claude끼리는 `SendMessage(to: "<이름>")`, 그 밖의 로컬 Claude, Codex, agy 대상은 `<홈 절대경로>/.claude/scripts/tfx-peer send --to '<cli>:<정확한 이름>' --message '<본문>'`을 쓴다. native 전송 실패는 그대로 반환하며 tmux 입력으로 전환하지 않는다. 어댑터 미설치 폴백은 없다.
- Claude 대상의 SendMessage 이름은 `tfx-live list-sessions --cli claude` 결과의 `name`이다. `start` 직후의 첫 지시도 결과의 `sendMessageTo`로 보낸다. 이름을 못 찾으면 실패를 확인하고 이름을 다시 찾는다. 로컬 Claude끼리 `ask`하면 `reason: "use-send-message"`와 `sendMessageTo`를 반환한다. 원격 세션은 `tfx-live ask`로 보낸다.
- 같은 기기의 agy 끼리는 `~/.local/bin/agy.patch.json`의 `sha256`이 실제 `agy` 바이너리 해시와 같고 `patches`에 `peer-wake`가 있을 때만 `tfx-peer send --to 'agy:<이름>'` 또는 `send_message`(대화 ID)를 쓰고, 아니면 `tfx-live ask`를 쓴다(쉬는 세션이 깨지 않는 공개 이슈 #1022 때문). 첫 입력 전 새 agy 세션은 `conversationId`가 없으므로 첫 지시는 `tfx-live ask --cli agy --session <세션> --prompt '<본문>' --no-wait`로 보내고 대화 ID가 생긴 뒤부터 native 피어를 쓴다. `tfx-live send --via-tmux`의 agy 대상 전송은 tmux 경로를 유지한다.
- `tfx-live send`는 로컬 Claude, Codex, agy 대상에 기본으로 `reason: "use-tfx-peer"`를 돌려주고 `tfx-peer send`로 안내한다. `--via-tmux`를 붙일 때만 tmux 경로로 보내며 본문 첫 줄에 `[tfx-peer from=<cli>:<보낸 이름> msg=<id>]`, 끝에 발신 CLI에 맞는 회신 안내를 붙인다. 원격은 지원하지 않는다.
- Claude의 `SendMessage`에서 `to: "codex:<이름>"`, `to: "agy:<이름>"`, `to: "antigravity:<이름>"`은 mods가 native 피어 경로(`tfx-peer send`)로 전달한다.
- UDS 결과는 `matchedCompletion === true`일 때만 `done: true`다. timeout이나 연결 종료는 완료가 아니다.
- bridge 선택 순서는 `--bridge`, `$TFX_BRIDGE`, `$TFX_REPO_ROOT/hub/bridge.mjs`, 번들된 `hub/bridge.mjs`다.

```bash
tfx-live start --cli codex --session cx1 --cwd ~/Projects --name "10.8 구현 검토"
"$HOME/.claude/scripts/tfx-peer" send --to 'codex:10.8 구현 검토' --message '현재 변경사항을 요약해줘'
"$HOME/.claude/scripts/tfx-peer" send --to 'agy:10.8 구현' --message '추가 검토 사항을 반영해줘'
tfx-live stop --cli codex --session cx1
```

macOS iTerm2 에서 로컬 tmux `start`는 프로젝트별 창에 attach 탭이나 pane 을 자동 배치한다. 연동 실패는 시작과 종료를 막지 않고 `itermWarning`에 남는다. 프로젝트 키, 그룹, 제목, `stop`이 닫는 범위는 [references/window-layout.md](references/window-layout.md)를 따른다.

새 세션 이름은 `<월>.<일> <주제>`로 짓는다. `start --name`을 생략하면 자동으로 만들고 `nameGenerated: true`를 보고한다. `--resume` 또는 `--resume-last`는 `--name`을 명시한 경우에만 이름을 적용한다. 승계 세션에는 기존 이름 뒤에 ` 2`, 이후 ` 3`을 붙인다. 이름 적용을 요청한 경우 결과의 `nameApplied: false`는 미적용을 뜻한다. agy의 `namePending: true`는 첫 일반 ask에서 적용할 이름이 보류됐다는 뜻이다. Codex `start`는 `/rename` 제출을 입력창이 빌 때까지 확인하고, 이름으로 찾은 thread UUID를 `threadId`로 돌려주며 tmux 세션 옵션 `@tfx_codex_thread`에 남긴다. 로컬 Codex `--resume-last`는 Codex가 고른 thread를 사후에 찾는다. 띄운 뒤 공유 app-server daemon에 로드된 같은 cwd의 thread 중 rollout에 그 시각 이후의 resume 기록(`thread_settings_applied`)이 생긴 것이 정확히 하나이고 1.5초 뒤에도 같을 때만 `threadId`로 쓴다. 이 확인은 5초 안에 끝난다. TUI가 daemon을 쓰지 않거나 같은 cwd에서 동시에 resume이 일어나면 `null`이다. 기존 Codex UDS thread는 `tfx-live rename --cli codex --transport uds --thread ID --name "<이름>"`으로 이름을 바꾼다.

Claude 프로젝트 MCP 승인 화면이 뜨면 `start`는 화면에 답하지 않고 `ready: false`, `blockedBy: "claude-mcp-approval"`, 할 일을 적은 `warning`을 반환한다. 세션은 남아 있으므로 tmux 세션에 붙어 직접 고른 뒤 지시를 보낸다. Codex 훅 검토 화면도 선택 항목과 관계없이 키를 보내지 않고 `ready: false`, `blockedBy: "codex-hooks-review"`와 trust를 자동 승인하지 않았다는 `warning`을 반환한다. `--resume`, `--resume-last`, 명시 launcher와 `--remote`에서도 세션을 남기므로 attach 후 훅을 직접 검토한다.

Claude, agy, Codex(`Trust this folder?`와 `Do you trust the contents of this directory`)의 폴더 신뢰 화면은 기본으로 자동 승인한다. Codex는 신뢰 결정을 설정에 기록하므로 이후 같은 폴더의 실행에도 적용된다. `start --no-auto-trust`를 주면 이 화면에도 키를 보내지 않고 같은 형식으로 `blockedBy`(`claude-trust-folder`, `agy-trust-folder`, `codex-trust-folder`)를 반환한다. `--resume`, `--resume-last`, `--remote`에도 똑같이 적용된다.

Codex `start --model`의 가족 별칭은 호출 호스트에서 실제 모델 ID 로 해석한다. 로컬 새 thread 는 Full Access 가 기본이고 `--sandbox`로 제한한다. 관리 TUI 는 `--dangerously-bypass-hook-trust`가 기본이고 `--no-bypass-hook-trust`로 끈다. 공유 daemon 에 로드된 thread 는 `start --resume`을 거부하므로 기존 TUI 의 `/permissions`로 권한을 고른다. 모델 해석 순서, hook trust opt-out, 권한 readback 필드, 복구 절차는 [references/codex-sessions.md](references/codex-sessions.md)를 따른다.

## 창 배치(macOS)

Jev 가 작업과 역할로 iTerm2 배치 후보를 고르고, 기본은 현재 포커스를 지킨다. `--layout`, `--focus`, `--background` 옵션, 최소 가독성 크기, watcher, `inspect`와 `reconcile` 결과 필드는 [references/window-layout.md](references/window-layout.md)를 따른다.

## agy 세션

```bash
tfx-live start --cli agy --session ag1 --cwd ~/Projects --name "10.11 구현 검토" --effort low --unset-env 'TOSSINVEST_*,PRIVATE_KEY'
tfx-live ask --cli agy --session ag1 --prompt "현재 변경사항을 요약해줘" --no-wait
tfx-live wait --cli agy --session ag1 --request-id <requestId> --timeout 120
tfx-live list-sessions --cli agy --cwd ~/Projects
tfx-live stop --cli agy --session ag1
```

`start` 옵션과 이름 보류, `ask`의 대기열 정책과 슬래시 명령, `wait` 완료 판정, 모든 CLI 에 쓰는 `start --unset-env`의 확인 규칙은 [references/agy-sessions.md](references/agy-sessions.md)를 따른다.

## 리드 운영

세션을 띄운 리드가 생성, 컨텍스트 관리, 수동 compact, 종료를 책임진다. 작업 연속성과 소유권을 먼저 판단하고 컨텍스트 비율은 개입 시점으로 쓴다. `--resume`은 이전 사용량을 유지하므로 재개 직후 compact 필요 여부를 확인한다.

| 동작 | 적용 조건과 실행 |
| --- | --- |
| compact | 같은 목표와 담당이 이어지고 파일과 git에서 상태를 복구할 수 있을 때. Claude와 Codex는 `tfx-live compact --then "다음 지시" --no-wait`로 압축 제출을 확인하고 다음 지시를 미리 넣는다. 압축 뒤에 필요한 파일 경로와 검증 명령도 `--then`에 싣는다. agy는 CLI의 `/compact`를 지원하지만 `tfx-live compact` 중계는 미지원이라 `ask --prompt "/compact <다음 지시>"` 또는 handoff를 쓴다. |
| clear | 무관한 작업으로 전환하거나 같은 문제를 두 번 넘게 고쳐도 실패할 때, 스펙에서 구현으로 또는 작성자에서 리뷰어로 바뀔 때. 미완료 상태를 정리한 뒤 Claude는 `/rename`과 `/clear`를 리드가 `tfx-live ask --session <대상>` 으로 보낸다(relay 태그 없이). 리드 자기 세션은 `tfx-lead` 스킬의 `references/self-session-control.md`를 따라 `tfx_control` 도구를 쓰고, 도구가 없는 Codex 리드와 agy 리드는 `tfx-live clear`를 쓴다. 다른 세션은 `tfx-live clear --cli claude|codex|agy --session <대상>`로 Claude와 agy에 `/clear`, Codex에 `/new`를 보낸다. |
| handoff | 담당·CLI·모델·소유자가 바뀌거나 긴 작업이 창을 넘길 때. 인계 파일에 목표, 완료 조건, 체크아웃과 변경 상태, 확정 결정, 증거 경로, PASS/FAIL/SKIP, 미완료 작업과 프로세스, 다음 행동과 소유자, `predecessorSessionId`를 적는다. 승계 세션이 경로를 확인하면 이전 세션을 닫는다. |
| close | 결과와 인계를 확인한 즉시 닫는다. Claude 백그라운드는 `claude stop <id>`, tmux는 `tfx-live stop --session`, Claude 팀원은 shutdown, Codex 서브에이전트는 `close_agent`(Codex 0.162.1 의 도구 목록에는 없다), agy 서브에이전트는 `/agents` 패널의 K를 쓴다. |

Claude TUI는 바쁠 때 들어온 입력을 대기열에 넣고 현재 턴(압축 포함)이 끝나면 순서대로 처리한다. transcript에는 `queue-operation`의 `enqueue`와 `dequeue`로 남는다. Codex 큐의 기록 성공과 실제 처리 완료는 별개다. 리드는 compact를 보내고 `--then`으로 다음 지시를 넣는 것을 기본 절차로 쓴다.

두 번째 compact 전에는 handoff가 맞는지 점검한다. compact 횟수는 고정하지 않는다.

### 대상별 제어 지원

리드(Claude)는 compact, clear, exit 를 triflux mod 도구 `tfx_control` 하나로 보낸다. `/tfx-lead <역할>` 을 실행한 세션의 메인 대화에서만 쓸 수 있다. `target` 으로 대상을 고르고, 안 되는 조합은 도구가 이유와 대안을 오류로 반환한다. 자기 세션의 인자와 절차는 `tfx-lead` 스킬의 `references/self-session-control.md`다.

| target | compact | clear | exit | 받는 쪽 검증 | 조건과 이유 |
| --- | --- | --- | --- | --- | --- |
| `self` | 됨 | 됨 | 됨(`handoff` 필수) | 해당 없음 | 턴이 끝난 뒤 mod 가 `$.command.run` 으로 실행한다. tmux 안팎 같다 |
| `claude:<이름>`, 이 기기 tmux 에서 찾음 | 됨(바쁘면 유휴까지 기다림) | 됨 | 됨 | 없음. 같은 사용자의 tmux 접근 권한뿐 | `tfx-live list-sessions --cli claude` 의 `name` 이나 tmux 세션 이름과 맞으면 `tfx-live compact --if-busy wait`, `clear --if-busy wait`, `stop` 으로 보낸다. 나중에 adopt 한 세션도 이 경로다 |
| `claude:<이름>`, 피어 경로(tmux 에서 못 찾음), `tfx-live start --lead-session <ID>` 로 띄움 | 됨 | 됨 | 됨(`handoff` 필수) | 발신 리드 검사, plugin 출처, 띄운 리드 묶기 | `[tfx-control] {...}` 표식 피어 메시지를 보내고, 받는 쪽 triflux mod 가 자기를 띄운 리드의 요청일 때만 자기 턴이 끝난 뒤 실행한다. 도구 결과는 전송만 확인한 것이다. "[tfx_control] /<action> 완료" 알림이 오면 실행됐다. 완료 알림이 오지 않으면 받는 쪽 mod 없음 |
| `claude:<이름>`, 피어 경로, 리드가 띄우지 않음(`claude --bg`, 사용자가 연 세션, adopt 한 세션) | 안 됨 | 안 됨 | 안 됨 | 저장된 리드 없음 | 띄울 때 `TFX_LEAD_SESSION_ID` 가 넘어가지 않아 받는 쪽이 모두 거부하고 "리드가 띄운 세션이 아니다" 를 알린다. 선착순 묶기는 넣지 않는다. tmux 안이면 위 tmux 경로를 쓴다 |
| `codex:<tmux 세션>` | 됨(`instructions` 안 됨) | 됨(`/new`) | 됨(`tfx-live stop`) | 없음. 받는 쪽 mod 가 없어 tmux 접근 권한뿐 | tmux 직접 입력만 된다. `tfx-live clear --if-busy wait` 로 `/new` 와 인계 줄, `then` 을 보낸다. queue 는 슬래시를 실행하지 않아 tmux 밖 Codex 는 안 됨 |
| `agy:<tmux 세션>` | 안 됨 | 됨 | 됨(`tfx-live stop`) | 없음. tmux 접근 권한뿐 | agy CLI 는 `/compact` 를 지원하지만 `tfx_control` 중계는 미지원이다. `clear` 를 쓰거나 `tfx-live ask --cli agy --session <세션> --prompt "/compact <다음 지시>"` 로 보낸다 |
| `subagent:<이름>` | 안 됨 | 안 됨 | 안 됨 | 해당 없음 | 슬래시 입력창이 없고 mod API 에 서브에이전트를 압축하거나 멈추는 함수가 없다. 끝내기는 결과를 받고 닫는다(백그라운드는 TaskStop, 팀원은 `tfx-lead` 스킬 3절 "끝난 팀원 닫기" 절차). 문맥 줄이기는 요약을 넘겨 새 서브에이전트를 띄운다 |

- 리드 세션 ID 는 `action: "whoami"` 로 얻는다. Claude 워커는 `tfx-live start --cli claude ... --lead-session <ID>` 로 띄운다. 그 값은 워커 환경의 `TFX_LEAD_SESSION_ID` 로 넘어가고 받는 쪽 mod 가 저장한다.
- 리드를 넘길 때는 원 리드가 워커마다 `action: "rebind"`, `target: "claude:<이름>"`, `lead: "<새 리드 세션 ID>"` 를 보낸다. 받는 쪽은 지금 묶인 리드에게서 온 rebind 만 받는다. 원 리드가 이미 죽었으면 tmux 안 워커는 tmux 경로로 제어하고, tmux 밖 워커는 다시 띄운다.
- clear 에 `handoff` 를 주면 "인계 파일 <경로> 를 읽고 이어간다." 와 `then` 을 차례로 넣는다. 피어 경로에서는 받는 쪽이 이 문장을 사용자 프롬프트로 올리지 않고 `[tfx-control from <리드 이름>]` 머리말을 붙인 자기 세션 피어 메시지로 넣는다.
- 서브에이전트가 이 도구를 호출하면 어떤 대상이든 거부된다.

리드 역할 절차(역할별 모델, 지시서, 교차 리뷰, 릴리스 조율)는 `tfx-lead` 스킬을 따른다.

### Codex ask 메시지 전송

로컬 세션끼리 주고받는 메시지는 `<홈 절대경로>/.claude/scripts/tfx-peer send`를 쓴다. 다음은 원격 세션이나 명시적으로 사용자 입력을 전달하는 `tfx-live ask`의 동작이다.

기본은 Codex 큐이고 `queued`는 큐 기록만 뜻한다. thread 는 UUID 로 찾고 이름으로는 보내지 않는다. queue 를 못 쓸 때만 tmux 직접 입력으로 바꾸고 `fallbackReason`을 남긴다. 큐 경로와 폴백 조건, 머리말, 결과 상태, Codex 협업 도구, `tfx-live queue`로 쌓인 항목 보기와 지우기는 [references/codex-sessions.md](references/codex-sessions.md)를 따른다.

### 네이티브 goal

```bash
tfx-live goal set --session cl1 --condition "관련 단위 테스트가 모두 통과한다"
tfx-live goal set --session cx1 --cli codex --condition "관련 단위 테스트가 모두 통과한다" --budget 100000
tfx-live goal status --session cx1
tfx-live goal clear --session cx1
```

로컬 Claude 와 Codex 만 지원하고 agy 와 `--remote`는 거부한다. 평가자가 해제하지 않고 멈춘 Claude goal 은 리드가 `goal clear`로 정리한다. Codex 의 `complete`는 모델 자기 판정이라 리드가 교차 검증한다. 전송 경로, 상태 판정, 폴백과 확인 상세는 [references/native-goal.md](references/native-goal.md)를 따른다.

### 컨텍스트 판단

Claude의 분모는 공식 모델 창과 실행 한도 중 작은 값이다. Codex의 분모는 rollout이 보고한 실행 창이고, 없을 때만 공식 창이다. 아래 비율은 공식 권고가 아닌 **[추론] 운영값**이다. 모델 문서가 바뀌면 한도도 갱신한다.

| CLI | 준비와 경고 | compact | 신규 배정 중지·handoff | 전송 거부 |
| --- | ---: | ---: | ---: | ---: |
| Claude Code 1M 모델 | 60% | 75% | 85% | 90% |
| Codex 실행 창(rollout 또는 구체 모델) | 60% | - | - | 85% |
| Codex 미등록 모델(1.05M 분모) | 15% | 18% | 20% | 22% |
| agy | 12% | - | 15% | - |

Claude는 85% 도달 시 바로 handoff를 지시한다. Codex 실행 창(`astra`, `luna` 가족 카탈로그 272k/유효 258.4k, `sol`, `terra` 가족 카탈로그 500k/유효 475k)은 60%에서 준비와 인계 파일 기록을 시작하고 85%에서 일반 전송을 거부한다. 85%에서 거부된 뒤에는 가드를 건너뛰는 `tfx-live compact`를 보내거나 인계 요청에 `--max-context-pct 0`을 넘긴다. rollout 실행 창이 없어도 `session-context.mjs` 구체 모델 표에 등록된 모델은 모델별 창과 60/85%를 적용하고, 미등록 모델만 1.05M 분모(15/22%)를 쓴다. agy 행은 운영 지침이며 전송 거부 코드가 없어 전송 거부 열은 비운다. agy의 12%는 작업 중단이 아니라 한 번 보고 뒤 계속 진행하는 기준이다. agy 상태줄(HUD)이 대화 ID 별로 남긴 기록(`~/.local/state/triflux/agy-context/<대화 ID>.json`)이 있으면 `contextPct`, `estimatedContextTokens`, `contextLimitTokens`와 `contextLimitSource: "agy-statusline"`, 기록 시각 `contextRecordedAt`을 보고하고, 기록이 없으면 `null`이다. 같은 필드를 `tfx-live list-sessions --cli agy` 결과의 각 세션에서도 메시지를 보내지 않고 볼 수 있다. 경고와 전송 거부 임계는 정하지 않아 가드는 건너뛴다. `model_context_window`와 `model_auto_compact_token_limit`은 올리지 않는다.

결과 필드, 실행 한도 판정 순서, `ask`의 `--warn-context-pct`와 `--max-context-pct` 덮어쓰기, 거부 결과 형식은 [references/context-fields.md](references/context-fields.md)를 따른다.

### 수동 compact와 종료

```bash
tfx-live compact --cli claude --session cl1 --instructions "변경 파일과 검증 명령을 보존하라" --then "인계 파일을 읽고 검증을 이어가라" --no-wait
tfx-live compact --cli codex --session cx1 --then "src/main.mjs를 확인하고 지정된 단위 테스트를 실행하라" --no-wait
tfx-live wait --cli codex --session cx1 --request-id <then.requestId> --timeout 120
tfx-live stop --cli claude --short <8hex>
tfx-live stop --cli claude --session-id <id>
tfx-live stop --session cl1
```

리드 자기 세션의 compact, clear, exit 는 tmux 안팎 모두 triflux mod 도구 `tfx_control` 을 먼저 쓴다(`tfx-lead` 스킬 `references/self-session-control.md`). 아래 경로는 mod 가 없는 세션의 대안이다. tmux 안에서 도는 Claude, Codex, agy 세션은 자기 자신도 compact(agy 는 `tfx-live compact` 중계 미지원이라 `/compact` 직접 입력)와 clear 를 할 수 있다. 자기 턴이 도는 동안에는 세션이 바쁘므로, 백그라운드로 띄우고 `--if-busy wait`로 턴이 끝나기를 기다리게 한다. 기본 `fail`로 두면 턴이 끝나기 전에 거부된다. 결과는 파일에 남겨 다음 턴에 확인한다. 사용자에게 `/compact` 입력을 부탁하기 전에 이 방법을 쓴다.

```bash
tfx-live compact --session "$TMUX_PANE" --if-busy wait --busy-timeout 600 --instructions "상태 파일 경로와 남은 일을 보존하라" --then "상태 파일을 다시 읽고 이어가라" --no-wait > "${TMPDIR:-/tmp}/tfx-self-compact.json" 2>&1 &
nohup tfx-live clear --cli <CLI> --session "$TMUX_PANE" --if-busy wait --busy-timeout 600 --handoff <인계 파일 경로> > "${TMPDIR:-/tmp}/tfx-self-clear.json" 2>&1 < /dev/null &
```

`compact`의 기본 `--if-busy`는 `fail`이고 `--instructions`는 Claude 만 받는다. `--then`은 일반 텍스트만 받는다. `clear`는 `--handoff` 파일이 없으면 아무것도 보내지 않는다. `inputSent`는 입력 전송이지 모델 수신 확인이 아니다. `stop --short`는 대화를 남긴다. 플래그, 제출 확인 순서, 결과 필드는 [references/compact-clear-stop.md](references/compact-clear-stop.md)를 따른다.

## 요청과 완료 확인

```bash
tfx-live ask --cli claude --transport uds --short <8hex> --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli claude --short <8hex> --request-id <requestId> --timeout 120 --poll-interval 500
tfx-live ask --cli claude --session cl1 --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli claude --session cl1 --request-id <requestId> --timeout 120
tfx-live ask --cli codex --session cx1 --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli codex --session cx1 --request-id <requestId> --timeout 120
```

`ask --no-wait`는 Claude와 tmux에서 `status: "submitted"`, Codex queue에서 `status: "queued"`와 함께 `inputSent: true`, `done: false`, `submittedAt`, `target`, `requestId`를 반환한다. `ask`와 `peer`는 `[tfx-live req=<requestId>]`를 프롬프트 앞에 붙인다. `--no-relay-tag`로 제거하면 `wait --request-id`가 해당 요청을 찾을 수 없다. 슬래시 명령(`/rename`, `/clear` 등)은 CLI와 상관없이 표식 없이 보낸다. 응답 턴이 없는 Claude 내장 명령(`/rename`, `/clear`, `/compact`, `/model`, `/effort`, `/color`)은 기다리지 않고 `status: "submitted"`로 반환한다. 압축 완료까지 기다리려면 `compact` 명령을 쓴다.

`wait`는 표식이 소비된 턴의 마지막 응답을 쓴다. 시간 초과는 `timedOut: true`이고 완료가 아니다. 그때 `status`는 `working`, `queued`, `submitted` 중 하나일 수 있다. 전송 여부가 불명확하면 `status: "unknown"`이며 재전송하지 않는다. CLI 별 판정 규칙과 daemon 선택 조건은 [references/wait-details.md](references/wait-details.md)를 따른다.

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
tfx-live peer --cli-a codex --cli-b claude --mode debate --seed "변경을 검토하고 수정한 입장을 제시해줘" --rounds 2
```

`peer`는 2자 relay(`freeform`, `debate`, 기본값 `freeform`)로 동작하며 이전 응답을 반대쪽의 다음 프롬프트로 전달한다. 기존 tmux pane은 `--attach-a`, `--attach-b`로 연결하며 종료하지 않는다. UDS 쪽도 기존 세션으로 취급한다. Codex 쪽은 `ask`와 같이 queue가 기본이고 응답은 rollout에서 읽는다. thread를 못 찾으면 tmux 직접 입력으로 바꾸고 hop에 `fallbackReason`을 남긴다. `--remote`이거나 `--if-busy fail|interrupt`이면 처음부터 tmux로 보낸다. `--if-busy-a`, `--if-busy-b`로 각 쪽의 정책을 정한다. 소유한 세션을 실제 종료한 경우에만 `stoppedA`, `stoppedB`가 참이다.

`--mode debate`는 첫 hop에 seed를 보내고 이후에는 상대방의 최근 답(`Participant A`, `Participant B`)을 검토하여 동의와 이견의 이유 및 수정한 입장을 요구한다. 답의 길이는 제한하지 않으며 마지막 hop은 기존과 같은 closure 차례다.

## 진단

```bash
tfx-live --help
tfx-live probe
tfx-live list-sessions --cli codex
```

`auto`가 tmux로 전환되면 `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`을 확인한다. 테스트에서는 `$TFX_LIVE_BUG_REPORT_DIR`로 위치를 바꿀 수 있다.

## 원격 native peer 발신과 회신

Darwin, Linux 호스트 사이에서는 `tfx-peer remote-send --host <목적지> --reply-host <회신 별명> --to '<cli>:<이름 또는 UUID>' --message '<본문>'`으로 보낸다. 같은 호스트 Claude끼리는 `SendMessage`를 쓴다. `hosts.json` 등록 조건, `--from` 우선순위, 결과 상태와 재전송 금지, 예시는 [references/remote-peer.md](references/remote-peer.md)를 따른다.

## 선택적 전역 native peer 어댑터

macOS/Linux 는 `triflux setup`에서 동의하면 홈 절대경로 래퍼 `~/.claude/scripts/tfx-peer send --to '<cli>:<정확한 이름>'`을 쓴다. Windows 는 Claude 대상만 지원하고 `node .../tfx-peer.mjs send`로 직접 보낸다. 설치 조건, 전송 결과(`written`, `sent`, `partial`)의 뜻, 손으로 띄운 Codex 의 `tfx-live adopt`, 철회 절차는 [references/peer-adapter.md](references/peer-adapter.md)를 따른다.
