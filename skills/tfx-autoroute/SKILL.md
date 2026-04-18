---
name: tfx-autoroute
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --retry auto-escalate` 로 리다이렉트.
  Phase 3 부터 CLI 승격 체인 (codex:gpt-5-mini → codex:gpt-5 → claude:sonnet-4-6 → claude:opus-4-7) 이 동작한다.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - sisyphus
  - 끝없이
  - never stop
  - 시지프스
  - auto-route
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-autoroute (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --retry auto-escalate` 로 리다이렉트.
> Phase 3 부터 **CLI 승격 체인** — hub/team/retry-state-machine.mjs (`auto-escalate` mode).

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-autoroute -> use: tfx-auto --retry auto-escalate
   ```
2. ARGUMENTS 전체 앞에 `--retry auto-escalate` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. retry-state-machine 이 기본 체인을 따라 승격 — 각 단계에서 `max-iterations` (기본 3) 소진 시 다음 CLI/모델 로 전이.

## 등가 플래그

`--retry auto-escalate` (Phase 3)

체인 커스터마이즈는 `.claude/rules/tfx-escalation-chain.md` (Phase 3 Step D 예정) 참조. 미작성 시 DEFAULT_ESCALATION_CHAIN 사용:

1. codex : gpt-5-mini
2. codex : gpt-5
3. claude : sonnet-4-6
4. claude : opus-4-7

## 이 alias 의 의미

tfx-autoroute 의 "실패 시 더 강한 모델로 승격" 의미는 Phase 2 까지 `--retry 1` 로 **근사** 표현되어 재시도는 같은 CLI 에서 이루어졌다. Phase 3 에서 체인 전이가 구현되어 의미 복원.

승격 이벤트:
- 각 CLI 단계에서 `max-iterations` 소진 → 다음 CLI 전이 (iterations/stuckCounter 리셋)
- 체인 끝까지 소진 → `BUDGET_EXCEEDED` with `reason: "escalation-chain-exhausted"`
- 동일 failureReason 3회 연속 → `STUCK` (체인 중단)

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-autoroute "작업"` | `/tfx-auto "작업" --retry auto-escalate` |
| `/tfx-autoroute "작업" --max 2` | `/tfx-auto "작업" --retry auto-escalate --max-iterations 2` (단계당 2회) |
