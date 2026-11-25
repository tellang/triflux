# Codex 세션 상세

## start: 모델 해석, 권한, 훅 신뢰

Codex `start --model`은 `astra`, `sol`, `terra`, `luna` 가족 별칭을 호출 호스트의 기존 model-family-resolver로 실제 모델 ID로 바꾼다. 호출 호스트의 `~/.config/triflux/models.json` 가족 고정값을 우선하고, Codex 모델 캐시, 마지막 해석 결과, 내장 기본값 순으로 고른다. `--remote`도 호출 호스트에서 해석한 ID를 보내며 원격 호스트의 고정값은 사용하지 않는다. 실제 모델 ID를 명시하면 그대로 전달한다. 모델 해석은 전역 프로필이나 설정 파일을 바꾸지 않고 `--effort`는 별도로 전달한다.

로컬 Codex 새 thread는 생성 RPC에 `approvalPolicy: "never"`, `sandbox: "danger-full-access"`를 명시한다. `start --sandbox`를 주면 승인 정책은 `on-request`, sandbox는 `workspace-write`로 제한한다. 재개할 때 `--sandbox`를 생략하면 기존 thread 권한을 보존한다. remote TUI resume은 권한 CLI 플래그를 거부하므로 attach 명령에 bypass나 sandbox 플래그를 추가하지 않는다.

Codex 관리 plain/new/resume/resume-last TUI 명령과 `tfx-route` exec/review 워커는 공식 `--dangerously-bypass-hook-trust`가 기본이다. 해당 invocation만 대상으로 하며 일반 `codex` 명령, 전역 config, 저장된 훅 신뢰 기록은 바꾸지 않는다. 활성 훅은 사전 확인 없이 샌드박스 밖에서 실행될 수 있다. 기존 `features.hooks=false`와 sandbox/approval 정책은 유지하고, `--sandbox`만으로 hook-trust bypass를 끄지는 않는다.

관리 기본값을 끄려면 `tfx-live start --cli codex --session NAME --no-bypass-hook-trust` 또는 `tfx lead ROLE --cli codex --no-bypass-hook-trust`를 쓴다. 실행 환경의 `TFX_CODEX_BYPASS_HOOK_TRUST=0`은 route 워커와 live/lead에 공통 적용된다. 미설정과 그 외 값은 켬이며 CLI opt-out은 환경 값 `1`보다 우선한다. 사용자 launcher 내부와 명시 플래그는 재작성하지 않는다. `remote-spawn`은 Claude 진입이고, 내부 Codex는 해당 호스트의 `tfx-route` 정책을 따른다. `tx` 같은 셸 래퍼가 내부에서 같은 플래그를 추가한다면 `--no-bypass-hook-trust`로 TFX 관리 추가를 끈다.

공유 daemon의 prepared-thread TUI attach에는 관리 hook-trust bypass 플래그를 제외한다. CLI가 플래그를 수락해도 daemon에 실제 적용된다는 근거는 없으므로 `features.hooks=false` RPC와 `ready: false`, `blockedBy: "codex-hooks-review"` 폴백을 유지한다. `bypass_hook_trust`나 camelCase RPC/config 필드를 합성하지 않는다. 기본/opt-out과 관계없이 시작 훅 검토 화면에는 메뉴 키, rename, 업무 입력을 보내지 않고 세션을 남긴다. tmux 세션에 attach해 훅을 직접 검토한 뒤 진행한다. builtin 훅과 legacy `notify`는 일반 사용자·플러그인 훅 비활성화 보장에서 제외한다.

로컬 daemon `start` 결과의 `approvalPolicy`, `sandbox`는 TUI attach 뒤 같은 thread에 설정 덮어쓰기 없이 보낸 `thread/resume` 응답이다. 요청의 `sandbox`는 `danger-full-access`, `workspace-write` 형식이고 응답의 `sandbox.type`은 `dangerFullAccess`, `workspaceWrite` 형식이다. `permissionsVerified`는 daemon 설정이 준비한 권한과 일치하는지 나타낸다. 응답 실패나 필드 누락, 다른 thread 응답은 권한 값을 `null`로 보고한다. 권한 불일치는 읽은 값을 그대로 보고한다. 두 경우 모두 `ready: false`, `permissionWarning`을 반환하고 세션은 남긴다. 이 readback은 다음 TUI 턴의 실제 도구 실행까지 확인한 결과는 아니다.

공유 daemon에 이미 로드된 Codex thread는 per-thread hooks override를 지원하지 않아 `start --resume`을 거부하고 기존 설정을 보존한다. 기존 TUI에서 진행 중인 턴이 끝난 뒤 `/permissions`를 입력하고 Full Access를 선택해 확인한다. pane을 닫았다면 오류에 나온 `codex resume <threadId>`는 운영자가 같은 history를 다시 여는 수동 복구 명령이다. 같은 cwd에서 열고 `/permissions`를 다시 선택한다. 이 명령을 에이전트가 직접 실행하는 권한은 아니다. 아직 loaded 상태면 `tfx-live start --resume`은 다시 거부되므로 반복하지 않는다. `thread/settings/update` readback만으로 다음 TUI 턴 권한이 적용됐다고 판단하지 않는다. 새 thread를 만들거나 공유 daemon을 재시작하지 않는다.

## ask 전송 순서와 queue 관리

1. 기본은 app-server 실험 API `thread/queue/add`로 쌓는 것이다. 공유 daemon에 로드된 thread는 그 daemon에 직접 보내며 `queueVia: "shared-daemon"`을 반환한다. 공유 daemon에 없는 별도 TUI와 stale daemon socket의 연결 실패는 기존 stdio app-server 경로를 쓰며 `queueVia: "app-server"`다. 연결 뒤 initialize나 loaded 목록 검증 실패는 이 경로로 전환하지 않는다. 프롬프트는 두 경로 모두 프로세스 인자에 보이지 않는다. stdio add가 없는 Codex에서는 `codex queue --thread <UUID> --message`로 보내며, 이때 프롬프트가 argv에 보이고 `queueVia: "codex-queue-argv"`와 `queueFallbackReason`이 남는다. `queued`는 큐 기록만 뜻하며 모델 응답 완료가 아니다. 실제 처리는 SKILL.md "요청과 완료 확인" 절의 `wait` 결과로 구분한다.
2. 첫 줄 머리말은 `[from <보낸 세션 이름>] [tfx-live req=<id>]`다. 이름은 `--from`, `$TFX_LIVE_FROM`, Claude 세션 기록, Codex `session_index` 순으로 찾고 없으면 머리말 없이 표식만 붙인다. Codex TUI는 Claude처럼 접어 보여 주지 않고 사용자 입력으로 그대로 표시한다.
3. thread는 `--thread UUID`, `start`가 남긴 `@tfx_codex_thread`, Codex 세션 레지스트리, pane 프로세스의 `resume <UUID>` 인자, pane cwd와 같은 rollout 하나 순으로 찾는다. cwd 대응은 그 cwd의 Codex TUI가 하나일 때만 쓰고 exec 워커와 서브에이전트 thread는 뺀다. 이름으로는 보내지 않는다(`codex queue`의 이름 조회가 실패한다).
4. tmux 직접 입력은 queue를 못 쓸 때만 쓴다: 원격 호스트, thread를 못 찾음(`start` 밖에서 `resume --last`로 띄운 세션, `start --resume-last`의 `threadId: null`, 같은 cwd의 TUI 여럿 포함), `codex queue` 오류(0.160 미만 포함). 결과에 `transport: "tmux"`, `transportRequested: "queue"`, `fallbackReason`이 남는다. 시간 초과처럼 queue가 이미 쌓았을 수도 있는 오류는 `status: "unknown"`으로 끝내고 재전송하지 않는다.
5. 슬래시 명령(`/rename`, `/compact`, `/new`)과 interrupt(Escape)는 tmux 직접 입력 전용이다. queue로 보낸 슬래시 명령은 실행되지 않고 일반 텍스트로 모델에 들어간다. `/명령`으로 시작하는 프롬프트(절대 경로는 제외)와 `--if-busy fail|interrupt`는 tmux로 보내고 `transportReason`을 남긴다. 슬래시 명령에는 표식을 붙이지 않으므로 `wait`로 추적할 수 없다.

보내는 쪽이 Codex여도 로컬 피어 전송은 `<홈 절대경로>/.claude/scripts/tfx-peer send`를 쓴다. Codex 협업 도구(`spawn_agent`, `send_message`, `followup_task`)는 자기가 띄운 하위 에이전트(`/root/...`)를 대상으로 한다. 다른 최상위 Codex 세션에 닿는지는 확인하지 않았다. Codex 0.162.1 에서 모델에 노출된 협업 도구는 `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents`, `interrupt_agent`이고 `close_agent`와 `send_input`은 없었다. `send_message`는 하위 에이전트의 턴을 시작하지 않고 다음 `followup_task` 턴에 함께 전달된다.

결과의 `status`는 `queued`(쌓임), `working`(TUI가 가져가 턴 시작), `completed`, `failed`로 나뉘고 `delivered`, `deliveredAt`, `turnId`가 배달을 구분한다. queue는 바쁜 세션에도 쌓으므로 `--if-busy wait`는 의미가 없다.

```bash
tfx-live queue --cli codex --session cx1
tfx-live queue --cli codex --session cx1 --request-id <requestId> --delete all
tfx-live queue --cli codex --thread <UUID> --delete <queuedMessageId>
```

`queue`는 TUI가 아직 가져가지 않은 항목을 보고 지운다. Codex app-server의 실험 API `thread/queue/list`·`thread/queue/delete`를 stdio로 호출하며 큐 저장소 파일은 건드리지 않는다. 목록 항목은 `id`(ask 결과의 `queuedMessageId`와 같다), `requestId`, `text`다. 삭제 결과의 `missing`은 이미 TUI가 가져갔거나 없는 항목이다. 유휴 TUI는 쌓인 항목을 곧 가져가므로 지울 수 있는 것은 사실상 바쁜 세션과 닫힌 세션의 항목이다. 가져간 뒤의 처리 여부는 `wait`로 확인한다.
