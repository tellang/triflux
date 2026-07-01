---
id: 0009
title: gstack·superpowers·triflux를 단방향 3-layer로 공존시킨다
status: accepted
date: 2026-07-01
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: null
---

# ADR-0009: gstack·superpowers·triflux를 단방향 3-layer로 공존시킨다

## 컨텍스트와 문제 (Context)
이 환경은 세 스킬 시스템을 동시에 쓴다: gstack(`/`), superpowers(`/superpowers:*`), triflux(`/tfx-*`). 80+ 스킬이 기능적으로 겹치기 때문에(각자 review·plan·qa·ship 유사물 보유), 흡수/대체하려 들면 순환 참조와 비결정적 라우팅이 생긴다. 세 시스템의 책임 경계와 의존 방향을 명시하지 않으면 triflux 코어가 gstack/superpowers에 얽혀 독립성을 잃는다.

## 결정 (Decision)
우리는 세 시스템을 **흡수/대체가 아닌 레이어 분리**로 공존시킨다.

- **무대(Stage) = gstack** — 워크플로우 게이트(언제 무엇을 부를지). `/ship`·`/qa`·`/checkpoint`·`/investigate`.
- **엔진(Engine) = superpowers** — 리뷰 프리미티브(입력 diff → 출력 verdict). `/review`·`/design-review`·`/security-review`.
- **백엔드(Backend) = triflux** — 오케스트레이션(병렬 worker 배분·모델 선택·실행). `/tfx-*` 전체.
- **의존 방향은 단방향**: `gstack → triflux` 허용, `gstack → superpowers` 허용, `superpowers → triflux` 허용. **`triflux → gstack` 금지, `triflux → superpowers` 금지.** triflux 코어는 절대 gstack/superpowers에 의존하지 않는다.
- 기본 진입점은 `tfx-*`. 기능 경계가 명확하면 owner 시스템 1순위, 모호하면 triflux 우선.

## 검토한 대안 (Considered Options)
- **A안: 단방향 3-layer 공존 (채택)** — 장점: 각 시스템 책임 경계 보존, triflux 코어 독립성 유지, 흐름이 `사용자 → gstack(게이트) → triflux(실행) → superpowers(판정) → gstack(결과)`로 명확. 단점: 겹치는 스킬의 충돌 해소 표를 유지해야 함.
- **B안: triflux가 gstack/superpowers를 흡수** — 장점: 단일 시스템. 단점: 역방향 의존 → 순환 참조 가능성, 세 시스템 각각의 업스트림 업데이트를 못 받음.
- **C안: 완전 분리(상호 무연동)** — 장점: 결합 0. 단점: 워크플로우 게이트가 실행 백엔드를 못 부름 → 각 시스템이 중복 기능을 재구현.

## 결과 (Consequences)
긍정: triflux 코어가 gstack/superpowers 없이 독립 동작하고(단방향), 세 시스템이 책임을 나눠 중복 재구현을 피한다. 부정/리스크: 스킬 키워드 충돌 시 비결정적 라우팅 위험 → 충돌 해소 우선순위 표로 방어(gstack이 triflux를 우회해 codex 직접 호출하면 headless-guard 차단). 되돌릴 조건: 세 시스템 중 하나가 사실상 미사용이 되면 레이어를 통합. SSOT는 `.claude/rules/tfx-stack-coexistence.md`.
