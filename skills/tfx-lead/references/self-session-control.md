# 자기 세션 제어

리드는 내장 슬래시 명령을 직접 실행하지 못한다. 자기 세션의 compact, clear, exit 는 triflux mod 도구 `tfx_control`(`mcp__triflux-mods__tfx_control`)로 건다. tmux 안팎 모두 같다. 리드가 띄운 Claude, Codex, agy 세션과 서브에이전트에도 같은 도구의 `target` 으로 보낸다. 대상별로 되는 동작은 `tfx-live` 스킬의 "대상별 제어 지원" 표다.

| action | 인자 | 동작 |
| --- | --- | --- |
| compact | `instructions` 요약 지시문, `then` 압축 뒤 다음 프롬프트 | 이 턴이 끝나면 `/compact <instructions>`, 끝난 뒤 `then` 을 prompt 로 넣는다 |
| clear | `handoff` 인계 파일 경로, `then` | 인계 파일을 먼저 쓴다. 턴이 끝나면 `/clear`, 그 뒤 "인계 파일 <경로> 를 읽고 이어간다." 와 `then` 을 차례로 넣는다 |
| exit | `handoff` 필수 | 사용자가 끝내라고 했거나 승계 세션이 인계 파일을 받기로 했을 때만 쓴다. 턴이 끝나면 `/exit` |

- 리드 세션 ID 는 `tfx_control` 의 `action: "whoami"` 로 얻는다. Claude 워커를 띄울 때 `tfx-live start --lead-session <ID>` 로 넘겨야 그 워커가 tmux 밖 피어 경로의 요청을 이 리드에게서만 받는다.
- `/tfx-lead <역할>` 을 실행한 세션에서만 받는다. 아니면 "이 세션은 리드가 아니다" 로 거부된다. `/clear` 뒤에는 권한이 이어지고, resume 한 세션은 `/tfx-lead` 를 다시 실행한다.
- 호출은 예약만 한다. 호출한 뒤 응답을 짧게 마쳐야 턴이 끝나고 실행된다.
- 인자 오류, 없는 인계 파일, exit 의 `handoff` 누락, 서브에이전트 안의 호출은 도구 결과로 거부된다. 실행 뒤 호스트가 슬래시를 거부하면 다음 턴에 `[tfx_control] /<action> 실패: ...` prompt 가 온다. 그때는 사용자에게 직접 입력을 부탁한다.
- `tfx_control` 이 없는 Codex 리드와 agy 리드는 인계 파일을 먼저 쓰고 `tfx-live clear --cli <codex|agy> --session "$TMUX_PANE" --if-busy wait --busy-timeout 600 --handoff <경로>` 를 `nohup ... > <결과 파일> 2>&1 < /dev/null &` 꼴로 백그라운드에 보낸다. 턴이 끝나면 `/new`(Codex) 나 `/clear`(agy) 를 보내고 "인계 파일 <경로> 를 읽고 이어간다." 를 이어서 보낸다. 비우면 `tfx-lead` 스킬 내용도 문맥에서 사라지므로 `--then` 에 `tfx-lead` 스킬 파일을 다시 읽고 리드를 이어 맡으라는 문장을 싣는다. 샌드박스가 강제된 agy 세션에서는 `run_command` 에 `BypassSandbox: true` 를 붙인다. 그 인자가 없는 세션에서는 붙이지 않는다.
- 도구가 목록에 없으면 triflux mod 가 설치되지 않은 세션이다. tmux 안이면 `tfx-live compact --session "$TMUX_PANE" --if-busy wait ...` 를 쓰고, 밖이면 사용자에게 부탁한다.
