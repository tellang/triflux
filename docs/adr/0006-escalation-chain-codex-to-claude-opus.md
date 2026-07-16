---
id: 0006
title: 재시도 승격 체인을 codex→claude opus 2단계로 한다
status: accepted
date: 2026-05-27
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002, 0004]
pr: "#356"
---

# ADR-0006: 재시도 승격 체인을 codex→claude opus 2단계로 한다

## 컨텍스트와 문제 (Context)
`/tfx-auto --retry auto-escalate`는 태스크가 실패하면 더 강한 모델로 승격한다. 승격 체인이 너무 길면(mini→codex→pro→opus …) 비용·지연이 폭증하고, 너무 짧으면 회복력이 없다. 또한 같은 실패가 반복될 때 무한 승격을 막을 종료 조건이 필요하다. GPT-5.6 Sol의 `max` effort가 과거의 여러 Codex 중간 단계를 단일 복구 단계에서 대체한다.

## 결정 (Decision)
우리는 `DEFAULT_ESCALATION_CHAIN`을 **2단계**로 한다.

1. **codex / gpt-5.6-sol / `gpt56_sol_max`**. 이미 실패한 최난도 단일 작업을 복구한다. 자동 위임을 포함하는 `ultra`는 외부 retry 오케스트레이션과 중첩되므로 사용하지 않는다.
2. **claude / opus-4-8** (profile 미지정). 최종 수단 — 복잡 아키텍처/합의 요구 시.

전이 규약: 각 단계 default `max_iterations = 3`(`--max-iterations N`으로 override), 소진 시 다음 단계로 전이하며 iterations/stuckCounter/lastFailureReason 리셋. **동일 failureReason 3회 연속 = `STUCK` → 체인과 무관하게 즉시 중단.** 체인 소진 시 `BUDGET_EXCEEDED`(reason `escalation-chain-exhausted`). 프로젝트별 override는 `.triflux/config/escalation-chain.json`(있으면 default 대체). 이 체인의 1단계가 Codex인 것은 ADR-0004(기본 CLI = Codex)와 정합한다.

## 검토한 대안 (Considered Options)
- **A안: codex→claude opus 2단계 (채택)** — 장점: GPT-5.6 Sol max가 Codex 중간 티어를 흡수해 단계 최소화, opus-4-8이 명확한 최종 수단. 단점: 두 CLI 모두 장애 시 회복 경로 없음 → `STUCK`/`BUDGET_EXCEEDED`로 명시적 중단(무한 루프보다 안전).
- **B안: 다단계 체인(mini→codex→pro→opus)** — 장점: 세밀한 비용 계단. 단점: gpt-5.5로 중간 단계가 무의미해짐, 지연·복잡도 증가.
- **C안: Claude opus 우선 단일 티어** — 장점: 최고 품질 즉시. 단점: 비용 과다, ADR-0004 default=Codex와 불일치.

## 결과 (Consequences)
긍정: 승격 경로가 명시적·짧고 비용 예측 가능, `STUCK` 종료 조건으로 무한 승격 차단. ADR-0004와 정합. 부정/리스크: opus 이후 상위 티어 없음(설계상 의도 — 그 이상은 human gate). 구현: `hub/team/retry-state-machine.mjs`의 `DEFAULT_ESCALATION_CHAIN`. 관련 PR: #356(2단계 재이관 + profile 필드), #363(opus-4-7→4-8 bump). SSOT는 `.claude/rules/tfx-escalation-chain.md`.
