# 창 배치(macOS)

호출자가 매번 배치를 결정할 필요는 없다. Jev는 작업·역할·사람 입력 가능성과 기존 워커의 작업·worktree, window/tab/session ID·cols/rows·관리 태그로 만든 후보 ID만 고른다. 사용자 채팅 초안, 터미널 출력, 키 입력 본문은 읽거나 전송하지 않는다. 비활성·장애·낮은 신뢰도·잘못된 ID는 이유가 있는 규칙 폴백이다.

- 기본 focus preserve는 현재 window/tab/session과 다른 앱의 입력 대상을 유지한다. 각 창의 선택 탭 전체를 split/reconcile spec에서 제외하고 비활성 non-tmux 탭만 조작한다. 새 탭은 `select=False`로 만들며 생성 후 focus 복원에 의존하지 않는다. 명시 `start --focus` 또는 `tfx lead ... --focus`만 목적 있는 전환을 허용한다. 중요 역할은 `attention`으로 표시하고 자동 focus를 요청하지 않는다.
- 최소 가독성은 human/lead/communication 100 cols × 24 rows, standard 80 × 20, low-human compact 60 × 10이다. 가용 크기가 작으면 추가 분할 대신 독립 비활성 탭을 쓰고, 창 자체도 작으면 `verified: false`로 보고한다.
- `start --task '<요약>'`과 lead의 `--task`를 전달한다. 이름만 있으면 `taskInformation: insufficient`이고 background 자동 후보를 주지 않는다. 실제 task나 명시 `--human low`/`--background`가 있을 때만 background 후보를 허용하며 lead/high-human/communication은 자동으로 숨기지 않는다.
- 명시 `--layout tab|window|split-vertical|split-horizontal|background|off|legacy`에서도 preserve가 우선이다. 안전한 split이 없거나 window가 요청되면 비활성 탭 또는 background로 폴백하고 이유를 반환한다. `--background`, `--no-auto-layout`, `--layout off`, `TFX_ITERM_LAYOUT=0`은 UI 없이 tmux를 유지한다. legacy 생성은 `--layout legacy --focus`일 때만 허용한다. `TFX_ITERM_WATCH=0`은 watcher만 끈다.
- 설치된 iTerm Python runtime/API를 재사용한다. `TFX_ITERM_PYTHON`으로 경로를 지정할 수 있다. 없거나 연결이 실패하면 경고와 attach 가능한 background로 남기고 UI를 생성하지 않는다. `inspect`의 `background` 항목에 작업 정보·결정·attach 명령을 포함하며 `nativeSessionId: null`로 native view registry와 구분한다. 기존 `list-sessions --cli <종류>`와 `tmux attach-session -t '=세션'`으로 찾는다. registry의 `runtimeState: not_checked`는 실행 상태를 확인하지 않았다는 뜻이다.
- 프로젝트·호스트별 단일 watcher는 종료·이동·resize를 debounce한다. 모든 프로젝트는 같은 host의 전역 mutation lock 다음 프로젝트 lock 순서로 잠그고 대기 뒤 inventory를 다시 읽는다. watcher의 state 읽기·pin 저장도 같은 lock을 쓴다. 수동 이동 pin은 state에 유지하며 `reconcile --reset-pins`로만 해제한다. `--dry-run`은 pin을 해제하지 않는다. 사람이 옮긴 pane을 다른 탭과 임의로 합치지 않는다.
- 일반 셸/다른 프로젝트가 섞인 탭, tmux integration tab, 선택 탭, 명시 배치 탭은 재배치하지 않는다. 과밀한 관리 탭의 자동 분리도 비활성 탭을 사용한다. 자기 적용 결과는 fingerprint와 새 기준 위치로 흡수하며 관리 view가 없으면 watcher는 종료한다.
- `tfx-live inspect --cwd '<경로>'`, `tfx-live reconcile --dry-run --cwd '<경로>'`은 계획을 반환한다. 실제 적용은 `tfx-live reconcile --cwd '<경로>'`이다. `decision`, `applied`, `verified`는 각각 판단·UI 적용·실측이다. `focus.requested/effective/transitioned/reason`은 요청·유효 정책·전환 여부·미적용 이유를 구분한다. 부분 실패는 실제 inventory를 포함하고 자동 UI 재생성을 하지 않는다. watcher의 마지막 JSON은 사용자별 private temp의 `iterm-layout/*.last.json`에 있다.

## 로컬 tmux start 의 자동 배치

macOS의 iTerm2에서 로컬 tmux `start`는 프로젝트별 창에 attach 탭이나 pane을 자동 배치한다. `LC_TERMINAL=iTerm2` 또는 `TERM_PROGRAM=iTerm.app`일 때만 적용하며 원격·headless 경로는 유지한다. 프로젝트 키는 git 공통 디렉터리의 실제 경로이므로 같은 저장소의 worktree는 함께 묶이고, git 밖에서는 cwd의 실제 경로를 쓴다. 기존 소유 프로젝트 창, 로컬 리드 창 순으로 찾고 리드 ID가 없으면 현재 focus session의 창을 읽기 전용 anchor로 쓴다. 기본 preserve에서는 새 창을 만들지 않는다. 기본 그룹은 프로젝트 키이며 `--group NAME`으로 바꾼다. `peer`는 실행마다 참여자들을 한 그룹에 모으며 `--group`을 주면 그 값을 쓴다. 제목은 `--name`, 자동 이름, 세션 이름 순이며 새 pane의 custom command를 꺼 이후 Cmd+D가 같은 tmux에 중복 attach하지 않게 한다. `stop`은 registry와 소유 표식이 일치하는 ID만 닫는다. 기존 AppleScript 경로에서도 같은 TFX 세션 표식이 없는 사용자 view는 닫지 않는다. 연동 실패는 시작·종료를 막지 않고 `itermWarning`에 남긴다.
