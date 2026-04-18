---
name: tfx-autoroute
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --cli auto --retry 1` 로 리다이렉트.
  자동 승격 escalation 의미는 --retry 1 로 근사 표현. 완전한 escalation policy 는 Phase 3+ 에 --retry auto-escalate 로 도입 예정.
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

> DEPRECATED. `/tfx-auto --cli auto --retry 1` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-autoroute -> use: tfx-auto --cli auto --retry 1
   ```
2. ARGUMENTS 전체 앞에 `--cli auto --retry 1` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리.

## 등가 플래그

`--cli auto --retry 1`

## 이 alias 의 의미

tfx-autoroute 의 "자동 승격 + 실패 시 더 강한 모델" 의미는 --cli auto + --retry 1 로 근사 표현된다. 완전한 IntentGate escalation chain (Haiku → Sonnet → Opus, Codex normal → xhigh) 은 Phase 3+ 에 별도 플래그로 노출 예정.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-autoroute "작업"` | `/tfx-auto "작업" --cli auto --retry 1` |
