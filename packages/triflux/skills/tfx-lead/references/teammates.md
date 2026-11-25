# Agent 도구 팀원 운영

## 팀원 표시 방식

근거는 공식 문서 [agent teams](https://code.claude.com/docs/en/agent-teams)다.

- Agent 도구를 `name` 과 함께 호출하면 팀원으로 뜬다. agent teams 가 켜져 있고 fork 나 `isolation` 호출이 아닐 때다. `name` 을 빼면 pane 없이 같은 프로세스 안에서 도는 보통 서브에이전트가 된다.
- 팀원 표시는 `teammateMode` 설정(`in-process`, `auto`, `tmux`, `iterm2`)이 정한다. 공식 기본값은 `in-process` 고, `auto` 는 tmux 안이거나 iTerm2 에 `it2` 가 있으면 pane 을 나눈다. 세션 하나만 바꾸려면 `claude --teammate-mode <값>` 으로 띄운다. 사용자 설정이 `auto` 나 `tmux` 면 tmux 안의 리드는 팀원마다 리드 창을 나눈다. `~/.claude/settings.json` 의 `teammateMode` 로 확인한다.
- 실행 중인 세션에서 `teammateMode` 를 바꾸면 바로 적용되는지는 공식 문서에서 확인 못 했다. 화면 폭에 따라 모드를 바꾸는 기능은 공식 문서에 없다.

리드 pane 폭을 `tmux display -p -t "$TMUX_PANE" '#{pane_width}'` 로 재고 다음처럼 띄운다.

| 리드 pane 폭 | 띄우는 방법 |
| --- | --- |
| 200 cols 이상 | 지금처럼 `name` 을 붙인 팀원. pane 분할 관전 가능 |
| 200 cols 미만 | `name` 없이 `run_in_background: true` 서브에이전트. 완료는 알림으로 받는다. 오래 가거나 다시 쓸 워커는 SKILL.md 3절 표대로 `tfx-live start` 별도 세션으로 띄우고 tmr 로 본다 |
| 처음부터 좁은 화면에서 리드를 띄울 때 | `claude --teammate-mode in-process` 로 시작한다. 팀원은 리드 창 아래 에이전트 패널에 뜨고 화살표와 Enter 로 본다 |

- 200 cols 는 워커 pane 한 개에 최소 100 cols 가 있어야 시작 배너가 접히지 않고 읽힌다는 기준(`tfx-auto` 의 tmux 관전 배치와 같다)을 두 배 한 값이다. 팀원 pane 이 리드 창을 좌우로 나누므로 나뉜 뒤에도 리드 쪽이 100 cols 를 지키려면 나누기 전 폭이 그 두 배는 돼야 한다. 호스트가 나누는 비율은 실측하지 못했고, 2026-10-23 팀원 12개가 쌓였을 때 리드 pane 이 26 cols 까지 줄었으므로 팀원이 늘면 리드 쪽은 절반보다 더 좁아진다. 그래서 띄우기 전마다 다시 재고, 넓은 화면에서도 끝난 팀원은 아래대로 바로 닫는다.
- 버린 대안: 사용자 설정 `env` 에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0` 을 넣으면 실행 중인 세션에도 바로 적용돼 이름 붙인 서브에이전트가 팀원이 되지 않는다. 하지만 같은 설정을 읽는 다른 세션까지 모두 바뀌므로 쓰지 않는다. `name` 을 빼는 것으로 이 리드만 바꿀 수 있다.

## 끝난 팀원 닫기

팀원은 끝나도 pane 과 Claude 프로세스가 남고, 프로세스마다 MCP 서버를 따로 띄운다. 2026-10-23 끝난 팀원 10개가 MCP 서버를 각 5개씩 쥐고 메모리 압박 2 를 만들었고, 그 pane 들을 닫자 바로 1 로 내려갔다. 결과를 받은 팀원은 바로 닫는다.

1. 그 팀원의 완료 알림(최종 답이 들어 있는 idle 알림)이나 결과 파일을 받았는지 확인한다. 아직 일하는 팀원은 닫지 않는다.
2. 팀원에게 종료를 요청한다(SendMessage 의 shutdown_request). 팀원이 승인하면 스스로 끝난다. 공식 문서는 진행 중인 요청을 마친 뒤 끝나므로 느릴 수 있다고 적는다. 팀원이 거절하면 이유를 읽고 닫지 않는다. 3단계는 승인한 뒤에도 pane 이 남은 경우에만 한다.
3. 승인한 뒤에도 pane 이 남았으면 pane 을 이름으로 대조한다. 팀원 pane 의 시작 명령에는 `--agent-id <팀원 이름>@<팀 이름>` 이 들어 있다.

```bash
tmux list-panes -s -t "$TMUX_PANE" -F '#{pane_id} #{pane_current_command} #{pane_start_command}' | grep -- '--agent-id <팀원 이름>@'
```

4. 나온 pane 이 정확히 하나이고, 리드 자신(`$TMUX_PANE`)이 아니고, 1 에서 완료를 확인한 이름일 때만 `tmux kill-pane -t <pane_id>` 로 닫는다. 이름이 겹치거나 둘 이상 나오면 닫지 않고 사용자에게 묻는다. `--agent-id` 가 없는 pane 은 사용자가 띄운 것이므로 건드리지 않는다.
5. 닫은 뒤 같은 명령으로 그 pane 이 사라졌는지 본다.

리드 세션의 triflux mod 가 2분마다 팀원 명단을 잰다. 이름 있는 팀원이 10분 넘게 쉬면 "열린 팀원 N개" 피어 메시지를 리드에게 보내고, 그 뒤 10분이 더 지나도 열려 있으면 그 팀원에게 shutdown_request 를 보낸다. pane 을 직접 닫지는 않으므로 승인한 뒤에도 남은 pane 은 위 3, 4단계로 닫는다.
리드가 다시 SendMessage 를 보낸 팀원은 유휴 시계가 처음부터 다시 간다. 리뷰를 기다리는 작성자처럼 일부러 남길 팀원은 `/tfx-keep <이름>` 으로 표시한다. 알림에는 "(유지)" 로 나오고 종료 요청에서 빠진다. 풀 때는 `/tfx-keep <이름> off`.
Claude 서브에이전트와 in-process 팀원은 기본 5분 캐시이므로, 5분 넘게 띄워 같은 서브에이전트에 재질의하면 매번 캐시 미스가 난다.
