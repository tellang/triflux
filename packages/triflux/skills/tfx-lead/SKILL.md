---
name: tfx-lead
description: >
  세션에 개발 리드, 프로젝트 리드 같은 역할 리드를 맡길 때(`/tfx-lead <역할>`),
  리드가 워커에게 이름을 붙여 등록하고 그 워커들의 컨텍스트, 승계, 교차 리뷰,
  머지, 릴리스를 조율할 때 사용한다.
---

# tfx-lead

## 상시 규칙

compact 뒤에는 스킬마다 앞부분만 다시 붙고, 한 세션에서 여러 스킬을 호출했으면 오래된 스킬은 통째로 빠질 수 있다. 이 절이나 아래 절이 문맥에 없으면 이 스킬 파일을 다시 읽는다. 괄호 안은 상세 절이다.

- 띄운 쪽이 세션의 생성, 이름, 컨텍스트, 승계, 종료를 끝까지 맡는다. 결과를 받은 서브에이전트와 팀원은 바로 닫는다(1절, 3절).
- 워커는 `<월>.<일> <주제>` 이름으로 `.omc/lead/workers.md`에 실제 권한, 재개 ID 와 함께 적는다. 새 일을 나누기 전에 이 표에서 같은 역할, 주제의 워커를 먼저 찾고, 닫은 워커는 `workers-closed.md`로 옮긴다("워커 등록", 3절).
- 띄우기 전에 `tfx judge worker-mode`로 권한을 정하고(요약에 민감 정보를 넣지 않는다), 압박 단계로 실행 위치를 정하고, 모델과 tmux 세션명을 사용자에게 한 줄로 알린다(1절, 2절, 3절).
- 긴 지시는 지시서 경로로 보내고 작업 시작을 확인한다. 보고는 결과 파일 경로와 세 줄 요약, 4000자 상한이다. 화면 폴링은 하지 않는다(4절, 5절).
- `written`, `sent`, `queued`, `submitted`는 완료가 아니다. `unknown`, `timedOut`은 재전송하지 않고 상태부터 확인한다(5절).
- 워커는 사용자에게 직접 묻지 않고 리드에게 올린다. 지시서에 "직접 물어도 됨"이 있을 때만 예외다. 사용자에게 묻는 창은 리드 pane 하나이고, 소통 세션이 있으면 소통 pane 이다(4절, 8절).
- 머지는 CI 통과와 작성 벤더가 아닌 리뷰어의 통과가 둘 다 있어야 한다. 수정은 작성자가, 재확인은 같은 리뷰어가 한다. 리드가 대신 고치고 스스로 승인하지 않는다. 다른 두 벤더가 모두 비가용일 때만 같은 벤더의 새 세션이 리뷰한다(6절, `tfx-routing.md`).
- 레인마다 `.worktrees/` 아래 별도 worktree 를 쓰고, 다른 레인 범위는 지시서에 "건드리지 않는다"로 적는다(7절).
- 실제 HOME 으로 전체 테스트를 돌리지 않고 개발 체크아웃에서 `npm ci`를 실행하지 않는다. AI trailer 를 넣지 않는다. 권한 분류기가 막은 일은 다른 세션에 대신 시키지 않는다. 워커의 tmux 실측은 `-L` 전용 소켓만 쓴다(10절).
- 컨텍스트는 `tfx-live` "컨텍스트 판단" 표의 CLI 별 비율로 잰다. Claude 85% 는 바로 승계한다. 리드 자신의 compact, clear, exit 는 `tfx_control`로 건다. clear 와 exit 는 인계 파일을 먼저 쓰고, exit 는 사용자가 끝내라고 했거나 승계 세션이 인계 파일을 받기로 했을 때만 쓴다. 호출은 예약이라 응답을 짧게 끝낸다. 도구가 없는 Codex, agy 리드는 `tfx-live clear`를 쓴다(11절).
- 압박 critical 피어 메시지를 받으면 새 스폰을 멈추고 "압박 변화 대응" 표의 critical 행을 실행한다. 사용자 세션은 건드리지 않는다(3절).
- 팀원 pane 은 종료 승인을 받은 뒤 `--agent-id`로 정확히 하나가 대조되고 자기 pane 이 아닐 때만 `kill-pane` 한다(3절).
- MCP 후보의 설치, 인증, 등록 변경은 사용자 승인 뒤에만 한다("MCP 설치 제안").

## 목적

한 세션에 역할 리드를 맡기고, 리드가 워커를 등록하고, 등록한 워커의 컨텍스트와 진행을 관리하는 절차다. Claude 리드와 Codex 리드가 같은 절차를 따른다.
세션을 띄우고 보내고 기다리고 compact 하고 닫는 명령의 상세, 전송 세부, 컨텍스트 비율 표는 `tfx-live` 스킬이 정본이다. 여기서는 복제하지 않는다.
근거는 ADR-0027(Codex queue), ADR-0029(리드 운영), ADR-0030(테스트 격리), ADR-0043과 ADR-0047(압박 알림), ADR-0044(자기 세션 제어)이고, 모델 배치는 `tfx-routing.md`의 "모델 배치" 표다.

`tfx-routing.md`는 다음 순서로 찾고 먼저 있는 파일을 쓴다. 없으면 추측하지 말고 누락을 알린다. 같은 순서를 실행하는 블록은 `tfx-harness` 스킬의 "SSOT 탐색" 절에 있다.

1. `$TFX_ROUTING_SSOT`
2. clone 의 `.claude/rules/tfx-routing.md`(git 메인 워크트리, 없으면 cwd 에서 위로 탐색)
3. `~/.claude/skills/tfx-harness/references/tfx-routing.md`(설치본 사본, clone 보다 늦을 수 있다)

## 보유 자산과 선택

처음 리드를 맡을 때 현재 호스트의 스킬, 도구 인벤토리에서 TFX 자산과 호출 이름을 인지한다. 호스트가 노출하는 capability 목록은 탐색 단서로 쓰고, 실제 가용성과 호스트별 표기는 설치 인벤토리를 따른다. Claude의 `/tfx-*`, Codex의 `$tfx-*`, agy의 표기를 서로 있다고 가정하지 않는다.

- 소유자가 분명하면 아래 짧은 안내로 바로 선택한다. 소유자가 불분명하면 `tfx judge route --task '<요약>'`로 분기 규칙 한 줄을 먼저 받는다. `choice`가 null이거나 정책이 충돌할 때만 `tfx-routing.md`의 필요한 절을 1회 읽는다(찾는 순서는 위 목적 절).
- 사용자가 자산 이름을 다시 말하지 않아도 요청에 맞는 경로를 기본 선택한다. 소유 스킬이나 경로를 묻거나 그 선택이 모호한 경우는 `tfx-harness`, 명확한 구현 실행은 `tfx-auto`와 그 실행 경로 `tfx-route.sh`, 세션 관리와 소통은 `tfx-live`와 `tfx-peer`다. 작업 목표 자체가 모호하면 기존 SSOT의 요구사항 분류를 따른다. 모든 요청 앞에 harness나 auto를 실행하지 않는다.
- 원격은 `tfx-remote`, 코드 판정은 `tfx-review`, 외부 조사는 `tfx-research`, 진단은 `tfx-doctor`, triflux 릴리스는 `tfx-ship`의 소유 범위를 따른다. 명시 지시와 gstack, superpowers, 호스트 소유 정책을 유지하며 TFX 선택을 이유로 우회하지 않는다. 가용성을 모르면 임의 폴백하지 않는다.
- 첫 활성화에는 이 짧은 안내를 읽고, 선택한 자산의 상세 스킬은 사용할 때 읽는다. 정본 전체를 매 초기화나 매 요청에 읽지 않는다. 이미 읽은 긴 스킬과 전체 capability 목록을 매 턴이나 포크마다 다시 싣지 않는다. 포크에는 선택한 경로와 필요한 맥락만 넘긴다.
- 워커 모델과 effort 조회(`tfx judge worker-model`), Jev 를 호출하는 판단 지점과 폴백은 [references/worker-model-judge.md](references/worker-model-judge.md)를 따른다.

## MCP 설치 제안

추천은 리드 진입의 `mcpRecommendation`을 먼저 재사용하고, 후보의 설치, 인증, 등록 설정 변경은 사용자 승인 전에 하지 않는다. 조회 명령, 사용자에게 제안할 항목, 승인 뒤 범위, 워커와 headless sidecar 처리는 [references/mcp-install.md](references/mcp-install.md)를 따른다.

## 리드 진입

셸에서 새 리드를 띄울 때는 `tfx lead <역할> [--cli claude|codex|agy]`를 쓴다. tmux 세션(기본 `<폴더>-lead`)에 리드를 띄우고 리드 진입까지 보낸다. Claude 는 `/tfx-lead <역할>`을, mod 가 없는 Codex 와 agy 는 이 스킬 파일을 읽고 리드를 맡으라는 프롬프트를 보낸다.

- 새 리드나 새 세션 승계의 모델 선택은 `tfx lead <역할> --cli codex --task '<짧은 작업 요약>'`의 자동 선택을 쓴다. Jev는 작업을 분류하고 기존 프로필 매핑과 resolver가 모델과 effort를 선택한다. 인계 파일은 자동으로 읽지 않는다.
- macOS iTerm2 배치는 live 실행 경로가 고른다. 리드는 최소 100 cols × 24 rows 에 기본 포커스 유지이고, 전환은 `tfx lead ... --focus`로만 한다. 상세는 `tfx-live` 스킬의 `references/window-layout.md`다.

- 명시한 CLI, 권한, 모델 지시가 우선이다. `--model`이나 `--effort`가 하나라도 있으면 그 쌍을 보존하고, 커스텀 런처도 권고만 기록한다. 워커 실행은 기존 `tfx-auto`와 route를 사용하고 승계 ACK와 rebind 절차는 그대로 따른다.

- 실행 명령 고르기(`--launcher`, `lead.json`), setup 이 묻는 시점, Codex 리드의 hook trust 기본값과 opt-out, `--json`의 `routing` 읽는 법, `respawn-pane` 래퍼 주의는 [references/lead-launch.md](references/lead-launch.md)를 따른다.

이미 띄운 Claude 세션을 리드로 만들 때는 세션 안에서 `/tfx-lead <역할>`을 실행한다(예: `/tfx-lead 개발리드`). triflux mod 가 세 가지를 한다.

- 세션 이름을 `<월>.<일> <역할>`로 바꾼다. 인자가 이미 날짜로 시작하면 그대로 쓴다.
- macOS 대화형 세션이면 아래 "압박 변화 대응"의 감시를 켠다.
- 이 스킬을 따르라는 숨은 지시를 모델에 넣는다.

이름 변경이 거부되면 "이름 변경 실패" 토스트가 뜬다. 그때는 사용자에게 `/rename <이름>` 입력을 요청한다. mod 가 없는 세션도 같다.
Codex 리드는 mod 가 없으므로 `/rename <월>.<일> <역할>`을 직접 쓰고 이 스킬을 읽는다.

## 워커 등록

리드가 워커마다 연락해 이름을 붙이면 등록이 끝난다.

- 이름 형식: `<월>.<일> <주제>`. 승계 세션은 기존 이름 뒤에 ` 2`, ` 3`.
- 대상 찾기: `tmr ls --json`으로 pane 별 에이전트와 상태를 본다(tmr 이 없으면 `tmux ls`). CLI 별로는 `tfx-live list-sessions --cli <claude|codex|agy>`.
- 이름 붙이기:

| 워커 CLI | 이름 붙이는 수단 |
| --- | --- |
| Claude | `tfx-live ask --cli claude --session <tmux 대상> --prompt "/rename <이름>"` |
| Codex | `tfx-live rename --cli codex --transport uds --thread <ID> --name "<이름>"`, thread 가 없으면 tmux 로 `/rename <이름>` |
| agy | tmux 로 `/rename <이름>`. 새 대화는 첫 메시지 전에 실패하므로 `tfx-live` 의 `namePending` 처리를 따른다 |

- 등록 기록: 리드가 `.omc/lead/workers.md` 에 마크다운 표로 적는다. 열은 이름, CLI, 위치(m5, m2, ryzen 과 tmux 대상), 역할, 권한, 지시서, 재개 ID 일곱이고 워커마다 한 줄이다. 권한에는 `bypass (jev)`, `auto (rule: low_confidence)`처럼 권고 출처도 적는다. 권고와 다르게 정했으면 실제 값과 이유를 짧게 적는다. compact 때 triflux mod 가 이 파일의 표 줄을 요약 지시에 그대로 넣으므로 경로를 바꾸지 않는다. 저장소가 무시하는 `.omc/` 아래라 커밋되지 않는다.
- 재개 ID: Claude 는 `tfx-live list-sessions --cli claude`의 `sessionId`, Codex 는 `start` 결과의 `threadId`, agy 는 `list-sessions --cli agy`의 `conversationId`다. agy 새 대화는 첫 메시지 전에 `null`일 수 있으니 첫 지시 뒤에 다시 읽어 채운다.
- 닫은 워커는 줄을 지우지 않고 같은 열의 `.omc/lead/workers-closed.md` 로 옮긴다. 다시 필요해지면 재개한다(3절 "전담 워커 재사용"). 다시 쓸 일이 없다고 정한 줄만 지운다. 같은 파일에 두지 않는 이유는 compact 때 mod 가 `workers.md` 의 표 줄을 제목 없이 모두 넣어 닫은 워커가 살아 있는 워커와 섞이기 때문이다.

  ```markdown
  | 이름 | CLI | 위치 | 역할 | 권한 | 지시서 | 재개 ID |
  |---|---|---|---|---|---|---|
  | reviewer-828 | Claude sonnet | m5 로컬 `rv-828` | PR #828 리뷰 | auto (rule: low_confidence) | .omc/briefs/x/review.md | 25b8dccf-56ed-4722-a70c-6317aedb1c4f |
  ```
- 같은 이름의 세션이 로컬과 Remote Control 에 하나씩 있으면 `SendMessage`가 ref 를 요구한다. `ListAgents`에서 "on this machine" 쪽 ref 를 붙인다.
- 워커를 다시 띄울 때는 새로 띄우지 않고 원래 tmux 세션 이름으로 `tfx-live start --cli <CLI> --session <원래 이름> --resume <재개 ID> --name "<이름>"`을 쓴다. 세션 이름과 tmr 재접속 루프가 그대로 맞고, 워커가 파일을 다시 탐색하거나 지시서를 다시 읽지 않아도 된다. 권한은 `workers.md`의 실제 값을 따른다. Codex loaded thread는 per-thread hooks override 제한으로 재개를 거부하며, launcher만 바꿔도 기존 TUI 권한은 바뀌지 않는다. 기존 TUI의 `/permissions`에서 Full Access를 고르고 확인한다. pane을 닫았으면 오류에 나온 `codex resume <재개 ID>`로 같은 대화를 연다. `thread/settings/update`의 readback은 다음 TUI 턴의 적용 근거가 아니다. 새 thread를 만들거나 공유 daemon을 재시작하지 않는다. 재개한 세션은 이전 사용량을 이어받으므로 재개 직후 컨텍스트를 잰다(11절).
- `tfx-live list-sessions`의 `status: shell`은 CLI 가 죽었다는 뜻이 아닐 수 있다. 그 세션이 띄운 백그라운드 셸일 수 있으니 재실행 전에 pane 내용을 확인한다.

## 전송 수단

세션 간 전송 규칙(로컬 Claude 끼리 `SendMessage`, 그 밖의 로컬 대상 `tfx-peer send`, 원격 피어 `tfx-peer remote-send`, 원격 세션의 사용자 입력 `tfx-live ask`, 첫 입력 전 agy 세션, Windows, adopt)은 `tfx-live` 스킬의 "전송 경로" 절이 정본이다. 리드 쪽 차이만 적는다.

- 같은 세션 안 서브에이전트: Claude 리드는 Agent 도구(`model`, `effort`, `run_in_background`), Codex 리드는 `spawn_agent`와 추가 지시 `followup_task`.
- 사용자에게 묻기: Claude 리드는 `AskUserQuestion`, Codex 리드는 답변에서 짧은 선택지로 묻는다.
- Codex 에 슬래시 명령을 보낼 때만 tmux 직접 입력을 쓴다.

## 1. 역할과 수명

띄운 쪽이 그 세션의 생성, 이름, 컨텍스트, 승계, 종료를 소유한다. 서브에이전트를 부른 세션도 같다.

- 승계 방식: 컨텍스트가 차서 하는 승계는 resume 으로 대신하지 않는다. 재개한 세션은 이전 사용량을 그대로 이어받는다. 기본으로 같은 pane 에서 인계 파일을 쓴 뒤 `tfx_control` 의 `clear`(`handoff` 인계 파일 경로)로 비우고 이어간다. 세션, pane, 이름, 등록 줄이 그대로라 rebind 와 등록 기록 수정이 필요 없다. 모델이나 실행 기기를 바꿀 때, 또는 `tfx_control` 이 없는 세션일 때만 아래 순서로 새 세션에 넘긴다.
- 승계 순서(새 세션):
  - 인계 파일을 쓴다. 목표, 완료 조건, 체크아웃 상태, 확정 결정, 증거 경로, 미완료, 다음 행동, `predecessorSessionId`를 담는다.
  - 승계 세션이 경로를 읽고 ACK 한다.
  - 원 리드는 닫기 전에 자기가 띄운 Claude 워커마다 `tfx_control` 의 `rebind`(`target: claude:<이름>`, `lead: <새 리드 세션 ID>`)를 보내고 "rebind 완료" 알림을 확인한다. 새 리드 ID 는 새 리드가 `whoami` 로 얻어 인계 ACK 에 적는다. 원 리드가 이미 죽어 못 보냈으면 그 워커는 tmux 안이면 `tfx-live` 경로로 제어하고, tmux 밖이면 다시 띄운다.
  - ACK 를 받은 뒤에만 원 세션을 닫고 등록 기록을 고친다. ACK 가 없으면 원 세션을 유지한 채 인계 파일 경로를 다시 보낸다.
- 서브에이전트는 결과를 받은 즉시 닫는다. Claude 리드의 Agent 도구 팀원은 3절 "끝난 팀원 닫기" 절차로 닫는다.
- 닫은 뒤에는 남은 세션이 없는지 `tmr ls --json`(없으면 `tmux ls`)으로 확인한다. tmr 은 macOS(arm64) 에서 `tfx setup` 이 설치를 묻는다.

### 워커 권한 모드

워커를 띄우기 전에 `tfx judge worker-mode --task '<요약>'`을 실행한다. 외부 자원을 바꾸는 워커는 bypass, 읽기 전용 조사 워커는 auto로 띄운다. 자기 워크트리 안 파일 수정과 로컬 테스트만 하는 워커도 auto가 기본이다.

요약 작성 기준, 판정 해석, CLI 별 bypass 적용 방법은 [references/worker-mode.md](references/worker-mode.md)를 따른다.

## 2. 역할별 모델

모델 ID는 기록하지 않는다. Codex는 가족 프로필과 별도 effort, Claude는 별칭을 사용한다. 현재 대응은 `tfx-routing.md`의 "모델 배치" 표가 정본이다. 가족 프로필에는 `model`만 기록하고 effort는 `-c model_reasoning_effort`로 전달한다. 수동 CLI 예: `codex -p sol -c 'model_reasoning_effort="high"'`.

역할별 가족과 effort 는 `tfx-routing.md`의 "모델 배치" 표를 따른다. Codex `start --model`의 가족 해석은 `tfx-live` 스킬 `references/codex-sessions.md`다. 아래는 리드별 verifier 와 explore 배치다.

| 리드 | 코드 작성 벤더 | verifier | explore |
| --- | --- | --- | --- |
| Claude | Codex 또는 Antigravity | Opus 네이티브 서브에이전트 | Haiku 네이티브 |
| Claude | Claude | Codex Sol `sol` + `high` | Haiku 네이티브 |
| Codex | 모두 | Codex Sol 네이티브 | Luna low 네이티브 |
| Antigravity | Codex 또는 Claude | Hydrogen High 네이티브 | Luna low 네이티브 |
| Antigravity | Antigravity | Codex Sol `sol` + `high` | Luna low 네이티브 |

이 표는 리드의 호출 절차를 정한다. 코드의 verifier 기본값은 Codex Sol, explore 기본값은 Claude 로 유지한다. Codex 리드의 verifier 는 빌드, 테스트, 요구사항 충족 증거만 확인하고 코드 승인은 하지 않는다.

- Codex 주간 한도가 낮으면 새 Codex 워커 대신 Claude 로 돌린다.
- 세션을 띄울 때마다 사용자에게 한 줄로 알린다: "이 역할에 이 모델, tmux 세션명 `<이름>`". 서브에이전트는 tmux 에 보이지 않는다고 밝힌다.

## 3. 부르는 방법

| 용도 | 수단 |
| --- | --- |
| 오래 가는 작업 세션 | `tfx-live start`로 tmux 에 띄우고 위 "워커 등록"을 한다. 사람은 tmr 목록 화면으로 본다 |
| 전담 워커: 같은 일이 다시 올 것 같거나(재사용성), 주제가 정해졌거나(주제 고정), 역할이 정해진(역할 고정) 워커 | 작업 길이와 관계없이 `tfx-live start`로 이름 붙인 세션을 띄우고, 등록 기록에 역할과 주제를 함께 적는다. 아래 "전담 워커 재사용"을 따른다 |
| 일회성 판단, 리뷰 | 서브에이전트. model 과 effort 를 지정하고 백그라운드로. 재리뷰가 이어질 것 같으면 아래 리뷰어 예시 |
| 일회성 Codex 작업 | `tfx-route.sh` 역할 호출 |
| 무거운 전체 테스트 | 원격 격리 호스트. `tfx-remote probe`를 먼저 돌린다 |

```bash
tfx-live start --cli claude --session cl-doc --name "10.8 문서 정리" --model opus --effort high --lead-session <리드 세션 ID>
tfx-live start --cli codex --session cx-impl --name "10.8 구현"
```

Agent 도구로 띄운 팀원(agent teams 의 tmux 모드)은 리드의 현재 폴더에서 새 Claude 프로세스로 뜬다. 처음 보는 폴더면 "Quick safety check" 신뢰 화면에서 멈추며, 이 화면의 자동 승인은 `tfx-live start` 와 `remote-spawn --auto-trust` 에만 있고 Agent 도구 경로에는 없다. 이미 신뢰한 폴더에서 띄우고 절대 경로로 일을 시키거나, 새 폴더면 사용자가 한 번 신뢰한 뒤 띄운다.

### 팀원 표시 방식

Agent 도구를 `name`과 함께 호출하면 팀원으로 뜬다. 띄우기 전에 `tmux display -p -t "$TMUX_PANE" '#{pane_width}'`로 리드 pane 폭을 재고, 200 cols 미만이면 `name` 없이 `run_in_background: true` 서브에이전트로 띄운다. `teammateMode` 설정, 폭 기준의 근거, 좁은 화면에서 리드를 띄우는 방법은 [references/teammates.md](references/teammates.md)를 따른다.

### 끝난 팀원 닫기

결과를 받은 팀원은 바로 닫는다. 끝난 팀원도 pane, Claude 프로세스, 프로세스별 MCP 서버를 계속 쥔다. 먼저 `shutdown_request`로 종료를 요청하고, 거절하면 이유를 읽고 닫지 않는다. 승인 뒤에도 pane 이 남았을 때만 `--agent-id <팀원 이름>@`로 대조해 정확히 하나이고 리드 자신의 pane 이 아닐 때 `kill-pane` 한다. 대조 명령, mod 의 유휴 팀원 알림, `/tfx-keep`은 [references/teammates.md](references/teammates.md)를 따른다.

### 전담 워커 재사용

새 일을 나눌 때 서브에이전트를 띄우기 전에 등록 기록을 먼저 본다.

1. 등록 기록에서 같은 역할, 같은 주제의 워커를 찾는다. 없으면 `.omc/lead/workers-closed.md` 도 본다.
2. 찾았으면 살아 있는지 `tmr ls --json`(없으면 `tfx-live list-sessions`)으로 확인한다. 닫혔거나 죽었을 때 마지막 턴에서 캐시 수명이 지났고 인계 파일만으로 다음 작업을 이어갈 수 있으면 새 세션을 기본으로 띄운다. 파일에 없는 대화 맥락이 필요하거나 캐시가 살아 있으면 위 "워커 등록"대로 재개 ID 로 재개해 줄을 `workers.md` 로 되돌린다. 재개 ID 가 없거나 재개가 실패할 때도 새로 띄운다.
3. 컨텍스트를 잰다(11절). `tfx-live` 의 준비 기준을 넘었으면 compact 하거나 승계한 뒤 보낸다. Claude 가 85% 에 도달했으면 승계만 한다.
4. 그 세션에 지시서 경로를 보낸다. 없으면 이번 일이 위 표의 전담 워커 기준에 맞는지 보고, 맞으면 새 전담 세션을 띄워 등록한다.

| 예 | 고를 것 | 이유 |
| --- | --- | --- |
| 같은 묶음의 반복 수정 | 전담 세션 하나 | 같은 주제라 앞 묶음의 맥락을 다음 묶음에 그대로 쓰고, 번호만 바꾼 팀원 여럿이 pane 과 프로세스를 따로 쥐지 않는다 |
| 리뷰어 | 작성 벤더와 다른 벤더의 세션(`tfx-routing.md` "교차 리뷰 작성자 분리"). 쓸 수 있는 벤더가 하나뿐이면 같은 벤더의 다른 인스턴스 | 같은 워커가 자기 작업을 리뷰하지 않는다(6절). 작성 세션은 리뷰에 재사용하지 않는다. 리뷰 전담 세션은 벤더별로 두고, 보내기 전에 이번 PR 의 작성 벤더와 다른지 확인한다. 리뷰 전담 세션에는 수정 작업을 보내지 않는다 |

### 실행 위치 결정

워커를 어디서 돌릴지(m5 로컬, m2, ryzen)는 리드가 디스패치 직전에 정해 지시서에 적는다. 워커는 받은 위치에서 실행만 하고, 압박을 느끼면 리드에게 보고한다. 피어 세션이 워커에 오프로드 지침을 따로 뿌리지 않는다.

```bash
sysctl -n kern.memorystatus_vm_pressure_level   # 1 normal, 2 warn, 4 critical
node scripts/remote-spawn.mjs --probe m2         # 원격 후보의 압박과 준비 상태
```

- 기준값과 호스트 선택은 `tfx-routing.md`의 "원격 오프로드 기본 정책"이 정본이다.
- 지시서에는 실행 위치와 호스트별 주의를 적는다. ryzen 은 Windows(PowerShell 7)이고 기본 디렉터리는 `%USERPROFILE%\Desktop\Projects`다. `remote-spawn`을 쓸 수 없을 때의 절차는 `tfx-remote` 스킬의 "Windows 원격 수동 실행 대안" 절이다.
- 원격에 띄운 세션도 띄운 리드가 종료까지 책임진다.

#### 압박 변화 대응

`/tfx-lead <역할>`이 macOS 대화형 세션에서 압박 감시를 켠다. 수동으로 켜고 끄고 볼 때는 `/tfx-pressure on|off|status`를 쓴다. 감시 방식과 기준값은 `tfx-routing.md`의 "원격 오프로드 기본 정책"이다. 리드를 넘기거나 끝낼 때 `/tfx-pressure off`.

- 4 로 오르는 전이만 리드 자기 세션에 피어 메시지로 넣어 깨운다. 긴 턴 도중에도 바로 온다. 피어 전송이 실패하면 본문 끝에 그 사실이 한 줄 붙고, 턴이 끝난 뒤 온다(ADR-0043).
- 나머지 전이는 턴을 열지 않는다. 리드의 다음 요청(새 입력이나 도구 결과)에 `메모리 압박: 현재 <단계> <이름>(<시각>)` 한 줄로 보인다. 그 사이 여러 번 바뀌었으면 마지막 단계 하나다. 이 줄에는 답하지 않는다(ADR-0047).

받은 즉시 할 일은 다음과 같다. 실행 중인 세션은 다른 기기로 옮길 수 없다는 전제다. 한 줄로 본 단계는 다음 디스패치부터 그 행을 따르고, 하던 일은 이어 간다.

| 받은 것 | 행동 |
| --- | --- |
| 현재 2 (warn) | 새 로컬 워커는 한 번에 1개까지. 무거운 shard 와 전체 테스트는 원격으로. 실행 중인 것은 그대로 둔다. 4 에서 내려온 뒤라면 보류한 디스패치를 원격 우선으로 재개한다 |
| 현재 1 (normal) | 로컬 정책으로 돌아간다. 중단했던 작업이 남아 있으면 먼저 재개한다 |
| critical 피어 메시지 | 순서대로. 1) 새 스폰 전부 중단 2) 유휴 headless 워커와 끝난 세션을 `tfx multi stop`, `tfx-live stop` 으로 닫는다 3) 재개 가능한 Codex 워커는 중단하고 thread ID 와 남은 지시를 기록해 원격에서 다시 띄운다 4) 사용자가 쓰는 대화형 세션은 건드리지 않고 상황과 한 일을 사용자에게 알린다 5) 리드 자신은 컨텍스트가 60% 를 넘었으면 compact 한다(11절 "자기 세션 제어") |

`/tfx-pressure status`는 사용자가 치는 명령으로, 감시 여부와 마지막 표본의 단계·시각을 보여 준다. `/clear` 뒤에도 감시가 이어지지만 resume 한 세션은 다시 `/tfx-lead <역할>` 또는 `/tfx-pressure on` 한다. 감시가 꺼져 있거나 mod 가 없는 세션은 디스패치 직전 `sysctl` 측정(ADR-0040)만 한다.

## 4. 지시 전달

긴 지시는 지시서 파일에 쓰고 프롬프트에는 경로만 보낸다.

- 위치: 저장소가 무시하는 경로(`.omc/briefs/` 같은 곳).
- 구성: 목표, 범위, 건드리지 않을 것, 완료 조건, 결과 파일 경로, 보고 형식, 사용자 질문 위치.
- 사용자 질문 위치: 기본은 "리드로 올림"이다. 워커는 `AskUserQuestion`을 띄우지 않고 질문, 선택지, 권고, 근거를 리드에게 보고한 뒤 그 결정에 걸린 작업을 멈춘다. 사람이 그 워커 pane 을 같이 보는 작업에만 "직접 물어도 됨"이라고 적는다. 그때 워커는 자기 pane 에서 묻고, 물었다는 사실과 받은 답을 리드에게 한 줄로 보고한다.
- 보고 형식: 보고는 결과 파일 경로와 세 줄 요약, 4000자 상한. 리드 세션의 triflux mod 가 4000자를 넘는 서브에이전트 결과와 피어 메시지를 앞 800자와 본문의 파일 경로 목록만 남기고 자른다. 경로가 하나도 없으면 자르지 않고 경고 토스트만 띄운다.
- 보고 경로: 워커가 리드에게 닿는 명령을 지시서에 그대로 적는다. Claude 워커는 `SendMessage(to: "<리드 이름>")`를 안다. agy 워커는 `SendMessage`가 없고 리드 이름도 모르므로 아래 agy 절을 따른다.
- 방향이 바뀌면 지시서 끝에 "정정" 절을 덧붙이고, 그 절이 앞 절을 대체한다고 적는다. 앞 절은 지우지 않는다.
- 첫 지시를 보낸 뒤 작업이 실제로 시작됐는지 확인한다. tmux 직접 입력은 첫 지시가 유실된 사례가 있다. 긴 프롬프트를 tmux 에 직접 입력하지 않는다.

### agy 워커 지시서

agy 는 리드의 대화 맥락과 이름을 모르고, 보고 수단도 셸 명령뿐이다. 지시서에 "산출" 절만 있으면 결과 파일을 쓰고 보고 없이 멈춘다. agy 워커 지시서에는 공통 구성에 더해 "보고" 절을 두고 다음을 적는다.

- 끝나면, 막히면, 리드 결정이 필요하면 보고한다는 조건.
- 보고 명령 전문. 리드 이름은 정확한 문자열로 넣는다.
  - Claude 리드: `<홈 절대경로>/.claude/scripts/tfx-peer send --to 'claude:<리드 이름>' --message '<결과 파일 경로와 세 줄 요약>'`
  - Codex 리드: 같은 명령에 `--to 'codex:<리드 이름>'`
  - agy 리드: 같은 명령에 `--to 'agy:<리드 이름>'`
- `tfx-peer`와 `tfx-live`는 run_command 의 `BypassSandbox: true`로 실행한다는 문장. 관리자 정책으로 샌드박스가 강제된 agy 는 이 문장이 없으면 보고 명령이 막힌다(`tfx-live`의 agy 호스트 계약).
- 컨텍스트 보고 기준은 agy 열의 비율(12%)을 쓰고, 12%에 닿으면 한 번 보고한 뒤 작업을 이어가게 적는다.
- 사용자 질문 위치. 지정이 없으면 리드로 올린다.

첫 프롬프트에는 지시서 경로와 함께 "끝나면 지시서의 보고 절대로 보고한다"를 한 줄 넣는다.

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
| agy 세션 | 그 세션이 지시서의 보고 규칙에 따라 `tfx-peer send`로 보고한다(`tfx-live`의 agy 호스트 계약) |

- `timedOut: true`와 `status: "unknown"`은 완료가 아니다. 재전송하지 않고 상태를 먼저 확인한다.

## 6. 교차 리뷰와 머지

작성 벤더와 다른 벤더가 `code-reviewer`, `quality-reviewer`로 리뷰한다. 작성 벤더는 `TFX_REVIEW_AUTHOR=codex|claude|antigravity`로 지정한다. 미지정이면 Codex 로 보고 잘못된 값은 오류로 끝낸다.

리뷰 후보 순서와 사용량에 따른 조정은 `tfx-routing.md`의 "교차 리뷰 작성자 분리"가 정본이다. Claude 리뷰는 `tfx-route.sh`의 Claude 워커 경로와 `--model opus`를 쓴다.

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

- 사용자에게 묻는 창은 기본으로 리드 pane 하나다. 소통 세션이 있으면 소통 pane 이다. 워커가 올린 질문도 리드가 받아 묻는다. 워커 pane 에서 묻는 것은 지시서에 "직접 물어도 됨"이 있을 때만이다(4절).
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
- 워커와 리뷰어에게 실제 tmux 실측을 시킬 때는 지시서에 `tmux -L tfx-<이름>` 전용 소켓만 쓰고 `kill-server` 는 같은 `-L` 을 붙일 때만 하라고 적는다. 리드가 tmux 안에 있으면 워커 셸에 `TMUX` 가 상속되고, tmux 는 `$TMUX` 를 `TMUX_TMPDIR` 보다 우선하므로 `TMUX_TMPDIR` 격리는 사용자 기본 서버를 가리킬 수 있다.

## 11. 컨텍스트 점검

비율 기준은 `tfx-live` 스킬의 "컨텍스트 판단" 표를 따른다. 여기서는 재는 방법만 적는다.

- Claude daemon 은 `tfx-live probe`의 `contextPct`를 보고, agy 는 `tfx-live list-sessions --cli agy`의 `contextPct`와 `contextRecordedAt`을 본다. `tfx-live probe`는 Claude daemon 전용이며 `compactCount`는 노출하지 않는다.
- 직접 재야 하면 transcript 의 마지막 assistant 항목 `usage`에서 입력 계열 토큰(`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)을 더해 공식 모델 창과 실행 한도 중 작은 값으로 나눈다. Codex 는 rollout 의 마지막 토큰 사용량 이벤트로 같은 계산을 한다.
- 지시서에 보고 기준을 넣는다. 비율은 받는 세션의 CLI 에 맞춰 `tfx-live` 표의 준비·경고 열을 쓴다. 예: Claude 60%, Codex 실행 창(예: 475,000, `astra` 가족은 258,400) 60%, 실행 창 없는 미등록 1.05M 분모 15%, agy 12%. Claude와 Codex에는 "컨텍스트가 <비율>을 넘으면 작업을 멈추고 리드에게 보고하라", agy에는 "컨텍스트가 12%를 넘으면 리드에게 한 번 보고하고 작업을 이어가라"로 적는다.
- 재개한 세션(`--resume`)은 이전 사용량을 이어받으므로 재개 직후 한 번 잰다.
- 85%에 닿은 Claude 세션에는 새 작업을 주지 않고 바로 승계한다.
- 200k를 넘는 대화형 Claude 세션(리드 자신 포함)은 약 54분 유휴 시 호스트가 자동 유휴 압축할 수 있으므로, 50분 넘게 쉬게 둘 때는 파일에 없는 결정과 다음 행동을 먼저 남긴다.
- compact 때 triflux mod 가 요약 지시에 남길 항목(리드 역할, 인계 파일, 등록 워커, 열린 PR, 남은 일)을 붙인다(ADR-0045).
- 지시문을 주면 그 뒤에 합쳐진다. 그래서 지시문에는 이 항목 밖에서 남길 것만 적는다.

### 자기 세션 제어

리드는 내장 슬래시 명령을 직접 실행하지 못하므로 자기 세션의 compact, clear, exit 는 triflux mod 도구 `tfx_control`(`mcp__triflux-mods__tfx_control`)로 건다. 리드 세션 ID 는 `action: "whoami"`로 얻어 Claude 워커의 `tfx-live start --lead-session <ID>`에 넘긴다. 호출은 예약만 하므로 호출한 뒤 응답을 짧게 끝내야 실행된다. exit 는 `handoff`가 필수다. action 별 인자, 거부 조건, `tfx_control`이 없는 Codex와 agy 리드의 `tfx-live clear` 절차는 [references/self-session-control.md](references/self-session-control.md)를 따른다.

## 12. 운영 점검표

리드를 맡을 때, 워커를 띄울 때, 워커를 닫을 때의 점검표는 [references/checklist.md](references/checklist.md)다. 맨 앞 "상시 규칙"이 그 요약이다.

## 13. 정리, 삭제, 결함 수정 레인

코드를 지우거나 간헐 실패를 고치는 레인의 지시서에는 [references/cleanup-lane.md](references/cleanup-lane.md)의 기준을 넣는다.

## 소통 세션

리드와 따로 상주하며 사람과 이야기하는 세션이다. 소통 세션이 없으면 리드가 이 일을 겸한다. 띄우기는 `tfx lead <역할> --role communication`이고, 소통 세션이 따르는 절차는 `tfx-comm` 스킬이 정본이다. 리드 몫은 다음과 같다.

- 진행 상황을 `.omc/lead/status.md` 에 갱신한다.
- 사람이 리드에 직접 지시한 내용은 `.omc/lead/decisions.md` 에 남긴다.
- 소통에 직접 메시지를 보내는 것은 사람의 결정이 필요할 때와 완료 보고뿐이다.
- 문서와 회의 자료 워커는 소통에게, 코드 워커는 리드에게 보고하도록 지시서에 적는다.
