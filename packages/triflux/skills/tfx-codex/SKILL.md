---
name: tfx-codex
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --cli codex` 로 리다이렉트.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - tfx-codex
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-codex (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --cli codex` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-codex -> use: tfx-auto --cli codex
   ```
2. ARGUMENTS 전체 앞에 `--cli codex` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리 (`TFX_CLI_MODE=codex`).

## 등가 플래그

`--cli codex`

## 이 alias 의 의미

Codex CLI 전용 라우팅 고정. tfx-auto 의 `--cli codex` 플래그로 동일 의미 표현.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-codex "작업"` | `/tfx-auto "작업" --cli codex` |
