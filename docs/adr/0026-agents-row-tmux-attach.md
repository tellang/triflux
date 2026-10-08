---
id: 0026
title: claude agents 행을 워커 tmux 방의 attach client 로 만든다
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0008, 0025]
pr: null
---

# ADR-0026: `claude agents` 행을 워커 tmux 방의 attach client 로 만든다

## 컨텍스트와 문제 (Context)

ADR-0008 은 headless 워커를 `claude agents` 패널에 기본으로 노출하기로 했다. 구현은 워커 명령을 Claude daemon 의 `control.sock` 에 exec job 으로 직접 보내고, `~/.claude/sessions/<pid>.json` projection 을 손으로 써서 행을 만들었다. 행 이름은 Codex 로 보였지만 Enter 를 누르면 워커가 아니라 그 job 의 PTY 가 열렸고, 사람이 볼 화면은 별도 파일 뷰어 방에만 있었다. projection 의 bridge ID 도 실제 값이 없으면 `session_<short>` 로 지어냈다.

2026-10-08 Claude Code 2.1.292 에서 확인한 사실:

- Enter 는 행의 백킹 PTY(`claude --bg-pty-host`)를 그대로 연다. 백킹 명령이 `tmux attach-session` 이면 그 tmux 방이 열린다. 입력, 한글, resize, Ctrl+Z 후 재진입이 모두 동작한다.
- 행은 daemon 목록이 공급한다. projection 파일은 필요 없다.
- 공식 문서의 `claude --bg --name <이름> --exec '<명령>'` 이 같은 구조의 job 을 만들고 short id 를 출력한다. job 안에는 `CLAUDE_JOB_DIR` 이 있고 끝이 그 short id 다.
- 위험: 뷰어가 없을 때 tmux client 가 보낸 DA, XTVERSION, 창 크기 질의는 응답 없이 시간 초과된다. bg-pty-host 는 뷰어가 붙을 때마다 원시 출력 이력을 다시 재생하고, 바깥 터미널이 그 질의에 다시 답한다. tmux 는 늦게 온 응답을 키 입력으로 넘기므로 방 pane 에 `^[[?1;2;4c` 같은 바이트가 들어간다. 첫 진입이 깨끗해도 재진입에서 샌다. TERM 변경이나 XT 제거로는 질의가 꺼지지 않는다.

## 결정 (Decision)

우리는 워커를 실제 tmux 방에서 실행하고, `claude agents` 행은 `claude --bg --exec` 로 띄운 그 방의 attach client 로 만든다.

- 대상은 socket path, session ID(`$N`), pane ID(`%N`)로 고정한다. 백킹 명령은 pane 이 등록한 세션에 그대로 있는 동안 attach 를 반복하고, 방이 사라지면 `CLAUDE_JOB_DIR` 로 자기 행을 `claude rm` 한다.
- headless 워커 행은 `attach-session -r`(read-only, ignore-size) 로 연다. 입력이 필요 없고, 읽기 전용 client 는 새는 응답도 버린다. `-r` 은 tmux 3.2 이전에도 있다.
- attach 가 바로 끝나기를 5번 연달아 반복하면 고칠 수 없는 실패로 보고 반복을 멈춘다.
- `tfx-live start` 로 띄운 Claude 외 세션 행은 입력이 필요하다. 그래서 python3 PTY 중계(`hub/team/agents-row-attach.py`)로 터미널 응답 시퀀스만 걸러 낸다. python3 가 없으면 읽기 전용으로 열고 행 이름에 `[read-only]` 를 붙인다.
- control.sock exec dispatch, daemon 완료 토큰 대기, 파일 뷰어 관찰 방, 추정 bridge ID 는 이 경로에서 지운다.
- headless 도 tmux 방이 필요하므로 멀티플렉서가 없으면 시작할 때 설치 안내 오류로 끝낸다.

ADR-0008 의 기본 노출 결정은 그대로 둔다. 이 ADR 은 노출 방식만 정한다.

## 검토한 대안 (Considered Options)

- **control.sock exec dispatch 유지**: 이미 동작하는 코드다. 다만 비공개 프로토콜이고, 공식 `--exec` 가 같은 job 을 만들므로 쓸 이유가 없다.
- **PTY relay 또는 facade(B안)**: 워커 pane 과 daemon PTY 사이에서 입출력을 직접 중계한다. Claude 의 PTY 프레임과 adoption 계약에 더 깊이 의존하고, 과거 roster facade 는 행 노출부터 실패했다. A안이 성립해서 필요 없다.
- **공식 Claude 세션 래퍼(C안)**: `claude --bg` 로 Claude 세션을 만들고 그 안에서 tmux 를 연다. Enter 가 Claude 대화를 열어 목표를 충족하지 못한다.
- **질의 자체를 끄기**: TERM 을 바꾸거나 terminal-overrides 로 XT 를 빼 보았으나 tmux 3.7 은 여전히 질의를 보냈다.
- **python3 없이 Node 로 중계**: Node 는 네이티브 모듈 없이 PTY 를 만들 수 없다. `script` 를 끼우면 창 크기 전파가 끊긴다.

## 결과 (Consequences)

- 긍정: Enter 가 실제 워커 방을 연다. 행 정리가 방의 수명을 따른다. `claude-daemon-control.mjs` 의 tfx-live Claude UDS 경로는 건드리지 않는다.
- 부정: `CLAUDE_JOB_DIR` 과 `--exec` 동작은 Claude 업데이트로 바뀔 수 있다. 바뀌면 행이 방보다 오래 남을 수 있고, headless 는 실행 종료 때의 stop+rm 으로 정리된다.
- 부정: 행 생성은 cwd 가 Claude 에서 trust 된 워크스페이스여야 한다. 실패하면 워커는 그대로 돌고 경고만 남는다.
- 부정: 멀티플렉서가 없는 비TTY 환경에서 headless 를 돌리던 경로는 없어졌다. 그 경로는 daemon 이 워커를 직접 실행할 때만 성립했다.
- 부정: 행마다 `claude --bg-pty-host` 와 tmux client 가 하나씩 상주한다. 정리는 행당 `claude rm` 한 번이다(실행 중인 job 도 멈춘다).
- 부정: headless 워커 여럿이 한 방을 나눠 쓰면 행마다 방 전체가 보이고 활성 pane 은 행끼리 공유한다. client 별 활성 pane(`-f active-pane`)은 읽기 전용 client 에서 `select-pane` 이 막혀 쓰지 못했다.
- 되돌릴 조건: Claude 가 행에 임의 attach 명령을 등록하는 공식 API 를 내거나, `--exec` 가 사라지면 다시 검토한다.
