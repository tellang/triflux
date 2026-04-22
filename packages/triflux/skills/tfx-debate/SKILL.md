---
name: tfx-debate
description: >
  DEPRECATED — tfx-auto consensus shape 로 통합됨. `/tfx-auto --mode consensus --shape debate` 로 리다이렉트.
  Phase 4a 부터 debate 는 별도 엔진이 아니라 consensus family 내부의 옵션 비교 shape 다.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - debate
  - 토론
  - 3자 토론
  - tri-debate
  - 멀티모델 토론
argument-hint: "<토론 주제 또는 질문 — tfx-auto 로 passthrough>"
---

# tfx-debate (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --mode consensus --shape debate` 로 리다이렉트.
> debate 는 이제 독립 스킬이 아니라 `tfx-auto` consensus family 의 비교 shape 다.

## 동작

canonical 위임 **이전** 에 아래 bash 블록을 한 번 실행한다. Phase 5 (v11) 물리 삭제 게이트는 `.omc/state/alias-usage.log` 의 7일 zero-usage 검증에 의존 — 이 logging 이 빠지면 게이트가 영영 열리지 않는다.

```bash
mkdir -p .omc/state
echo "[deprecated] tfx-debate -> use: tfx-auto --mode consensus --shape debate" >&2
echo "[DEPRECATED] tfx-debate — see tfx-auto --mode consensus --shape debate"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tfx-debate -> tfx-auto --mode consensus --shape debate" >> .omc/state/alias-usage.log
```

1. 위 bash 블록 실행 (stderr 경고 + stdout `[DEPRECATED]` 마커 + alias-usage.log append).
2. ARGUMENTS 전체 앞에 `--mode consensus --shape debate` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. `--options`, `--criteria`, `--cli-set`, `--analysis-prompt-file` 같은 debate 전용 인자는 그대로 passthrough 한다.

## 등가 플래그

`--mode consensus --shape debate`

옵션 비교 shape 입력:
- `--options "A|B|C"` 또는 동등한 옵션 목록
- `--criteria "latency|complexity|operability"` 또는 동등한 평가 기준

## 이 alias 의 의미

tfx-debate 의 본질은 "3-CLI 토론 엔진"이 아니라 "옵션 비교와 최종 추천을 내는 보고서 shape" 였다. Phase 4a 부터 orchestration root 는 `--mode consensus` 로 통합되고, debate 의미는 `--shape debate` 로 보존된다.

공통 규약:
- participants 기본값은 `triad` (Claude + Codex + Gemini)
- `--cli-set no-gemini` 시 partial consensus 로 degrade 가능
- 공통 `meta_judgment` 는 `hub/team/consensus-meta.mjs` 스키마를 따른다

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-debate "REST vs GraphQL"` | `/tfx-auto "REST vs GraphQL" --mode consensus --shape debate` |
| `/tfx-debate "Redis vs Kafka" --options "Redis|Kafka" --criteria "latency|operability"` | `/tfx-auto "Redis vs Kafka" --mode consensus --shape debate --options "Redis\|Kafka" --criteria "latency\|operability"` |
