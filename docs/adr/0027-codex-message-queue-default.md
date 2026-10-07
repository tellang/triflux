---
id: 0027
title: Codex 세션 메시지 전송은 codex queue 기본, tmux 입력은 폴백과 슬래시 명령 전용
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0015]
pr: null
---

# ADR-0027: Codex 세션 메시지 전송은 codex queue 기본, tmux 입력은 폴백과 슬래시 명령 전용

## 컨텍스트와 문제

`tfx-live ask --cli codex`는 tmux 붙여넣기와 Enter로 Codex TUI에 메시지를 보냈다. 이 방식에서 세 가지 결함이 났다.

- 바쁜 세션에는 보낼 수 없어 `--if-busy wait`로 막혔다. 쌓아 두는 수단이 없었다.
- 입력창에 남은 글과 붙여넣기가 합쳐졌다. `start`의 `/rename` 뒤 Enter가 빠른 입력 직후에 버려져 입력창에 남았고, 다음 요청이 그 뒤에 붙어 세션 이름으로 들어갔다.
- 보낸 쪽이 누구인지 받는 화면에 드러나지 않았다.

Codex CLI 0.160에 `codex queue --thread <UUID|이름> --message`가 생겼다. 2026-10-08 tmux로 띄운 단독 TUI에서 확인한 사실은 다음과 같다.

- 유휴 TUI는 약 20초 주기로 큐를 가져가 새 턴을 시작한다.
- 바쁜 동안 보낸 메시지는 쌓였다가 앞 턴이 끝난 직후 순서대로 들어간다. 바쁜 동안 화면에 대기 표시는 없다.
- 입력창을 건드리지 않는다. 메시지는 일반 사용자 입력으로 표시되고 여러 줄도 그대로 펼쳐진다.
- 큐로 보낸 `/rename`은 슬래시 명령으로 실행되지 않고 모델에 텍스트로 들어간다.
- `--thread`에 세션 이름을 주면 "Cannot verify a unique session label across server pages" 오류가 났다. UUID로는 성공했다.
- rollout에 사용자 메시지의 `turn_id`와 같은 턴의 `task_complete.last_agent_message`가 남아 완료를 판정할 수 있다.

## 결정

Codex 세션으로 보내는 메시지는 `codex queue --thread <UUID>`를 기본으로 한다. 첫 줄에 `[from <보낸 세션 이름>] [tfx-live req=<id>]` 머리말을 붙여 보낸 쪽을 드러내고, 완료는 rollout에서 같은 턴의 `task_complete`로 판정한다. thread UUID는 `start`가 남긴 tmux 세션 옵션, Codex 세션 레지스트리, pane cwd와 같은 rollout 하나 순으로 찾는다.

tmux 직접 입력은 queue를 쓸 수 없을 때만 폴백으로 쓴다. 원격 호스트, thread를 찾지 못함, `codex queue` 오류가 그 경우이며 결과에 전송 경로와 폴백 이유를 남긴다. 조용히 폴백하지 않는다. 슬래시 명령과 interrupt는 tmux 직접 입력 전용으로 둔다. 화면에서 응답을 읽는 `peer`, `converse`, `goal-driven`도 tmux를 유지한다.

## 검토한 대안

- **tmux 붙여넣기 유지**: 추가 의존이 없다. 하지만 바쁠 때 쌓을 수 없고, 입력창 초안과 섞이며, 화면 캡처로 완료를 추정해야 한다. 이번 결함의 원인이라 기본에서 뺀다.
- **app-server UDS `turn/start`**: 턴 ID와 완료 알림을 바로 받는다. 하지만 0.160.1로 tmux에서 띄운 TUI는 공유 daemon에 붙지 않아 대상이 될 수 없었다. 같은 TUI를 resume하자 CLI와 daemon 버전이 어긋나 기능 설정 확인 창에서 시작이 멈췄다. 0.161 TUI는 daemon에 붙는 표시가 있으므로 다시 볼 만하다. 지금은 이미 daemon에 있는 thread용 `--transport uds`로 남긴다.

## 결과

- 바쁜 Codex 세션에도 요청을 쌓을 수 있고 입력창 초안을 오염시키지 않는다.
- 유휴 세션에도 배달까지 최대 약 20초가 걸린다. 결과의 `status`는 `queued`, `working`, `completed`, `failed`로 나누고 `delivered`로 배달 여부를 구분한다.
- Claude의 접힌 발신자 표시와 달리 Codex 화면에서는 머리말이 사용자 입력처럼 보인다.
- 큐 항목을 지우는 공식 명령이 없다. 닫힌 TUI의 thread에 쌓인 항목은 그 thread를 다시 열 때 배달된다.
- Codex가 큐에서 슬래시 명령을 실행하거나 이름 조회를 고치면 슬래시 명령 전용 규칙과 UUID 조회를 다시 검토한다.
