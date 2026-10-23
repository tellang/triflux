---
id: 0044
title: 리드의 compact, clear, exit 는 triflux mod 도구 하나로 건다
status: proposed
date: 2026-10-23
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0042, 0043]
pr: null
---

# ADR-0044: 리드의 compact, clear, exit 는 triflux mod 도구 하나로 건다

## 컨텍스트와 문제 (Context)

호스트는 모델이 `/compact`, `/clear`, `/exit` 같은 내장 슬래시 명령을 직접 실행하지 못하게 한다. 의도된 설계다. 그래서 리드는 자기 세션을 압축하거나 비우거나 끝낼 수 없었다. tmux 안의 Claude 만 `tfx-live compact --session "$TMUX_PANE"` 로 자기 압축이 됐고, tmux 밖 세션과 clear, exit 는 경로가 없었다. 리드가 띄운 서브에이전트, Claude, Codex, agy 세션도 대상마다 방법이 달라 리드가 따로 외워야 했다.

mod API 에서 `$.tool.register` 는 모델이 호출하는 도구를 만들고, `$.command.run` 은 사람이 친 것처럼 슬래시 명령을 세션이 쉴 때 실행한다. `$.command.run` 은 턴이 기다리는 훅 안에서 거부되며, 그 훅이 도는 동안 발화한 타이머의 호출도 거부된다(ADR-0042 실측).

## 결정 (Decision)

- triflux mod 가 대화형 세션에서 도구 `tfx_control`(`mcp__triflux-mods__tfx_control`)을 등록한다. 인자는 `target`, `action`(`compact`, `clear`, `exit`), `instructions`, `then`, `handoff` 다. 리드가 쓰는 진입점은 이 도구 하나다.
- `target: self` 는 리드 자기 세션이다. 도구 훅은 요청을 검사한 뒤 마지막 await 뒤에 `$.clock.after(0, ...)` 로 `$.command.run` 을 예약하고 바로 결과를 돌려준다. 슬래시는 턴이 끝나 세션이 쉴 때 실행된다. tmux 안팎 구분이 없다.
- compact 는 `instructions` 를 `/compact` 인자로 넘긴다. compact 와 clear 가 끝나면 `$.prompt.submit` 으로 다음 프롬프트를 넣는다. clear 에 `handoff` 가 있으면 "인계 파일 <경로> 를 읽고 이어간다." 를 `then` 보다 먼저 넣는다.
- exit 는 `handoff` 가 없으면 거부한다. 사용자 승인 없는 자동 exit 규칙은 만들지 않는다. 도구는 리드가 명시적으로 호출할 때만 돈다.
- 실행 전 거부(인자 오류, 없는 인계 파일, exit 의 `handoff` 누락, 서브에이전트 안의 호출)는 도구 결과의 `deny` 로, 실행 뒤 실패(호스트의 슬래시 거부)는 다음 턴 prompt 로 알린다. 조용히 실패하지 않는다.
- 대상 확장: 같은 도구의 `target` 으로 `subagent:<이름>`, `claude:<이름>`, `codex:<이름>`, `agy:<이름>` 을 받는다. 대상마다 되는 동작은 구현하고, 안 되는 조합은 도구가 이유와 대안을 담은 오류로 돌려주며 `tfx-live` 스킬의 지원 표에 적는다. 이 확장은 후속 변경에서 구현한다. 이 결정의 첫 변경은 `self` 만 구현하고 나머지 대상은 오류로 돌려준다.
- 다른 세션에 슬래시를 보내는 기존 `tfx-live compact`, `tfx-live ask` 경로는 그대로 둔다. mod 가 없는 세션의 tmux 자기 압축도 대안으로 남긴다.

## 검토한 대안 (Considered Options)

- **`tfx-live` 하위 명령만 두기**: 기존 tmux 경로를 넓히는 방식이다. tmux 밖에서 도는 리드 세션에는 슬래시를 넣을 입력 경로가 없다. 피어 메시지는 슬래시를 일반 텍스트로 넣는다. 기각.
- **사용자에게 입력을 요청하기**: 지금까지의 방식이다. 리드가 사용자 입력 없이 자기 세션을 관리하라는 요구와 반대다. 실행 뒤 실패했을 때의 마지막 수단으로만 남긴다. 기각.
- **`$.session.compact` 를 쓰기**: `/compact` 와 같은 호출이고 거부 사유를 `skip` 으로 받는다. 그러나 턴이 도는 동안 호출하면 거부되고, 도구 훅 뒤의 타이머는 아직 턴 안에서 돈다. clear 와 exit 에 대응하는 함수도 없다. `$.command.run` 은 세션이 쉴 때까지 기다려 세 동작을 같은 방식으로 다룬다. 기각.
- **대상마다 도구를 따로 두기**: 리드가 대상별로 이름을 외워야 한다. 요구가 진입점 하나를 원한다. 기각.

## 결과 (Consequences)

- 리드는 tmux 안팎과 관계없이 사용자 입력 없이 자기 세션을 압축하고 비우고 끝낼 수 있다. 실행은 도구를 부른 턴이 끝난 뒤라 리드는 호출 뒤 응답을 짧게 마쳐야 한다.
- triflux mod 가 설치된 Claude 세션에서만 된다. mod 가 없으면 도구가 목록에 없고, tmux 안이면 `tfx-live compact` 대안을 쓴다.
- 다른 플러그인 훅이 compact 를 건너뛰게 하면 `$.command.run` 이 거부로 끝나는지 정상 반환하는지 확인하지 못했다. 정상 반환이면 `then` 이 압축 없이 들어간다.
- 설치 뒤 확인: 실제 세션에서 도구 호출 뒤 턴이 끝나면 `/compact`, `/clear`, `/exit` 가 실행되는지, `/clear` 뒤 `$.prompt.submit` 이 새 대화에 들어가는지. 토큰을 쓰므로 머지와 설치 뒤 리드가 사용자에게 알리고 한 번 한다.
- 되돌릴 조건: 호스트가 모델의 내장 슬래시 실행을 허용하거나, mod API 에 clear 와 exit 함수가 생기면 그것으로 바꾼다.
