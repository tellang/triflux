---
name: tfx-panel
description: >
  DEPRECATED — tfx-auto consensus shape 로 통합됨. `/tfx-auto --mode consensus --shape panel` 로 리다이렉트.
  Phase 4a 부터 panel 은 별도 패널 엔진이 아니라 consensus family 내부의 전문가 시뮬레이션 shape 다.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - panel
  - 패널
  - 전문가 토론
  - expert panel
  - 전문가 패널
argument-hint: "<토론 주제 — tfx-auto 로 passthrough>"
---

# tfx-panel (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --mode consensus --shape panel` 로 리다이렉트.
> panel 은 이제 독립 스킬이 아니라 `tfx-auto` consensus family 의 전문가 시뮬레이션 shape 다.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-panel -> use: tfx-auto --mode consensus --shape panel
   ```
2. stdout 머리부에 `[DEPRECATED]` 마커를 출력한다.
3. `.omc/state/alias-usage.log` 에 아래 형식으로 append 한다:
   ```
   2026-04-18T12:34:56Z tfx-panel -> tfx-auto --mode consensus --shape panel
   ```
4. ARGUMENTS 전체 앞에 `--mode consensus --shape panel` 를 prepend 하여 `Skill("tfx-auto")` 호출.
5. `--experts`, `--cli-set`, `--analysis-prompt-file` 같은 panel 전용 인자는 그대로 passthrough 한다.

## 등가 플래그

`--mode consensus --shape panel`

전문가 shape 입력:
- `--experts "claude:Martin Fowler|Kent Beck;codex:Sam Newman|Gregor Hohpe;gemini:Michael Porter|Karl Wiegers"`
- 명시 roster 가 없으면 `tfx-auto` 가 주제 기반 기본 roster 를 선택한다.

## 이 alias 의 의미

tfx-panel 의 본질은 "패널 전용 orchestration" 이 아니라 "전문가 roster 를 주입한 뒤 panel 보고서로 렌더링하는 shape" 였다. Phase 4a 부터 공통 합의 루프는 `--mode consensus` 아래에 남기고, 전문가 분배와 panel renderer 만 `--shape panel` 이 책임진다.

공통 규약:
- participants 기본값은 `triad`
- 공통 `meta_judgment` 는 `mode_specific_meta.panel_size`, `mode_specific_meta.expert_distribution` 만 shape 확장으로 추가한다
- artifact 경로는 `.omc/artifacts/consensus/<session-id>/panel.{md,json}` 로 통일한다

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-panel "모놀리스 분해 전략"` | `/tfx-auto "모놀리스 분해 전략" --mode consensus --shape panel` |
| `/tfx-panel "가격 전략" --experts "claude:Porter;codex:Wiegers;gemini:Cagan"` | `/tfx-auto "가격 전략" --mode consensus --shape panel --experts "claude:Porter;codex:Wiegers;gemini:Cagan"` |
