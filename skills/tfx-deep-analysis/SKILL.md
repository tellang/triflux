---
internal: true
name: tfx-deep-analysis
description: "DEPRECATED — tfx-analysis 로 통합됨. 딥 분석은 이제 tfx-analysis 의 기본 동작. 빠른 분석은 /tfx-analysis --quick 사용. 이 스킬은 tfx-analysis 를 호출한다."
triggers:
  - deep analyze
  - 심층 분석
  - deep-analysis
argument-hint: "<분석 대상>"
---

# tfx-deep-analysis — DEPRECATED (→ tfx-analysis)

> **이 스킬은 deprecated 입니다.** `tfx-analysis` 로 통합됨.
> Deep 3-CLI Tri-Debate 는 이제 `tfx-analysis` 의 **기본 동작**.
> 빠른 단일 CLI 분석은 `/tfx-analysis --quick`.

## 마이그레이션

`tfx-analysis` 를 호출하고 ARGUMENTS 를 포워딩 (--quick 은 제거 — deep 요청이었으므로).

```
Skill(skill="tfx-analysis", args="<원래 ARGUMENTS>")
```

## 관련

- Issue #112: skill sprawl 정리 — deep-default 전환
- v11 릴리즈 시 이 파일 제거 예정
