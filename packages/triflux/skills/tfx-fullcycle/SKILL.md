---
name: tfx-fullcycle
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --mode deep --parallel 1` 로 리다이렉트.
  Phase 5 (v11) 에 물리 삭제 예정. "pipeline-thorough 단일 실행" 의미는 플래그로 동일 표현.
deprecated: true
superseded-by: tfx-auto
triggers:
  - deep autopilot
  - 풀 오토
  - 처음부터 끝까지
  - full auto
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-fullcycle (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --mode deep --parallel 1` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

## 동작

canonical 위임 **이전** 에 아래 bash 블록을 한 번 실행한다. Phase 5 (v11) 물리 삭제 게이트는 `.omc/state/alias-usage.log` 의 7일 zero-usage 검증에 의존 — 이 logging 이 빠지면 게이트가 영영 열리지 않는다.

```bash
mkdir -p .omc/state
echo "[deprecated] tfx-fullcycle -> use: tfx-auto --mode deep --parallel 1" >&2
echo "[DEPRECATED] tfx-fullcycle — see tfx-auto --mode deep --parallel 1"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tfx-fullcycle -> tfx-auto --mode deep --parallel 1" >> .omc/state/alias-usage.log
```

1. 위 bash 블록 실행 (stderr 경고 + stdout `[DEPRECATED]` 마커 + alias-usage.log append).
2. ARGUMENTS 전체 앞에 `--mode deep --parallel 1` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리.

## 등가 플래그

`--mode deep --parallel 1`

## 이 alias 의 의미

tfx-fullcycle 의 "pipeline-thorough 단일 실행" (plan → PRD → exec → verify → fix loop) 은 --mode deep --parallel 1 과 동일하다.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-fullcycle "작업"` | `/tfx-auto "작업" --mode deep --parallel 1` |
