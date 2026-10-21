---
id: 0043
title: 확정한 압박 전이는 리드 자기 세션에 피어 메시지로 보낸다
status: accepted
date: 2026-10-21
deciders: [tellang]
supersedes: [0042]
superseded_by: null
relates: [0040, 0041]
pr: null
---

# ADR-0043: 확정한 압박 전이는 리드 자기 세션에 피어 메시지로 보낸다

## 컨텍스트와 문제 (Context)

ADR-0042 는 확정한 압박 전이를 `$.prompt.submit` 으로 넣었다. mod 타입 문서상 플러그인의 `$.prompt.submit` 은 세션이 쉴 때만 실행되고, 피어 세션의 메시지(queued delivery)는 실행 중인 턴 안에서 모델에 닿는다(`PromptSubmitInput.turnId` 설명). 그래서 리드가 긴 턴을 도는 동안 압박이 4 로 올라가도 턴이 끝날 때까지 모른다. 사용자는 도구 결과의 `context` 에 붙이는 방식이 아니라 진짜 피어 메시지로 넣는 방식을 골랐다.

mod 는 Claude 프로세스 안에서 돌고 SendMessage 도구를 직접 호출할 수 없다. `tfx-peer` 는 Claude 에서 Claude 로 보내는 요청을 "native SendMessage 를 쓰라"며 거부한다. `hub/team/native-peer.mjs` 의 `deliverClaude` 는 세션 ID 로 수신 소켓을 찾아 `<cross-session-message>` 프레임을 넣는다.

## 결정 (Decision)

- 압박 감시, 명령, 리드 진입은 ADR-0042 의 결정을 그대로 잇는다. 상주 프로세스 없이 리드 세션의 triflux mod 가 2초마다 `kern.memorystatus_vm_pressure_level` 을 읽고, 1, 2, 4 만 유효로 보며, 다른 단계가 새 표본 두 번 연속 같을 때 확정한다. 표본 간격이 5초를 넘으면 후보를 버린다. `/clear` 뒤에는 등록을 새 세션 ID 로 옮기고 세션이 끝나면 지운다. macOS 대화형 세션만 지원한다. 명령은 `/tfx-pressure on|off|status` 이고 저장 키는 `tfx.pressure.<sessionId>` 다. `/tfx-lead <역할>` 은 세션 이름을 바꾸고 압박 감시를 켜고 `tfx-lead` 스킬 지시를 `context` 에 넣는다. 이름 변경은 훅이 끝난 뒤 `$.clock.after(0, ...)` 로 `$.command.run({ command: 'rename' })` 을 호출하고 거부되면 토스트로 알린다.
- 확정한 전이는 먼저 `tfx-peer self --session <자기 세션 ID> --message <본문>` 으로 리드 자기 세션에 피어 메시지로 넣는다. 세션 ID 는 보낼 때 `$.session.id()` 로 다시 읽는다. `tfx-peer self` 는 수신 소켓 이름(`<pid>.sock`)이 자기 부모 PID(`process.ppid`)와 맞을 때만 `deliverClaude` 로 보내고, 본문에 `[tfx-peer from=...]` 머리와 회신 경로를 붙이지 않는다. `tfx-peer send` 의 Claude 대상 거부는 그대로 둔다. mod 의 `$.process.run` 자식은 Claude 프로세스 바로 밑에 뜬다(2026-10-21 `ps` 로 확인, 별도 플러그인 호스트 프로세스 없음). 그래서 호출자가 바꿀 수 있는 `CLAUDE_PID` 환경 변수 대신 부모 PID 를 쓴다.
- 피어 전송이 실패하면 `$.prompt.submit` 으로 보낸다. 실패는 exit 0 과 `status: "written"` 이 아닌 모든 결과다. 소켓이나 세션 기록이 없을 때, 명령이 없거나 실패했을 때, 10초 시간 초과, 결과 불명(`unknown`)이 모두 여기에 든다. 폴백한 본문 끝에 "피어 메시지 전송이 실패해 턴이 끝난 뒤 도착하는 prompt.submit 으로 보냈다 (이유)" 한 줄을 붙인다. 이유는 JSON 결과면 `status` 와 `error` 를 뽑고, 아니면 stderr 를 한 줄로 바꿔 200자로 자른다. 보내는 사이 `/tfx-pressure off` 나 세션 종료로 감시가 꺼졌으면 폴백하지 않는다.
- 보내는 동안 확정된 전이는 지금처럼 합친다. 보내기가 끝난 뒤 확정 단계가 달라져 있으면 한 번 더 보낸다. 피어 경로는 1초 안쪽에 끝나서 두 표본(4초)이 필요한 전이가 그 사이 거의 쌓이지 않는다. 폴백 경로는 `$.prompt.submit` 이 턴을 열 때까지 기다리므로 ADR-0042 와 같이 마지막 상태 하나로 합쳐진다. 그래서 한 루프를 두 경로가 같이 쓴다.
- 본문은 ADR-0042 의 문구(`[memory-pressure] 압박 단계가 X 에서 Y 로 바뀌었다 ...`)를 유지한다. 전이별 대응은 `skills/tfx-lead/SKILL.md` "압박 변화 대응" 절이 정본이다.

## 검토한 대안 (Considered Options)

- **도구 결과의 `context` 에 붙이기**: 다음 도구 호출 결과에 실려 턴 안에서 읽힌다. 도구를 부르지 않는 긴 생성 중에는 닿지 않고, 사용자가 피어 메시지 방식을 골랐다. 기각.
- **`tfx-peer send` 의 Claude 대상 거부를 자기 세션일 때만 풀기**: 새 하위 명령이 없다. 그러나 `send` 는 이름으로 대상을 찾고 본문에 보낸 쪽 머리와 회신 경로를 붙여서, 자기에게 보내는 알림에는 맞지 않는 줄이 생기고 이름 해석과 후보 탐색(tmux, ps)을 매번 돈다. 기각.
- **새 bin 진입점 두기**: `package.json` bin, 미러, 설치 승인 규칙이 하나씩 늘어난다. 기존 `tfx-peer` 에 하위 명령 하나를 더하는 쪽이 작다. 기각.
- **피어 경로에서 합치기 없애기**: 피어 메시지는 턴 도중에도 닿으므로 전이마다 따로 보낼 수 있다. 그러나 폴백 경로는 합치기가 필요하고, 경로마다 루프를 따로 두면 코드만 늘어난다. 보내는 중 동시에 두 번 보내지 않는 효과도 잃는다. 기각.
- **결과 불명이면 폴백하지 않기**: 중복을 피한다. 그러나 압박 알림은 빠지는 쪽이 겹치는 쪽보다 해롭고, 본문이 `/tfx-pressure status` 확인을 지시하므로 중복은 확인 한 번으로 끝난다. 기각.

## 결과 (Consequences)

- 리드가 긴 턴 중이어도 확정한 전이가 그 턴 안에 전이마다 따로 닿는다. 마지막 상태 하나로 합쳐져 턴이 끝난 뒤 오는 것은 폴백했을 때뿐이다.
- 결과 불명 뒤 폴백하면 같은 전이가 두 번 올 수 있다.
- `deliverClaude` 는 프레임에 `from-mode="prompting"` 을 적는다. 리드가 다른 권한 모드(bypass 등)일 때 수신 쪽이 이 메시지를 사용자 승인 대기로 잡는지는 확인하지 못했다. 잡으면 전송은 `written` 으로 성공해 폴백도 일어나지 않는다. 설치 뒤 리드가 확인하고, 잡히면 이 결정을 다시 본다.
- 부모 PID 대조는 같은 사용자의 다른 프로세스가 남의 세션에 `self` 로 넣는 것을 막는다. 보안 경계는 아니다. 같은 uid 프로세스는 세션 기록과 0600 키 파일을 읽어 소켓에 직접 쓸 수 있다. 막는 것은 `tfx-peer` 를 거치는 경로가 `send` 의 Claude 대상 거부를 비켜 가는 일이다.
- `tfx-peer` 를 `exec` 없이 감싸는 래퍼로 실행하면 부모 PID 가 래퍼라 매번 폴백한다. 지금 설치본의 `#!/usr/bin/env node` 링크와 `~/.claude/scripts/tfx-peer`(`exec` 사용)는 해당하지 않는다.
- 실제 턴 도중 도착은 설치 뒤 확인한다. ADR-0042 의 설치 뒤 확인 항목(타이머 뒤 rename 거부, `context` 가 읽히는 턴)은 그대로 남는다.
- 되돌릴 조건: mod API 에 실행 중인 턴으로 메시지를 넣는 함수가 생기면 외부 명령 대신 그것을 쓴다. mod API 에 세션 이름 함수가 생기면 rename 호출을 그것으로 바꾼다.
