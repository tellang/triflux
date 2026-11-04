---
id: 0052
title: Jev 기반 iTerm 워커 배치
status: accepted
date: 2026-11-04
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0026, 0029, 0030, 0050]
pr: null
---

# ADR-0052: Jev 기반 iTerm 워커 배치

## 목적

- 작업 메타데이터와 실제 화면 크기로 워커를 자동 배치하고 입력 포커스와 사용자 배치를 보존한다.

## 컨텍스트

고정 4분할은 실제 cols/rows, 역할과 사람 입력 가능성을 반영하지 못한다. 리드의 매번 수동 판단을 없애면서 사용자 셸과 다른 프로젝트, tmux 실행을 보존해야 한다. iTerm의 `apply_layout`은 tmux integration tab을 지원하지 않고 실행 중 실패한 변경의 rollback을 보장하지 않는다.

## 결정

Node가 실제 inventory와 최소 크기로 후보 ID를 만들고 기존 Jev host 설정과 `queryJev`로 하나를 선택한다. 기본 preserve는 명시 배치보다 우선하며 `--focus`일 때만 전환을 허용한다. 장애·비활성·낮은 신뢰도는 진단 가능한 규칙 폴백이다. Python bridge는 registry와 pane 소유 표식이 일치하는 native session ID만 변경하고 snapshot을 적용 직전에 다시 확인한다. background는 실행 tmux만 유지하고 별도 원자 registry 파일에 작업 메타데이터·결정·attach 명령을 남긴다. native ID는 없으므로 view registry에 가짜 ID를 넣지 않는다. 결정, 적용, 실제 크기·포커스 검증을 각각 JSON으로 보고한다.

설치된 Python runtime/API를 재사용하고 없으면 UI 생성 없이 attach 가능한 background로 남기고 경고한다. `--no-auto-layout`도 같은 의미이며 legacy 생성은 명시 `--focus`일 때만 허용한다. 프로젝트·호스트별 watcher는 파일 lock으로 단일화하고 lifecycle 이벤트를 debounce한다. 모든 프로젝트의 API 적용과 watcher state 읽기·pin 저장은 host 전역 mutation lock 다음 프로젝트 lock 순서로 직렬화하며, lock 대기 후 inventory를 재확인한다. 수동 이동 pin은 state에 저장하고 명시 `reconcile --reset-pins` 전까지 유지한다. 자기 적용 결과는 fingerprint와 새 기준 위치로 흡수한다. 수동 이동·명시 배치·현재 입력 탭은 보호하며, 관리 pane으로만 구성된 탭을 정리하고 화면 부족 시 새 탭으로 이동한다. 부분 적용 가능성이 있는 실패에는 실제 inventory를 다시 조회해 반환하고 자동 재시도를 하지 않는다.

각 창의 선택된 탭 전체를 split/reconcile에서 제외하고 비활성 non-tmux 탭만 분할·재배치한다. 새 탭은 `async_create_tab(select=False)`로 만들고 생성 후 focus 복원에는 의존하지 않는다. `focus.requested/effective/transitioned/reason`과 JSON `attention`으로 포커스 전환과 중요 상태 강조를 구분한다. 리드 ID가 없으면 현재 focus session의 창을 읽기 전용 anchor로 쓴다.

이름과 실제 `--task`를 구분하고 이름만의 입력은 정보 부족으로 반환하며 background 자동 후보를 주지 않는다. 기본 최소 크기는 human/lead/communication 100×24, standard 80×20, low-human compact 60×10으로 Node와 Python에서 동일하게 적용한다. 판단에는 작업 메타데이터·ID·grid·관리 태그만 사용하고 사용자 초안·터미널 출력·키 입력 본문은 수집하거나 Jev에 전송하지 않는다.

## 검토한 대안

- 고정 2×2 유지: 단순하지만 화면과 역할 차이를 반영하지 못한다.
- Jev가 좌표·명령을 생성: 실행 가능성과 소유권을 보장하기 어렵다.
- tmux 워커 자체 이동·재시작: 실행과 입력을 방해하므로 attach view만 관리한다.
- 모든 프로젝트 탭을 매 이벤트마다 합치기: 수동 배치 의도를 덮을 수 있어 기존 탭 안에서 먼저 정리한다.

## 결과

새 외부 의존성과 Codex 전역 설정 변경이 없다. API 검증과 실행 사이의 외부 경쟁은 완전히 없앨 수 없으므로 실제 성공을 별도로 확인하고 실패 시 남은 상태를 inspect한다. 명시 최소 크기보다 화면 자체가 작으면 성공으로 검증하지 않는다. 기존 Linux·Windows·remote·headless 실행은 유지한다.

비활성 탭의 분할은 [upstream 구현](https://github.com/gnachman/iTerm2/blob/2b81ee5547fe5937a552293785ea0f016466de75/sources/TerminalView/PseudoTerminal.m#L11887-L11892)의 현재 입력 대상 검사와 공식 API 지원 여부를 따른다. API 적용 전후의 선택 identity를 확인하고 실제 결과를 별도로 보고한다.

공식 근거: [background tab 생성](https://iterm2.com/python-api/window.html), [App API](https://iterm2.com/python-api/app.html), [apply_layout 예제와 한계](https://iterm2.com/python-api/examples/apply_layout.html), [lifecycle monitor](https://iterm2.com/python-api/lifecycle.html).
