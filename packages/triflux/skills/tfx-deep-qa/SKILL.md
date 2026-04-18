---
internal: true
name: tfx-deep-qa
description: "DEPRECATED — tfx-qa 로 통합됨. 딥 QA 는 이제 tfx-qa 의 기본 동작. 빠른 QA 는 /tfx-qa --quick 사용."
triggers:
  - deep qa
  - 심층 검증
  - thorough test
  - deep-qa
argument-hint: "<검증 대상>"
---

# tfx-deep-qa — DEPRECATED (→ tfx-qa)

> **이 스킬은 deprecated.** `tfx-qa` 로 통합.
> Deep 3-CLI QA 는 이제 `tfx-qa` 의 기본 동작. 빠른 test-fix 는 `/tfx-qa --quick`.

## 마이그레이션

```
Skill(skill="tfx-qa", args="<원래 ARGUMENTS>")
```

Issue #112 참조. v11 릴리즈 시 제거.
