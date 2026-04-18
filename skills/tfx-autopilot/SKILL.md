---
name: tfx-autopilot
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto` 로 리다이렉트 (플래그 없음, 기본 동작 동일).
  Phase 5 (v11) 에 물리 삭제 예정. tfx-autopilot 은 tfx-auto 복제본이었으므로 플래그 없이 그대로 리다이렉트.
deprecated: true
superseded-by: tfx-auto
triggers:
  - autopilot
  - 자동
  - 알아서 해
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-autopilot (DEPRECATED → tfx-auto alias)

> DEPRECATED. 이 스킬은 `/tfx-auto` 로 리다이렉트된다. 실제 워크플로우는 tfx-auto 가 수행한다.
> Phase 5 (v11) 에 물리 삭제 예정.

## 동작

1. stderr 에 1회 deprecation 경고 출력:
   ```
   [deprecated] tfx-autopilot -> use: tfx-auto
   ```
2. ARGUMENTS 를 그대로 `Skill("tfx-auto")` 에 전달한다 (추가 플래그 없음).
3. tfx-auto 의 Step 0 스마트 라우팅과 플래그 오버라이드 로직이 나머지를 처리한다.

## 등가 플래그

`(기본)` — 추가 플래그 없음.

상세 동작은 `~/.claude/skills/tfx-auto/SKILL.md` 의 "플래그 오버라이드" 섹션 참조.

## 이 alias 의 의미

tfx-autopilot 은 구현상 tfx-auto 의 복제본이었다. 별도 이름을 유지할 명분이 없어 tfx-auto 로 흡수. muscle memory 유지 목적으로 alias 만 남긴다.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-autopilot "작업"` | `/tfx-auto "작업"` |

muscle memory 는 그대로 동작. 새 작업부터는 `/tfx-auto` 를 직접 사용 권장.
