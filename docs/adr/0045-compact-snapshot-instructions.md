---
id: 0045
title: compact 때 triflux mod 가 요약 지시에 남길 항목을 붙인다
status: proposed
date: 2026-10-23
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0042, 0044]
pr: null
---

# ADR-0045: compact 때 triflux mod 가 요약 지시에 남길 항목을 붙인다

## 컨텍스트와 문제 (Context)

리드와 워커는 compact 전에 이어갈 상태(등록 워커, 열린 PR, 남은 일)를 손으로 지시문에 적어야 했다. 적지 않으면 압축 뒤 첫 턴에 파일과 PR 을 다시 읽어야 한다. mod 호스트의 `session.compact` 이벤트는 `/compact`, 자동 압축, `tfx_control`, 서브에이전트 압축(`agentId`)을 모두 지나고, `next({ ...e, instructions })` 로 요약 지시를 바꿀 수 있다.

context-mode(github.com/mksglu/context-mode)는 PreCompact 에서 세션 사건을 우선순위별로 2KB 안팎으로 요약해 두고 다시 넣는다. 라이선스가 ELv2 라 MIT 인 triflux 에 코드를 가져오지 않고, 우선순위와 크기 상한이라는 방식만 빌린다.

## 결정 (Decision)

- triflux mod 의 `session.compact` 훅(`mods/triflux/hooks/compact-snapshot.ts`)이 요약 지시 뒤에 "남길 항목" 블록을 붙인다. 사용자 `/compact` 지시문이나 `tfx_control` 의 instructions 는 앞에 그대로 둔다.
- 리드 표지(`tfx.lead.<세션 ID>`)가 있는 메인 대화에는 리드 블록을 넣는다. 우선순위는 높은 것부터 리드 역할과 세션 이름, 인계 파일과 지시서 경로, 등록 워커, 열린 PR 과 리뷰 상태, 남은 일과 사용자 결정이다.
- 리드가 아닌 세션과 서브에이전트에는 공통 블록(현재 작업 목표, 결과 파일과 지시서 경로, 남은 일)만 넣는다.
- 블록 상한은 2000자다. 넘으면 낮은 순위 항목부터 뺀다.
- 파일을 읽어 넣는 항목은 등록 워커 하나다. 프로젝트 루트의 `.omc/lead/workers.md` 에서 표 줄을 그대로 넣고, 파일이 없으면 지시 문장으로 대신한다. 나머지 항목은 모델이 대화에서 뽑으라는 지시 문장이다.
- 별도 DB, 색인, MCP 서버, 도구 호출 기록은 두지 않는다.

## 검토한 대안 (Considered Options)

- **세션 사건 DB**: 도구 호출과 결정을 SQLite 같은 저장소에 쌓아 compact 뒤 다시 넣는 context-mode 방식이다. 세션마다 저장소와 프로세스가 늘어 RAM 압박을 키우고, 모델이 대화에서 뽑을 수 있는 항목을 따로 기록하게 된다. 기각.
- **전체 도구 출력 기록**: 도구 출력을 모두 남겨 두고 압축 뒤 찾게 하는 방식이다. 남길 항목은 몇 줄인데 기록은 세션 전체라 비용이 맞지 않는다. 기각.

## 결과 (Consequences)

- 리드는 지시문 없이 compact 해도 등록 워커, 열린 PR, 남은 일이 요약에 남는다. 지시문을 주면 합쳐진다.
- 항목 대부분이 지시 문장이라 실제로 남는지는 요약 모델에 달려 있다. 설치 뒤 리드가 한 번 compact 해 첫 턴에서 확인한다.
- 조직이 Claude Code 를 관리하는 환경에서는 사용자가 설치한 플러그인의 `session.compact` 훅이 돌지 않는다. 그때는 지금처럼 지시문을 손으로 적는다.
