---
id: 0032
title: 리드 역할 절차를 tfx-lead 스킬로 분리한다
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0020, 0029]
pr: null
---

# ADR-0032: 리드 역할 절차를 tfx-lead 스킬로 분리한다

## 컨텍스트와 문제 (Context)

ADR-0029는 세션을 띄운 쪽이 생성부터 종료까지 소유한다고 정하고, 판단 기준의 정본을 `tfx-live` 스킬의 "리드 운영" 절로 두었다. 실제 리드 운영에는 그 절이 다루는 세션 수명과 컨텍스트 비율 밖의 절차가 더 필요하다.

- 역할별 모델 배정, 지시서 작성, 결과 회수, 교차 리뷰와 머지, 겹침 관리, 사용자 결정 모음, 릴리스 조율.
- 리드가 Claude 인지 Codex 인지에 따라 서브에이전트, 메시지 전송, 사용자 질의, 완료 확인 수단이 다르다.

이 절차를 `tfx-live`에 넣으면 세션 조작 명령 문서가 리드 업무 문서로 부풀고, Codex 리드가 읽는 `tfx-live` 사본까지 같이 커진다. ADR-0020은 tfx 스킬을 12개와 Windows 1개로 줄였으므로 새 스킬은 그 기준과 충돌하지 않는지 따져야 한다.

## 결정 (Decision)

우리는 리드 역할 절차를 별도 스킬 `tfx-lead`로 둔다.

- `skills/tfx-lead/SKILL.md`가 역할별 모델, 부르는 방법, 지시 전달, 결과 회수, 교차 리뷰, 겹침 관리, 사용자 결정, 릴리스, 안전, 컨텍스트 점검 절차의 정본이다. Claude 리드와 Codex 리드가 같은 문서를 쓰고, 수단 차이는 문서 안의 "리드 CLI 별 수단" 표로 나눈다.
- ADR-0029가 정한 규칙(리드 소유, 승계 ACK, 즉시 종료, 교차 리뷰)은 바뀌지 않는다. 리드 역할 절차의 정본 위치만 `tfx-live`의 "리드 운영" 절에서 `tfx-lead`로 옮긴다.
- 세션 조작 명령의 상세와 컨텍스트 비율 표는 `tfx-live`에 남긴다. `tfx-lead`는 명령을 복제하지 않고 참조한다. `tfx-live`의 "리드 운영" 절에는 `tfx-lead`로 가는 한 줄만 둔다.
- ADR-0020의 스킬 목록은 `tfx-lead`가 더해져 12개에서 13개, Windows 포함 시 14개가 된다. ADR-0020은 accepted라 고치지 않고 이 ADR이 목록을 부분 갱신한다.
- 설치는 두 경로에 걸친다. Claude 쪽은 기존 스킬 동기화가 `skills/tfx-lead`를 복사하고, Codex 쪽은 `scripts/setup.mjs`의 managed 스킬 동기화 목록에 `tfx-lead`를 더해 `~/.codex/skills/tfx-lead`로 복사한다.

## 검토한 대안 (Considered Options)

- **`tfx-live`의 `references/` 파일로 둔다**: 스킬 수가 늘지 않는다. 그러나 활성화가 `tfx-live` description에 묶여 리드 역할을 맡을 때 읽히지 않고, 세션 조작 스킬과 리드 업무 문서의 경계가 흐려진다. 기각한다.
- **`tfx-live` 본문의 "리드 운영" 절을 키운다**: 한 곳에 모인다. 그러나 `tfx-live`는 Codex 어댑터 사본이 본문과 바이트 단위로 대응해야 해서 본문이 커질수록 유지 비용이 늘고, 매번 세션 조작을 부를 때 리드 업무까지 컨텍스트에 실린다. 기각한다.
- **`tfx-auto`나 `tfx-harness`에 흡수한다**: 스킬 수가 그대로다. 그러나 두 스킬의 역할(구현 진입점, 라우팅 판정)과 맞지 않는다. 기각한다.
- **별도 스킬(채택)**: description이 "리드 역할을 맡을 때"로 좁아 오탐이 적고, 두 CLI 리드가 같은 문서를 읽는다. 대신 스킬이 하나 늘고 description이 매 세션 컨텍스트에 실린다.

## 결과 (Consequences)

- 리드 절차를 바꿀 때는 `tfx-lead`만 고친다. `tfx-live`의 컨텍스트 비율 표와 명령 문서는 영향받지 않는다.
- tfx 스킬 설치본이 하나 늘고 description 한 줄만큼 컨텍스트가 늘어난다. 활성화 조건이 좁아 ADR-0020이 우려한 description 경쟁은 작다.
- Codex 설치본에 `tfx-lead`가 들어가므로 Codex 리드도 같은 절차를 읽는다. 실제 설치는 릴리스 때 `tfx setup`이 한다.
- `tfx-live wait`가 tmux 대화형 Claude 세션을 지원하지 않는 한 Codex 리드는 결과 파일 감시로 대체한다. 지원이 생기면 `tfx-lead`의 완료 확인 표를 고친다.
- 되돌릴 조건: 리드 업무 문서가 짧아져 `tfx-live` 한 절로 충분해지면 `tfx-lead`를 다시 합친다.
