---
name: tfx-persist
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --mode deep --retry ralph` 로 리다이렉트.
  ⚠ --retry ralph 는 Phase 2 현 구현에서 bounded retry 3회로 degrade 된다 (완전한 ralph state machine 은 Phase 3+).
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - ralph
  - don't stop
  - 끝까지
  - until done
  - 멈추지 마
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-persist (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --mode deep --retry ralph` 로 리다이렉트.
> ⚠ --retry ralph 는 현재 bounded 3회로 degrade. 완전한 ralph state machine 은 Phase 3+.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-persist -> use: tfx-auto --mode deep --retry ralph
   ```
2. ARGUMENTS 전체 앞에 `--mode deep --retry ralph` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리 (ralph 는 bounded degrade + stderr 경고).

## 등가 플래그

`--mode deep --retry ralph`

## 이 alias 의 의미

tfx-persist 는 이름상 ralph/persist 이지만 실제 구현은 bounded verify/fix 3회 루프였다. --retry ralph 로 **의도** 를 표현하되, Phase 2 단계에서는 여전히 bounded 로 동작하고 stderr 에 degrade 경고가 나간다. 진짜 ralph state machine (종료 조건, 상태 저장, 중단/재개) 은 Phase 3+ 에 별도 구현.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-persist "작업"` | `/tfx-auto "작업" --mode deep --retry ralph` |
