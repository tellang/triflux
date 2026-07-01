---
id: 0004
title: Codex를 기본 구현 CLI로 사용한다
status: accepted
date: 2026-04-30
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: null
---

# ADR-0004: Codex를 기본 구현 CLI로 사용한다

## 컨텍스트와 문제 (Context)
triflux는 Codex(gpt-5.5) · Antigravity · Claude(opus-4-8) 세 CLI를 오케스트레이션한다. `tfx-auto`·`tfx-review`·`tfx-analysis`·`tfx-plan`·`tfx-find` 같은 multi-CLI wrapper가 어느 lane을 default head로 삼을지 정해지지 않으면, 스킬마다 라우팅이 비결정적이 되고 비용·품질이 흔들린다. 근거가 필요한 건 취향이 아니라 실측 운영 패턴이다: triflux 본체 개발의 v10.18.0 ~ v10.20.2 구간(약 2주, 25+ PR)이 거의 전부 Codex 단독 또는 Codex worker spawn으로 진행됐다.

## 결정 (Decision)
우리는 구현·수정·디버그·리뷰·분석·테스트 작성·회귀 가드·릴리즈 prepare lane의 default CLI를 **Codex(gpt-5.5)**로 한다.

- **1차(default) = Codex.** 위 lane 전부.
- **2차 = Antigravity.** Codex quota exhaust, 가독성 cross-check, 별도 시각 검토.
- **한정(Claude opus-4-8만) = 메타 라우팅(`/tfx-harness`), planning gate(`/office-hours`·`/autoplan`), gstack-specific surface(`/gstack-context-*`·`/gstack /qa`), 또는 Codex/Antigravity 미가용.**
- 명시 플래그(`--cli codex`·`--cli claude`·`--cli antigravity`)가 있으면 override. `--mode consensus`(3-CLI 합의)의 default head도 Codex.

## 검토한 대안 (Considered Options)
- **A안: Codex default (채택)** — 장점: 실측 운영 fact와 정합, 코드/추론/비용에서 우위, `--retry auto-escalate` 체인 1단계(ADR-0006)와 정합. 단점: Codex quota/auth 장애에 라우팅이 민감 → Antigravity fallback으로 완화.
- **B안: Claude opus default** — 장점: 메타 판단 강함. 단점: 코드/비용 lane에서 Codex 대비 열세, 운영 실측과 불일치.
- **C안: 매 태스크 수동 CLI 선택** — 장점: 최대 유연성. 단점: 판단 비용이 매 호출마다 발생, 비결정적 라우팅.

## 결과 (Consequences)
긍정: 모든 multi-CLI wrapper가 하나의 default policy를 공유해 라우팅이 결정적이 된다. `--retry auto-escalate` 체인의 1단계가 Codex인 것(ADR-0006)과 정합한다. 부정/리스크: Codex 계정 장애·quota 소진이 광역 영향 → Antigravity 2차 lane + AccountBroker CircuitBreaker로 격리. 되돌릴 조건: Codex 대비 다른 CLI의 코드 품질·비용 우위가 실측으로 뒤집히면 default를 재지정하고 이 ADR을 superseded 처리. SSOT(가변 "어떻게")는 `.claude/rules/tfx-routing.md`의 "CLI 우선순위 정책 — default = Codex" 절.
