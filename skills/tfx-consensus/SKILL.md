---
name: tfx-consensus
description: >
  DEPRECATED — tfx-auto consensus root 로 통합됨. `/tfx-auto --mode consensus` 가 canonical entrypoint 다.
  Phase 4a 부터 consensus/debate/panel 은 같은 엔진 family 를 공유하고, 차이는 `--shape` 와 renderer 에만 남긴다.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers: [consensus, 합의]
argument-hint: "<분석 주제 또는 컨텍스트 — tfx-auto 로 passthrough>"
---

# tfx-consensus (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --mode consensus` 로 리다이렉트.
> `shape=consensus` 가 기본값이므로 추가 `--shape` 없이 기존 의미를 유지한다.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-consensus -> use: tfx-auto --mode consensus
   ```
2. stdout 머리부에 `[DEPRECATED]` 마커를 출력한다.
3. `.omc/state/alias-usage.log` 에 아래 형식으로 append 한다:
   ```
   2026-04-18T12:34:56Z tfx-consensus -> tfx-auto --mode consensus
   ```
4. ARGUMENTS 전체 앞에 `--mode consensus` 를 prepend 하여 `Skill("tfx-auto")` 호출.
5. `--shape` 미지정 시 기본값은 `consensus` 다. `--analysis-prompt-file`, `--cli-set`, `--resolution-threshold` 같은 합의 인자는 그대로 passthrough 한다.

## 등가 플래그

`--mode consensus`

동등한 명시 표현:
- `/tfx-auto "<topic>" --mode consensus`
- `/tfx-auto "<topic>" --mode consensus --shape consensus`

## 이 alias 의 의미

tfx-consensus 는 여전히 consensus family 의 canonical semantics 를 대표하지만, 별도 엔진으로 유지하지 않는다. Phase 4a 부터 공통 orchestration, participant 상태, artifact 경로, `meta_judgment` 스키마를 `tfx-auto --mode consensus` 가 소유한다.

공통 계약:
- artifact 경로: `.omc/artifacts/consensus/<session-id>/consensus.{md,json}`
- 공통 메타 유틸: `hub/team/consensus-meta.mjs`
- 공통 root 메타: `mode`, `shape`, `topic`, `cli_set`, `participants`, `status`

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-consensus "이 PR merge 가능?"` | `/tfx-auto "이 PR merge 가능?" --mode consensus` |
| `/tfx-consensus "합의 분석" --analysis-prompt-file prompt.md` | `/tfx-auto "합의 분석" --mode consensus --analysis-prompt-file prompt.md` |
