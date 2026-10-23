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

- triflux mod 가 대화형 세션에서 도구 `tfx_control`(`mcp__triflux-mods__tfx_control`)을 등록한다. 인자는 `target`, `action`(`compact`, `clear`, `exit`, `whoami`, `rebind`), `instructions`, `then`, `handoff`, `lead` 다. 리드가 쓰는 진입점은 이 도구 하나다.
- 이 도구는 `/tfx-lead <역할>` 을 실행한 세션에만 생기는 권한이다. 등록은 대화형 세션 시작 때 하고, 호출을 받을 때 리드 표지를 검사해 없으면 "이 세션은 리드가 아니다. /tfx-lead <역할> 을 먼저 실행한다." 로 거부한다. 리드 표지는 `/tfx-lead` 가 `$.store` 의 `tfx.lead.<세션 ID>` 에 남기는 역할과 시작 시각이다. `session.end`(resume 포함)에서 지우므로 resume 한 세션은 `/tfx-lead` 를 다시 실행해야 한다. `/clear` 는 같은 프로세스에서 세션 ID 만 바꾸므로 다음 호출 때 표지를 새 ID 로 옮긴다. 압박 감시의 `tfx.pressure.<세션 ID>` 와 같은 규칙이다.
- `target: self` 는 리드 자기 세션이다. 도구 훅은 요청을 검사한 뒤 마지막 await 뒤에 `$.clock.after(0, ...)` 로 `$.command.run` 을 예약하고 바로 결과를 돌려준다. 슬래시는 턴이 끝나 세션이 쉴 때 실행된다. tmux 안팎 구분이 없다.
- compact 는 `instructions` 를 `/compact` 인자로 넘긴다. compact 와 clear 가 끝나면 `$.prompt.submit` 으로 다음 프롬프트를 넣는다. clear 에 `handoff` 가 있으면 "인계 파일 <경로> 를 읽고 이어간다." 를 `then` 보다 먼저 넣는다.
- exit 는 `handoff` 가 없으면 거부한다. 사용자 승인 없는 자동 exit 규칙은 만들지 않는다. 도구는 리드가 명시적으로 호출할 때만 돈다.
- 실행 전 거부(인자 오류, 없는 인계 파일, exit 의 `handoff` 누락, 서브에이전트 안의 호출)는 도구 결과의 `deny` 로, 실행 뒤 실패(호스트의 슬래시 거부)는 다음 턴 prompt 로 알린다. 조용히 실패하지 않는다.
- 대상 확장: 같은 도구의 `target` 으로 `subagent:<이름>`, `claude:<이름>`, `codex:<이름>`, `agy:<이름>` 을 받는다. 대상마다 되는 동작은 구현하고, 안 되는 조합은 도구가 이유와 대안을 담은 오류로 돌려주며 `tfx-live` 스킬의 지원 표에 적는다.
- 도구는 리드 메인 대화 전용이다. 서브에이전트(`agentId` 가 있는 호출)는 어떤 대상도 제어할 수 없다.
- 이 기기 tmux 에서 찾은 Claude 와 Codex, agy 는 기존 `tfx-live compact`, `ask --via-tmux`, `stop` 으로 보낸다. 받는 쪽 검증은 없고 보호는 같은 사용자의 tmux 접근 권한뿐이다. Codex 의 `/new` 뒤 문장도 tmux 로 보낸다. 기본 queue 는 `/new` 뒤에도 옛 thread 로 가기 때문이다.
- tmux 에서 찾지 못한 Claude 는 `$.session.send` 로 `[tfx-control] {...}` 표식 피어 메시지를 보낸다. 받는 쪽 mod 의 `session.receive` 훅이 세 겹을 모두 통과한 메시지만 실행한다.
  - 발신 리드 검사: 보내는 쪽 `tfx_control` 은 리드 표지가 있는 세션의 메인 대화에서만 돈다.
  - plugin 출처: `e.origin.plugin === 'triflux-mods'` 이고 trim 한 본문 전체가 표식 한 줄일 때만 본다. 모델이 SendMessage 로 쓴 메시지에는 `origin.plugin` 이 없어 표식을 흉내 내도 실행되지 않고, 다른 글에 인용된 표식 줄도 실행되지 않는다.
  - 띄운 리드 묶기: `tfx-live start --lead-session <리드 세션 ID>` 가 워커 환경에 `TFX_LEAD_SESSION_ID` 를 넘기고, 받는 쪽 mod 가 `session.start` 에서 `$.store` 의 `tfx.control.lead.<자기 세션 ID>` 에 저장한다. 표식 메시지의 발신 세션 ID 가 저장값과 같을 때만 실행한다. 저장값이 없으면 모든 제어를 거부하고 발신자에게 알린다. 그래서 다른 리드도 이 워커를 제어하지 못한다.
- `session.receive` 의 origin 에는 발신 세션 ID 나 소켓 경로가 없다. 그래서 발신 세션 ID 는 보내는 쪽 mod 가 본문 `from` 에 적은 `$.session.id()` 를 쓴다. 이 값은 모델이 아니라 plugin 코드가 쓰므로 plugin 출처와 같은 수준의 주장이다. 이름은 `/rename` 으로 바뀌므로 쓰지 않는다.
- 리드는 `whoami` 로 자기 세션 ID 와 이름을 얻는다. 리드를 넘길 때는 원 리드가 `rebind` 로 워커의 묶인 리드를 새 ID 로 바꾼다. 받는 쪽은 지금 묶인 리드에게서 온 rebind 만 받는다. 원 리드가 이미 죽었으면 tmux 경로나 재시작으로 대신한다.
- 받는 쪽은 `$.prompt.submit` 을 쓰지 않는다. 남의 문장이 사용자 프롬프트로 올라가지 않게, 인계 줄과 `then` 은 `[tfx-control from <리드 이름>]` 머리말을 붙여 `tfx-peer self` 로 자기 세션 피어 메시지로 넣는다. 받는 쪽 exit 도 `handoff` 를 요구한다. 실행 결과, 거부, 실패는 보낸 리드에게 `[tfx_control] ...` 피어 메시지로 알린다.
- 다른 세션에 슬래시를 보내는 기존 `tfx-live compact`, `tfx-live ask` 경로는 그대로 둔다. mod 가 없는 세션의 tmux 자기 압축도 대안으로 남긴다.

## 검토한 대안 (Considered Options)

- **`tfx-live` 하위 명령만 두기**: 기존 tmux 경로를 넓히는 방식이다. tmux 밖에서 도는 리드 세션에는 슬래시를 넣을 입력 경로가 없다. 피어 메시지는 슬래시를 일반 텍스트로 넣는다. 기각.
- **사용자에게 입력을 요청하기**: 지금까지의 방식이다. 리드가 사용자 입력 없이 자기 세션을 관리하라는 요구와 반대다. 실행 뒤 실패했을 때의 마지막 수단으로만 남긴다. 기각.
- **`$.session.compact` 를 쓰기**: `/compact` 와 같은 호출이고 거부 사유를 `skip` 으로 받는다. 그러나 턴이 도는 동안 호출하면 거부되고, 도구 훅 뒤의 타이머는 아직 턴 안에서 돈다. clear 와 exit 에 대응하는 함수도 없다. `$.command.run` 은 세션이 쉴 때까지 기다려 세 동작을 같은 방식으로 다룬다. 기각.
- **`/tfx-lead` 를 실행할 때 도구를 등록하기**: 리드가 아닌 세션에는 도구가 아예 보이지 않는다. 그러나 `$.tool.register` 로 등록한 도구는 다음 프롬프트부터 모델에 보여 진입 직후 한 턴 동안 쓸 수 없고, resume 과 `/clear` 뒤에 등록을 다시 맞춰야 한다. 거부 검사 하나가 더 단순하다. 기각.
- **`$.store` 에 대상별 일회성 nonce 를 두기**: 리드가 대상별 nonce 를 store 에 쓰고 메시지에 실어 받는 쪽이 대조하는 방식이다. store 는 Claude 설정 디렉터리 아래 plugin 의 JSON 파일이라 `CLAUDE_CONFIG_DIR` 이 다른 세션끼리는 공유되지 않고, 동시에 도는 프로세스 사이에 쓰기가 바로 보이는지 문서에 없다. 같은 사용자의 프로세스는 그 파일을 직접 쓸 수도 있어 경계를 더 올리지 못한다. 띄울 때 환경으로 묶는 쪽을 골랐다. 기각.
- **adopt 한 세션이나 저장값 없는 세션을 첫 요청으로 묶기**: 먼저 보낸 리드가 묶이는 선착순 묶기라 다른 리드가 가로챌 수 있다. 기각.
- **대상마다 도구를 따로 두기**: 리드가 대상별로 이름을 외워야 한다. 요구가 진입점 하나를 원한다. 기각.

## 결과 (Consequences)

- 리드는 tmux 안팎과 관계없이 사용자 입력 없이 자기 세션을 압축하고 비우고 끝낼 수 있다. 실행은 도구를 부른 턴이 끝난 뒤라 리드는 호출 뒤 응답을 짧게 마쳐야 한다.
- triflux mod 가 설치된 Claude 세션에서만 된다. mod 가 없으면 도구가 목록에 없고, tmux 안이면 `tfx-live compact` 대안을 쓴다.
- 다른 플러그인 훅이 compact 를 건너뛰게 하면 `$.command.run` 이 거부로 끝나는지 정상 반환하는지 확인하지 못했다. 정상 반환이면 `then` 이 압축 없이 들어간다.
- 피어 경로의 Claude 는 받는 쪽에도 triflux mod 가 있고 `tfx-live start --lead-session` 으로 띄운 세션이어야 한다. `claude --bg`, 사용자가 연 세션, adopt 한 세션은 피어 경로로 제어할 수 없고 tmux 안이면 tmux 경로를 쓴다. 도구 결과는 전송만 확인한 것이고, 완료 알림이 오지 않으면 받는 쪽에 mod 가 없다.
- 보호 범위는 같은 사용자 안에서 모델과 다른 리드가 실수로든 의도로든 남의 세션을 제어하지 못하게 하는 데까지다. 같은 사용자의 프로세스가 `origin.plugin` 과 `from` 을 꾸며 보내는 것은 막지 못한다. 그 프로세스는 tmux 로 직접 입력할 수도 있기 때문이다.
- 실측 뒤 보강: 피어 메시지 본문에 봉투가 붙는지, 봉투에 발신 세션을 가리키는 값이 있는지 확인하고 표식 맞춤과 발신자 대조를 그 값에 맞춘다.
- 설치 뒤 확인: 실제 세션에서 도구 호출 뒤 턴이 끝나면 `/compact`, `/clear`, `/exit` 가 실행되는지, `/clear` 뒤 `$.prompt.submit` 이 새 대화에 들어가는지. 토큰을 쓰므로 머지와 설치 뒤 리드가 사용자에게 알리고 한 번 한다.
- 되돌릴 조건: 호스트가 모델의 내장 슬래시 실행을 허용하거나, mod API 에 clear 와 exit 함수가 생기면 그것으로 바꾼다.
