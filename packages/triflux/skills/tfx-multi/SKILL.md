---
name: tfx-multi
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --parallel N --mode deep` 로 리다이렉트.
  tfx-auto 가 이 플래그 조합을 받으면 내부적으로 `tfx multi --teammate-mode headless` 를 호출한다.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - tfx-multi
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-multi (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --parallel N --mode deep` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-multi -> use: tfx-auto --parallel N --mode deep
   ```
2. ARGUMENTS 전체 앞에 `--parallel N --mode deep` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. tfx-auto 의 플래그 오버라이드 로직이 내부적으로 `tfx multi --teammate-mode headless` 를 호출한다.

## 등가 플래그

`--parallel N --mode deep`

## 이 alias 의 의미

tfx-multi 의 "로컬 headless 병렬 + thorough 기본" 은 --parallel N --mode deep 과 동일. N 은 ARGUMENTS 에 구체 숫자가 있으면 그대로 전달, 없으면 tfx-auto 가 subtask 수 기반으로 판단한다.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-multi "작업"` | `/tfx-auto "작업" --parallel N --mode deep` |
