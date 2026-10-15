---
id: 0040
title: 비TTY 호출의 tfx multi 는 headless 로 가고 호출자 창을 나누지 않는다
status: accepted
date: 2026-10-15
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0008, 0026]
pr: null
---

# ADR-0040: 비TTY 호출의 tfx multi 는 headless 로 가고 호출자 창을 나누지 않는다

## 컨텍스트와 문제 (Context)

`tfx multi` 의 `auto` 모드는 `TMUX` 환경변수를 먼저 보고 대화형 팀(Claude 리드 pane + 워커 pane)을 골랐다. Claude Code 의 Bash 도구처럼 tmux 안에서 파이프로 호출하는 경우 호출자는 TTY 가 없는데도 대화형 팀이 떴다. 그 결과 호출자가 원하지 않은 Claude 리드가 하나 더 떠서 토큰을 쓰고, 명령은 세션 준비 직후 exit 0 으로 끝나며, `--timeout` 은 무시되고 결과 색인(`results.json`)도 생기지 않았다. tfx-research 와 tfx-review 스킬은 `--teammate-mode` 를 생략한 채 "완료 알림 뒤 결과 회수" 를 전제하고 있어 이 전제가 깨졌다.

같은 호출에서 headless 를 명시해도 `--auto-attach` 기본값이 켜져 있어 호출자 tmux 창을 30% 나눠 워커 방에 attach 하는 pane 이 생겼다. headless 워커는 이미 `claude agents` 행으로 노출되므로(ADR-0008, ADR-0026) 이 pane 은 관전 창이 둘인 셈이고, 사용자는 세션을 닫기 전까지 남아 있는 이 pane 을 "닫히지 않은 pane" 으로 보고했다.

## 결정 (Decision)

- `auto` 모드는 호출자 stdout 이 TTY 가 아니면 `TMUX` 와 무관하게 headless 를 고른다. TTY 호출자(사람이 터미널에 직접 입력)는 그대로 tmux/psmux 대화형 팀이다. 대화형 팀이 필요한 비TTY 호출자는 `--teammate-mode tmux` 를 명시한다.
- headless 의 `--auto-attach` 기본값은 Windows 에서만 켠다. macOS/Linux 는 `claude agents` 행이 관전 창이므로 호출자 창을 나누지 않는다. 나누려면 `--auto-attach` 를 명시하고, 나눌 때는 출력에 그 사실과 끄는 플래그를 한 줄 남긴다.

## 검토한 대안 (Considered Options)

- **A안: 스킬 문서에만 `--teammate-mode headless` 를 적는다**: 코드는 그대로 두고 호출자가 플래그를 기억하게 한다. 단점은 플래그를 빠뜨리면 비TTY 에서 결과 없는 대화형 팀이 다시 뜨고, `--timeout` 이 조용히 무시된다. 기본값이 호출자의 능력(입력 불가)과 어긋나는 문제가 남아 기각.
- **B안: 비TTY 는 headless 로 가되 attach pane 기본값은 유지한다**: 리드 토큰 낭비와 결과 색인 문제는 풀리지만 사용자가 보고한 pane 은 계속 생긴다. 관전은 agents 행이 이미 맡고 있어 중복이라 기각.
- **C안: 채택안**: 모드 판정에서 TTY 를 먼저 보고, attach pane 은 agents 행이 없는 Windows 에서만 기본으로 켠다.

## 결과 (Consequences)

- tfx-research, tfx-review, tfx-auto 스킬의 "모드 생략 + 백그라운드 Bash + 완료 알림 뒤 회수" 흐름이 코드와 일치한다. `--timeout` 이 적용되고 `results.json` 이 생긴다.
- 비TTY 호출에서 Claude 리드 세션이 더 뜨지 않는다.
- macOS/Linux headless 에서 호출자 창이 나뉘지 않는다. `--no-native-bridge-ui` 와 함께 쓰면 관전 창이 없는 완전 백그라운드 실행이 된다. 관전이 필요하면 `--auto-attach` 를 쓴다.
- 옛 설치 스킬이 넘기던 `--auto-attach` 는 무시 대상에서 빠져 다시 뜻을 가진다. 그 스킬은 이전처럼 attach pane 을 얻는다.
- 되돌릴 조건: 비TTY 호출자가 대화형 팀을 기본으로 원하는 사례가 나오면 `auto` 판정 순서를 다시 본다.
