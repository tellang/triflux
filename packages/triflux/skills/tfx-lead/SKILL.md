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
| 같은 세션 안 서브에이전트 | Agent 도구 (`model`, `effort`, `run_in_background`) | `spawn_agent`, 끝나면 반드시 `close_agent` |
| Claude 세션에 보내기 | `SendMessage`(팀원), 그 밖은 `tfx-live ask --cli claude` | `tfx-live ask --cli claude --transport uds --short <8hex> --no-wait`(백그라운드 세션), tmux 세션은 `--session <이름> --no-wait` |
| Codex 세션에 보내기 | `tfx-live ask --cli codex` (기본 codex queue) | `tfx-live ask --cli codex` (기본 codex queue) |
| 사용자에게 묻기 | `AskUserQuestion` | 답변에서 짧은 선택지로 묻는다 |
| 배경 대기 | `run_in_background`와 완료 알림 | 백그라운드 셸 또는 `tfx-live wait`(아래 5절의 지원 범위 안에서) |

- Codex 리드는 `spawn_agent`를 29회 부르고 `close_agent`를 한 번도 부르지 않은 사고가 있었다. 서브에이전트는 결과를 받은 즉시 닫는다.
- Codex 리드는 보내기 전용으로 `--timeout 5`를 남발하고 `tmux capture-pane`으로 완료를 확인한 사고가 있었다. 보낼 때는 `--no-wait`, 완료는 5절의 확인 수단으로만 확인한다.

## 1. 역할과 수명

띄운 쪽이 그 세션의 생성, 이름, 컨텍스트, 승계, 종료를 소유한다. 서브에이전트를 부른 세션도 같다.

- 이름: `<월>.<일> <주제>`. 승계 세션은 기존 이름 뒤에 ` 2`, ` 3`.
- 승계 순서:
  - 인계 파일을 쓴다. 목표, 완료 조건, 체크아웃 상태, 확정 결정, 증거 경로, 미완료, 다음 행동, `predecessorSessionId`를 담는다.
  - 승계 세션이 경로를 읽고 ACK 한다.
  - ACK 를 받은 뒤에만 원 세션을 닫는다.
- 닫은 뒤에는 남은 세션이 없는지 확인한다. `tmux ls`가 기본이고, `tmr`가 있으면 `tmr ls --json`을 쓴다.

```bash
tmux ls
tmr ls --json   # 선택 도구, 있을 때만
```

## 2. 역할별 모델

모델 ID 는 적지 않는다. Codex 는 프로필명, Claude 는 별칭을 쓴다. 현재 대응은 `.claude/rules/tfx-routing.md`의 "모델 배치" 표가 정본이다.

| 역할 | 모델 | 비고 |
| --- | --- | --- |
| 리드 (Claude) | Claude 최상위 tier, effort high | 지휘와 판정만 맡는다 |
| 리드 (Codex) | `gpt6_astra_xhigh` | 지휘와 판정만 맡는다 |
| 판단 중심 긴 작업 | Claude `opus` | 설계 검토, 긴 구현 |
| 반복 검증, 정형 문서 | Claude `sonnet` | 테스트 재실행, 표 갱신 |
| `opus`로 안 풀리는 난제 | Claude `fable` | 최종 수단 |
| Codex 설계, 비평, 디버그 | `gpt6_astra_xhigh` | |
| Codex 일반 구현, 리뷰 | `gpt61_sol_high` | |
| Codex 정리 | `gpt61_sol_med` | |
| Codex 반복 작업 | `gpt6_luna_high` | |
| Codex 시험용 | 역할 프로필에 effort low | 연결 확인용 |

- Codex 주간 한도가 낮으면 새 Codex 워커 대신 Claude 로 돌린다.
- 세션을 띄울 때마다 사용자에게 한 줄로 알린다: "이 역할에 이 모델, tmux 세션명 `<이름>`(`tmr` 대상)".
- 서브에이전트(Agent 도구, `spawn_agent`)는 tmux 에 보이지 않는다. 알릴 때 그렇다고 밝힌다.

## 3. 부르는 방법

| 용도 | 수단 |
| --- | --- |
| 오래 가는 작업 세션 | `tfx-live start`로 tmux 에 띄운다. 사람이 tmux 로(`tmr`가 있으면 그것으로) 본다 |
| 일회성 판단, 리뷰 | 서브에이전트. 리드 CLI 별 도구는 위 표, model과 effort 를 지정하고 백그라운드로 |
| 일회성 Codex 작업 | `tfx-route.sh` 역할 호출 |
| 기존 Claude 세션에 요청 | 위 표의 "Claude 세션에 보내기" |
| 기존 Codex 세션에 요청 | `tfx-live ask --cli codex`(기본 codex queue) |
| 무거운 전체 테스트 | 원격 격리 호스트. `tfx-remote probe`를 먼저 돌린다 |

```bash
tfx-live start --cli claude --session cl-doc --name "10.8 문서 정리" --model opus --effort high
tfx-live start --cli codex --session cx-impl --name "10.8 구현"
tfx-live ask --cli codex --session cx-impl --prompt "<지시서 경로>를 읽고 시작해줘" --no-wait
```

- Codex 에 슬래시 명령(`/compact`, `/rename`, `/new`)을 보낼 때만 tmux 직접 입력을 쓴다. queue 로 보내면 일반 텍스트가 된다.
- 원격 호스트나 thread 를 못 찾는 경우의 tmux 폴백은 결과의 `fallbackReason`으로 확인한다.
- 같은 cwd 에 Codex TUI 가 여럿이면 `--thread UUID`를 명시한다.

## 4. 지시 전달

긴 지시는 지시서 파일에 쓰고 프롬프트에는 경로만 보낸다.

- 위치: 저장소가 무시하는 경로(`.omc/briefs/` 같은 곳).
- 구성: 목표, 범위, 건드리지 않을 것, 완료 조건, 결과 파일 경로, 보고 형식.
- 방향이 바뀌면 지시서 끝에 "정정" 절을 덧붙이고, 그 절이 앞 절을 대체한다고 적는다. 앞 절은 지우지 않는다.
- 첫 지시를 보낸 뒤 작업이 실제로 시작됐는지 확인한다. tmux 직접 입력은 첫 지시가 유실된 사례가 있다.
- 긴 프롬프트를 tmux 에 직접 입력하지 않는다. 화면이 깨진다.

## 5. 결과 회수

결과는 파일(`.result.md`)과 짧은 보고로 받는다.

- 화면 폴링(`tmux capture-pane` 반복)은 하지 않는다.
- 대기하는 동안 리드는 다른 레인을 진행한다.
- 서브에이전트의 완료는 알림으로 안다(Claude 는 `run_in_background`, Codex 는 `spawn_agent` 결과). PR CI 는 백그라운드로 감시한다.
- 띄워 둔 세션의 완료는 `tfx-live wait`가 지원하는 범위에서만 쓴다.

| 대상 세션 | 완료 확인 |
| --- | --- |
| Claude 백그라운드(daemon) 세션 | `tfx-live wait --cli claude --short <8hex> --request-id <id>` (로컬 UDS 만, `--session`은 받지 않는다) |
| Codex 세션 | `tfx-live wait --cli codex --session <tmux 이름> --request-id <id>` 또는 `--thread <UUID>` |
| tmux 로 띄운 대화형 Claude 세션, Claude 리드 | 그 세션이 지시서의 보고 규칙에 따라 `SendMessage`로 보고한다 |
| `tfx multi` headless 실행 | 백그라운드 작업 알림 뒤 `$TMPDIR/tfx-headless/<세션>.results.json` 의 `completed` 와 워커별 `status`, `exitCode` 를 읽는다. 완료 마커 문자열은 해석하지 않는다 |
| tmux 로 띄운 대화형 Claude 세션, Codex 리드 | 현재 `wait` 미지원. 지시서에 결과 파일 경로를 정해 두고 그 파일의 생성을 백그라운드 셸로 감시한다 |

```bash
tfx-live ask --cli claude --transport uds --short <8hex> --prompt "<지시서 경로>" --no-wait
tfx-live wait --cli claude --short <8hex> --request-id <requestId> --timeout 600
```

- `timedOut: true`는 완료가 아니다. 재전송하지 않고 상태를 먼저 확인한다.
- `status: "unknown"`도 재전송하지 않는다.

## 6. 교차 리뷰와 머지

작성 모델과 다른 모델이 리뷰한다. 기본은 CLAUDE.md 의 교차 검증 규칙이다.

| 작성 | 리뷰 |
| --- | --- |
| Claude | Codex |
| Codex | Claude |

- Codex 를 못 쓸 때(주간 한도, 미설치)만 폴백한다. 작성과 다른 Claude 모델(`opus`로 쓴 글은 `fable` 또는 `sonnet`, `sonnet`으로 쓴 글은 `opus`)이나 Antigravity 로 리뷰한다.
- 한도가 낮을 때의 대체 순서는 `.claude/rules/tfx-routing.md`의 CLI 우선순위(1차 Codex, 2차 Antigravity)를 따른다.

- 머지 조건은 CI 통과와 교차 리뷰 통과, 둘 다다.
- 리뷰에서 사실 오류가 나오면 처음 작성자에게 되돌려 고친다. 같은 리뷰어가 재확인한다.
- 리드가 대신 고치고 스스로 승인하지 않는다.
- 리뷰 요청에도 지시서 경로를 쓰고, 리뷰 결과는 파일로 받는다.

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
- [ ] 사용자에게 모델과 tmux 세션명을 알렸다
- [ ] 지시서 경로를 보냈고 작업 시작을 확인했다
- [ ] 세션 CLI 에 맞는 컨텍스트 보고 기준이 지시서에 있다

세션을 닫을 때:

- [ ] 결과 파일을 읽었다
- [ ] 필요하면 인계 파일과 승계 ACK 를 확인했다
- [ ] 닫은 뒤 `tmux ls`(또는 `tmr ls --json`)로 확인했다
