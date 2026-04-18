---
name: tfx-auto-codex
description: >
  DEPRECATED — tfx-auto 로 통합됨. Phase 3 부터 `/tfx-auto --cli codex --lead codex --no-claude-native` 플래그로 완전 표현됨.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - tfx-auto-codex
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-auto-codex (DEPRECATED → tfx-auto alias)

> DEPRECATED. Phase 3 부터 `/tfx-auto --cli codex --lead codex --no-claude-native` 로 완전 리다이렉트.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-auto-codex -> use: tfx-auto --cli codex --lead codex --no-claude-native
   ```
2. ARGUMENTS 전체 앞에 `--cli codex --lead codex --no-claude-native` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리 — `--lead codex` 는 분류·메타판단도 Codex 에 위임하고, `--no-claude-native` 는 Claude native sub-agent 경로를 끈다.

## 등가 플래그

`--cli codex --lead codex --no-claude-native` (Phase 3)

이전 (Phase 2): `--cli codex` + env `TFX_NO_CLAUDE_NATIVE=1`. env 경로는 하위 호환으로 유지되지만 플래그가 우선.

## 이 alias 의 의미

tfx-auto-codex 는 "Codex lead + Gemini 유지 + Claude native 제거" 조합이었다. Phase 3 에서 플래그 3개로 완전 표현 가능해졌다:

- `--cli codex` — CLI 에이전트 를 Codex 로 고정
- `--lead codex` — 분류·메타판단 단계까지 Codex 에 위임 (Gemini 경로는 그대로)
- `--no-claude-native` — Claude native sub-agent 경로 disable

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-auto-codex "작업"` | `/tfx-auto "작업" --cli codex --lead codex --no-claude-native` |
| `TFX_NO_CLAUDE_NATIVE=1 /tfx-auto-codex "작업"` | `/tfx-auto "작업" --cli codex --lead codex --no-claude-native` (env 와 플래그 중복 시 플래그 우선) |
