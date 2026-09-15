---
id: 0013
title: synapse 만료 창 단일화
status: proposed
date: 2026-09-15
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0010]
pr: null
---

# ADR-0013: synapse 만료 창 단일화

## 컨텍스트와 문제 (Context)

`hub/team/synapse-registry.mjs` 의 `pruneExpired` 는 세션 행을 두 창으로 나눠
만료시킨다. `dirtyFiles` 가 있으면 24시간, 비어 있으면 2시간이다. 분기는
`synapse-registry.mjs:402` 한 줄이다.

이 분기의 원래 소비자는 git-preflight 의 dirty-file 충돌 가드였다. 같은 세션이
재개하면 그 가드가 되살아나므로 더러운 행을 오래 붙잡아 둔다는 논리였다.

그 가드는 커밋 `de0d61fa` 로 제거됐다. 지금 `dirtyFiles` 를 채우는 코드는 없다.
실행 중이던 허브에서 24개 행을 확인했고 채워진 행은 0개였다. 결과적으로 모든
행이 2시간 창으로만 만료되고, 24시간 창은 도달할 수 없는 분기로 남아 있다.

## 결정 (Decision)

`dirtyFiles` 기반 만료 분기를 제거하고 단일 창으로 합친다. `DEFAULT_EXPIRE_TIMEOUT_MS`
와 `DEFAULT_CLEAN_EXPIRE_TIMEOUT_MS` 중 실제로 도달하는 2시간 쪽을 기본값으로 남긴다.

`dirtyFiles` 필드 자체는 레코드에 유지한다. 이미 디스크에 저장된 행과의 호환을
깨지 않기 위해서다. 값은 언제든 다시 채울 수 있으나 만료 정책이 그것을 읽지 않는다.

## 검토한 대안 (Considered Options)

- **현행 유지**: 변경 비용이 없다. 대신 도달 불가 분기가 남아 다음 독자를 오도한다.
- **분기 제거, 필드 유지(채택)**: 정책이 단순해지고 기존 저장 파일이 깨지지 않는다.
- **분기와 필드 모두 제거**: 가장 깨끗하다. 대신 저장된 행의 스키마가 바뀐다.
- **dirtyFiles 를 다시 채워 분기를 살린다**: 중재 기능을 복원하는 길이다. 다만 세션
  단위 파일 점유 중재를 새로 설계해야 하므로 이 ADR 의 범위를 넘는다.

## 결과 (Consequences)

- `pruneExpired` 의 cutoff 계산이 세 갈래에서 두 갈래로 줄어든다.
- `tests/unit/synapse-stale-expire.test.mjs` 의 두 창 구분 테스트를 하나로 합친다.
- 만료가 빨라지는 행은 없다. 지금도 모든 행이 2시간 창을 쓰고 있었다.
- 되돌릴 조건: 세션 단위 파일 점유 중재를 다시 만들 때다. 그 경우 레코드에 CLI
  식별자 필드를 먼저 넣어야 한다. 현재 synapse 행은 Claude 와 Codex 와 agy 를
  구분하지 못한다.
