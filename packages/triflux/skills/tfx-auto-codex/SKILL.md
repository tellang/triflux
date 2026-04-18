---
name: tfx-auto-codex
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --cli codex` (+ TFX_NO_CLAUDE_NATIVE=1) 로 리다이렉트.
  Phase 5 (v11) 에 물리 삭제 예정. 완전한 "Codex lead + Gemini 유지 + Claude native 제거" 의미는 Phase 3+ 의 --lead codex + --no-claude-native 플래그로 표현.
deprecated: true
superseded-by: tfx-auto
triggers:
  - tfx-auto-codex
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-auto-codex (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --cli codex` + `TFX_NO_CLAUDE_NATIVE=1` 로 리다이렉트.
> 완전한 의미는 Phase 3+ 에 --lead/--no-claude-native 플래그로 도입 예정.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-auto-codex -> use: tfx-auto --cli codex (+ TFX_NO_CLAUDE_NATIVE=1)
   ```
2. 세션 env 에 `TFX_NO_CLAUDE_NATIVE=1` 를 설정한다 (tfx-auto 가 이 env 를 감지하여 Claude native 에이전트를 스킵).
3. ARGUMENTS 전체 앞에 `--cli codex` 를 prepend 하여 `Skill("tfx-auto")` 호출.
4. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리.

## 등가 플래그

`--cli codex` + env `TFX_NO_CLAUDE_NATIVE=1`

## 이 alias 의 의미

tfx-auto-codex 는 "Codex lead + Gemini 유지 + Claude native 제거" 조합이었다. 현 플래그 축으로 완전 표현 어려워서, --cli codex (Codex 부분) + env TFX_NO_CLAUDE_NATIVE=1 (Claude native 제거) 로 근사. Phase 3+ 에 --lead codex + --no-claude-native 로 명시 도입 예정.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-auto-codex "작업"` | `/tfx-auto "작업" --cli codex` (Claude native 유지 허용 시) |
| `/tfx-auto-codex "작업"` | `TFX_NO_CLAUDE_NATIVE=1 /tfx-auto "작업" --cli codex` (엄격 Codex-only) |
