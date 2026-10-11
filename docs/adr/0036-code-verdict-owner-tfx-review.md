---
id: 0036
title: 3-layer 공존에서 코드 판정은 triflux tfx-review 가 맡는다
status: accepted
date: 2026-10-11
deciders: [tellang]
supersedes: [0009]
superseded_by: null
relates: [0002]
pr: "#732"
---

# ADR-0036: 3-layer 공존에서 코드 판정은 triflux tfx-review 가 맡는다

## 컨텍스트와 문제 (Context)
ADR-0009 는 gstack, superpowers, triflux 를 단방향 3-layer 로 공존시키면서 superpowers 를 "리뷰 프리미티브(입력 diff, 출력 verdict)"로 두었다. 그 사이 triflux 의 `tfx-review` 가 3-CLI 합의 리뷰와 공용 작성 원칙 기준까지 갖추면서, rules 안에서 코드 판정 담당이 superpowers `requesting-code-review` 와 `tfx-review` 두 가지로 적혀 서로 어긋났다. 판정 담당이 둘이면 머지 조건도 둘이 된다.

## 결정 (Decision)
우리는 ADR-0009 의 레이어 분리와 의존 방향을 그대로 유지하고, 코드 판정 담당만 triflux `tfx-review` 로 옮긴다.

- 무대(Stage) = gstack: 워크플로 게이트.
- 엔진(Engine) = superpowers: 작업 방식 프리미티브(브레인스토밍, 계획, TDD, 리뷰 반영).
- 백엔드(Backend) = triflux: 오케스트레이션과 코드 판정(`tfx-review`, 입력 diff, 출력 verdict).
- 의존 방향은 ADR-0009 와 같다. `gstack → triflux`, `gstack → superpowers`, `superpowers → triflux` 허용, `triflux → gstack`, `triflux → superpowers` 금지.
- 머지 전 판정은 `tfx-review` verdict 로 확인한다.

## 검토한 대안 (Considered Options)
- **A안: 판정을 tfx-review 로 옮긴다 (채택)**: 판정과 실행이 같은 레이어라 의존 방향 위반 없이 머지 조건이 하나가 된다. superpowers 의 리뷰 스킬은 판정이 아닌 "리뷰 받기와 반영"에 쓴다.
- **B안: superpowers 판정을 유지하고 tfx-review 를 심층 리뷰 전용으로 둔다**: ADR-0009 를 바꾸지 않아도 되지만, 공용 작성 원칙 기준과 3-CLI 합의가 기본 경로에서 빠진다.

## 결과 (Consequences)
긍정: 판정 담당과 머지 조건이 하나로 줄고, triflux 코어는 여전히 gstack 과 superpowers 에 의존하지 않는다. 부정: superpowers `requesting-code-review` 를 쓰던 흐름은 tfx-review 로 바꿔야 한다. 되돌릴 조건: tfx-review 를 쓸 수 없는 환경이 기본이 되면 판정 담당을 다시 정한다. SSOT 는 `.claude/rules/tfx-stack-coexistence.md`.
