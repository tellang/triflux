# tmux 라이브 관전

**정책 SSOT**: `.claude/rules/tfx-execution-skill-map.md`의 `CLI tmux 관전 기본값`이 개별 CLI 디스패치를 언제 tmux로 관전할지 정한다.
이 문서는 그 정책을 구현하는 세션 생성·attach·정리·폭 배치 절차만 소유한다. 명시적 headless
선택은 rules의 예외대로 유지한다.

순서:

1. `createPsmuxSession` + `sendKeysToPane`(`hub/team/psmux.mjs`)으로 독립 세션을 만들고
   tfx-route.sh 커맨드를 흘려보낸다.
2. `tmux capture-pane`으로 폴링해 `[tfx-route] Codex 버전:` 같은 시작 배너를 확인한다.
3. 사용자가 attach해 있는 현재 tmux 창에 `tmux split-window` + `env -u TMUX`(nested-attach
   보호 해제)로 대상 세션에 attach한다.

정리는 반드시 `killPsmuxSession()`으로 한다 (raw `tmux kill-session` 금지: detach →
pipe capture 해제 → pane 프로세스 트리 종료 → 세션 종료 → orphan 정리 5단계를 대신
해준다).

**분할 비율** (triflux 자체 관례: OMC `main-vertical`의 고정 50:50과 다름):

| 상황 | 리더(기존 화면) : 워커전체 |
|------|---------------------------|
| 인터랙티브 워커 1개 이상 포함 | 5 : 5 |
| 전부 헤드리스 | 7 : 3 |

**워커 영역 배치: 폭 우선**: 워커가 2개 이상이면 각 워커에 배정되는 폭이 **최소 100 cols**인지
먼저 계산한다. 현재 전체 폭을 `W`, 워커 수를 `N`이라고 할 때 pane border 전의 근사치는
`5:5`에서 `W × 0.5 ÷ N`, `7:3`에서 `W × 0.3 ÷ N`이다. tmux border는 실제 폭을 더 줄이므로
경계값에서는 세로 스택을 택한다.

| 조건 | 배치 |
|------|------|
| 워커당 확보 폭이 100 cols 이상 | 워커 영역을 가로로(좌우) 균등분할 |
| 워커당 확보 폭이 100 cols 미만 또는 측정 불가 | `tmux select-layout even-vertical` 세로 스택 |

`100 cols`는 시작 배너가 접혀도 읽을 수 있도록 잡은 최소 폭이다.

예를 들어 `W=361`, 워커 2개이면 `5:5`는 워커당 약 90 cols, `7:3`은 약 54 cols라서 둘 다
세로 스택이다. 워커 3개면 각각 약 60/36 cols이며, 100 cols를 내려면 전체 폭이 `5:5`에서
최소 600 cols, `7:3`에서 최소 1000 cols가 필요하다. 따라서 3개 이상은 이 계산을 통과하는
드문 초광폭 화면이 아니면 세로 스택을 기본으로 한다.

**인터랙티브(진짜 TUI) 워커**: headless `codex exec`가 아니라 사람이 직접 타이핑
가능한 인터랙티브 세션이 필요하면 `tfx-live`를 쓴다 (raw `codex`/`agy` 직접 호출은
라우팅 규약이 금지하는 경로이므로 시도하지 않는다).

1. `tfx-live start --cli codex --session <name> --cwd <dir>`: 세션 생성.
2. 스킬 주입이 필요하면 `tfx-route.sh`의 `prepend_skill()` 포맷을 그대로 재현해
   프롬프트 앞에 붙인다 (tfx-live 자체엔 `--skill` 플래그가 없음):
   ```
   --- SKILL: <name> (workspace: <cwd>; apply this methodology to the task below) ---
   <skills/<name>/SKILL.md 본문>
   --- END SKILL ---
   <실제 프롬프트>
   ```
3. `tfx-live ask --cli codex --session <name> --prompt "<스킬+프롬프트 합친 텍스트>" --timeout <n>`
   로 실행을 지시한다. 기본 호출은 완료까지 기다리므로 진행 중 관전은 호출을 백그라운드로 실행하거나 `--no-wait`를 지정한다. 시작 배너와 처리 상태를 확인한 뒤 tmux attach한다.
4. 종료는 `tfx-live stop --session <name> --cli codex` (내부적으로
   세션을 정리한다). 세션의 마지막 프로세스가 죽으면(사람이 직접 codex를 종료해도)
   tmux 세션 자체가 같이 사라진다: `stop` 없이도 사람이 직접 끌 수 있다.

## 운영 시나리오

**바쁜 상태 처리**: tmux `ask`는 전송 전에 `waitForTmuxIdle`로 화면의 busy 및 Codex loading 상태를 확인한다. 기본 `--if-busy wait`는 준비될 때까지 기다린다. `fail`은 오류로 종료하고 `interrupt`는 Escape를 보낸 뒤 준비 상태를 기다린다. `--busy-timeout`으로 대기 시간을 정한다.

**인터럽트 후 즉시 새 프롬프트**: `tfx-live interrupt --session <name> --cli codex`
(Escape 전송) → 응답이 `aborted:true, reason:"user_interrupt"`이면 성공 → busy 해제
확인 후 곧바로 `ask` 호출 가능. 이후 응답을 확인한다.

**스킬 주입 실패 식별**: 두 가지 실패 모드가 있다.
- 기계적 실패(스킬 파일 없음): 프롬프트에 합치기 전에 `skills/<name>/SKILL.md` 존재를
  먼저 확인한다. 없으면 `tfx-route.sh`의 `prepend_skill()`과 동일하게 fail-open:
  경고만 하고 스킬 없이 원래 프롬프트로 진행한다.
- 정성적 실패(주입은 되었는데 codex가 방법론을 안 따름): 기계적으로 탐지할 수 없다.
  `response`에 스킬이 명시한 워크플로우 단계를 실제로 따른 흔적(예: tfx-review라면
  독립 리뷰 → 합의 판정 단계)이 있는지 사람이/Claude가 확인하는 수밖에 없다.

**이미 종료된 세션 resume**: `tfx-live start`의 `--resume <id>` / `--resume-last 1`로
codex 자체의 대화 이력을 새 tmux 세션에 이어붙인다. ID는 codex의 rollout 파일명에서
가져온다: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`
(또는 `~/.codex/session_index.jsonl`의 `id` 필드). 재개 후에는 이전 세션의 문맥이 이어졌는지 응답으로 확인한다.

**모델/effort: 새로 켤 때**: `tfx-live start`의 launch config는 프로필 설정을 참조한다.
`--model`과 `--effort`에는 해당 CLI가 받는 값을 전달한다.

**모델/effort 변경**: 현행 `tfx-live`는 시작 시 launch config로 모델과 effort를 전달한다.
실행 중인 세션의 `/model` 메뉴를 자동 조작하는 경로는 사용하지 않는다. 값을 바꿔야 하면
원하는 launch config로 새 세션을 시작하거나 기존 세션을 재시작한다. 모델 선택은
프로필과 launch config에서 관리한다.

**완료 판정/수집**: `ask`는 자체적으로 폴링한다: done-marker 방식(제출한 프롬프트
이후 새 응답이 나타나는지) 또는 fallback(화면이 조용해지고 composer가 준비 상태고
busy가 아닌 상태가 일정 횟수 지속). 결과는 `response`(정제된 텍스트), `done`,
`matchedCompletion` 필드로 온다. `response`가 실제 답변인지와 셸 프롬프트 잔재가
섞이지 않았는지를 확인한다.

**전송 방식**: `start`는 tmux 화면과 입력을 사용한다. Codex `ask`는 기본으로 `codex queue`에 쌓고 rollout에서 응답을 읽는다. 슬래시 명령과 queue를 못 쓰는 경우만 tmux 입력을 쓴다. 구조화된 Codex 채널은 `ask --cli codex --transport uds --thread <id|auto>`로 선택하며 세션 thread와 daemon의 이벤트로 응답을 수집한다.
