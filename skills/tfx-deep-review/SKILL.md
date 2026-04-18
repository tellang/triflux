---
internal: true
name: tfx-deep-review
description: "DEPRECATED — tfx-review 로 통합됨. 딥 리뷰는 이제 tfx-review 의 기본 동작. 빠른 리뷰는 /tfx-review --quick 사용. 이 스킬은 tfx-review 를 호출한다."
triggers:
  - deep review
  - 심층 리뷰
  - multi review
  - deep-review
  - 철저한 리뷰
argument-hint: "[파일 경로 또는 변경 설명]"
---

# tfx-deep-review — DEPRECATED (→ tfx-review)

> **이 스킬은 deprecated 입니다.** `tfx-review` 로 통합되었습니다.
> Deep 3-CLI consensus 는 이제 `tfx-review` 의 **기본 동작**.
> 빠른 단일 CLI 리뷰는 `/tfx-review --quick`.

## 마이그레이션

이 스킬이 호출되면 `tfx-review` 를 호출하고 ARGUMENTS 를 그대로 전달한다.

```
Skill(skill="tfx-review", args="<원래 ARGUMENTS>")
```

ARGUMENTS 에 `--quick` 이 포함돼 있으면 제거하고 전달한다 (deep 이 요청이었으므로).

## Deprecation 사유

- 2026-04-18: triflux skill sprawl 정리 — 41개 tfx-* 스킬 → ~15개
- "AI makes completeness near-free" — 딥이 기본값이 자연스러움
- quick/deep variant 중복 → 단일 스킬 + 플래그로 통합

## 제거 예정

- v11 릴리즈 시 이 스킬 파일 자체를 제거할 수 있다. 현재는 backward compatibility 를 위해 유지.
- issue #112 참조.
