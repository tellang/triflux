---
id: 0042
title: 리드 진입은 /tfx-lead <역할>, 압박 감시는 /tfx-pressure 로 나눈다
status: accepted
date: 2026-10-21
deciders: [tellang]
supersedes: [0041]
superseded_by: null
relates: [0032, 0040]
pr: null
---

# ADR-0042: 리드 진입은 /tfx-lead <역할>, 압박 감시는 /tfx-pressure 로 나눈다

## 컨텍스트와 문제 (Context)

ADR-0041 은 메모리 압박 감시를 리드 세션의 triflux mod 에 두고 `/tfx-lead` 에 on, off, status 인자를 넘겨 켜고 끄게 했다. 그 결과 `/tfx-lead` 라는 이름이 리드 역할이 아니라 압박 감시 하나를 가리키게 됐다. 리드 스킬의 목적은 세 가지로 좁혀졌다. 한 세션에 역할 리드를 맡기고 이름을 바꾸는 것, 리드가 워커에 이름을 붙여 등록하는 것, 등록한 워커의 컨텍스트와 진행을 관리하는 것이다. 압박 감시는 그중 진행 관리의 보조 신호일 뿐이다.

mod API 에는 세션 이름을 바꾸는 함수가 없다. `$.command.run({ command: 'rename' })` 으로 내장 `/rename` 을 실행할 수는 있지만, 호스트가 `command.run` 훅 안에서 부른 `$.command.run` 을 "그 훅이 잡고 있는 턴을 기다리게 된다"며 거부한다(Claude Code 2.1.301 테스트 키트에서 확인).

## 결정 (Decision)

- 압박 감시는 ADR-0041 의 결정을 그대로 잇는다. 상주 프로세스 없이 리드 세션의 triflux mod 가 2초마다 `kern.memorystatus_vm_pressure_level` 을 읽는다. 1, 2, 4 만 유효로 보고, 다른 단계가 새 표본 두 번 연속 같을 때 확정하며, 표본 간격이 5초를 넘으면 후보를 버린다. 확정한 전이는 `$.prompt.submit` 으로 턴을 열고, 아직 열지 못한 제출이 있으면 마지막 상태로 합친다. `/clear` 뒤에는 등록을 새 세션 ID 로 옮기고, 세션이 끝나면 지운다. macOS 대화형 세션만 지원한다.
- 압박 감시 명령은 `/tfx-pressure on|off|status` 로 옮긴다. 저장 키도 `tfx.pressure.<sessionId>` 로 바꾼다. 기존 `tfx.lead.*` 등록은 옮기지 않는다. 잃는 것은 실행 중인 리드의 등록 하나이고 `/tfx-lead <역할>` 을 다시 하면 돌아온다.
- `/tfx-lead <역할>` 은 리드 진입 명령이다. 세션 이름을 `<월>.<일> <역할>` 로 바꾸고(인자가 이미 날짜로 시작하면 그대로), 압박 감시를 `/tfx-pressure on` 과 같은 함수로 켜고, `tfx-lead` 스킬을 따르라는 숨은 지시를 결과의 `context` 에 넣는다. 인자가 없으면 사용법만 돌려준다. 리드 해제 명령은 두지 않고 `/tfx-pressure off` 로 끈다.
- 이름 변경은 기다리지 않는다. 훅의 마지막 `await` 뒤에 `$.clock.after(0, ...)` 를 걸어 훅이 끝난 다음 `$.command.run({ command: 'rename', args })` 를 호출하고, 거부되면 `$.ui.toast` 로 "이름 변경 실패: /rename <이름> 을 직접 실행" 을 띄운다. 명령 결과의 `text` 는 "이름 변경 요청: <이름>" 과 압박 감시 상태다.
- 전이별 대응 규칙은 `skills/tfx-lead/SKILL.md` 의 "압박 변화 대응" 절이 정본이다. 기준값은 `.claude/rules/tfx-routing.md` 그대로다.

## 검토한 대안 (Considered Options)

- **ADR-0041 에 정정 문단 덧붙이기**: 바뀐 것이 명령 이름과 진입 방식뿐이라 가볍다. 그러나 accepted ADR 은 불변이라는 `docs/adr/CONVENTIONS.md` 규칙을 어긴다. 기각.
- **명령 이름은 두고 `/tfx-lead <역할>` 을 하위 인자로 섞기**: `on`, `off`, `status` 라는 역할 이름과 부딪히고, 리드 진입과 압박 감시가 한 명령에 다시 묶인다. 기각.
- **`command.run` 훅 안에서 rename 을 기다리고 실패를 `text` 에 적기**: 사용자가 결과를 한 줄에서 본다. 그러나 호스트가 그 호출을 항상 거부하므로 매번 실패 문구가 나온다. 기각.
- **`turn.complete` 에서 rename 하기**: 호스트 오류 문구가 권하는 경로다. `turn.complete` 는 모델 턴이 끝날 때 오는데, `context` 만 남기는 슬래시 명령은 턴을 열지 않는 것으로 보여 이름 변경이 다음 사용자 턴이 끝날 때까지 밀린다. 기각.
- **훅 앞부분에서 타이머 걸기**: 첫 구현이 그랬다. 압박 감시를 켜는 동안(`uname`, store 쓰기) 시계가 흐르면 타이머가 훅 실행 중에 돌고, 호스트는 그 호출도 훅에서 부른 것으로 보고 거부한다. 테스트 키트에서 재현했다. 기각.

## 결과 (Consequences)

- 리드 세션은 `/tfx-lead <역할>` 한 번으로 이름, 압박 감시, 스킬 지시를 받는다. Codex 리드는 mod 가 없어 `/rename` 을 직접 쓴다.
- `/tfx-lead` 에 on, off, status 를 넘기면 이제 그 말을 역할 이름으로 받는다. 옛 등록은 지워지지 않고 남지만 읽히지 않는다.
- 실제 세션에서 타이머 뒤 `$.command.run('rename')` 이 거부되는지와, `context` 가 같은 턴에 읽히는지 다음 사용자 턴에 읽히는지는 설치 뒤 확인한다. 거부되면 사용자에게 `/rename` 을 요청하는 경로가 기본이 된다.
- 되돌릴 조건: mod API 에 세션 이름 함수가 생기면 rename 호출을 그것으로 바꾼다. ADR-0041 의 되돌릴 조건(리드 없는 시간대의 압박 이력, 외부 inbox 쓰기 형식이나 Channels 공개)은 그대로 유효하다.
