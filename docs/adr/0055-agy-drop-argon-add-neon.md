---
id: 0055
title: agy 기본 배정과 폴백에서 Argon을 빼고 Neon 가족을 추가한다
status: accepted
date: 2026-11-24
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0049, 0054]
pr: null
---

# ADR-0055: agy 기본 배정과 폴백에서 Argon을 빼고 Neon 가족을 추가한다

## 컨텍스트와 문제 (Context)

Antigravity(agy)에 Gemini 4 Neon 가족이 새로 나왔다. Google은 Neon을 Carbon과 Hydrogen 사이에 두고, `xhigh` effort까지 지원한다. 그런데 ADR-0054는 문서군 1순위와 소통 2순위를 Argon `medium`에 배정했다. 또 목록에 없는 가족은 모두 Argon으로 폴백한다. 2026-11-24 사용자는 Argon의 성능이 낮다고 보고 agy에서 Carbon, Neon, Hydrogen만 쓰기로 결정했다.

## 결정 (Decision)

- Neon을 가족 ID로만 추가한다. ADR-0049에 따라 새 결합 이름은 만들지 않는다. `TFX_GEMINI_PROFILE=neon`과 `TFX_GEMINI_EFFORT=<effort>`로 지정하고, retry 체인에는 `family`와 `effort`를 따로 적는다.
- 기본 라우팅에서 Argon을 Hydrogen으로 바꾼다. 대상은 writer, document-specialist, researcher, communication, communication-report와 agy 기본 프로필이다.
- 폴백은 하나의 기본 가족을 쓰지 않고 가족별 순서를 따른다.
  - Carbon: Neon, 그다음 Hydrogen
  - Neon: Hydrogen
  - Hydrogen: Neon
  - Argon: Hydrogen, 그다음 Neon
  - 순서에 있는 가족이 하나도 목록에 없으면 요청한 가족을 그대로 쓴다. Argon으로는 폴백하지 않는다.
- Argon은 `TFX_GEMINI_PROFILE=argon*`으로 명시할 때만 쓰는 호환 입력으로 남긴다. 옛 `flash*` 별칭도 그대로 Argon Low로 해석한다.

## 검토한 대안 (Considered Options)

- **기본 폴백 가족만 Argon에서 Hydrogen으로 바꾸기**: 구현은 가장 작다. 하지만 Carbon이 Neon을 건너뛰고 두 단계 아래인 Hydrogen으로 떨어진다.
- **목록에 아무것도 없으면 마지막에 Argon으로 폴백**: 실행은 계속된다. 하지만 사용자 결정과 맞지 않고, 성능이 낮은 모델이 조용히 선택된다.
- **Argon 가족 정의를 완전히 삭제**: 설정 파일과 옛 별칭이 깨진다. 그래서 호환 입력으로만 남긴다.

## 결과 (Consequences)

- 기본 배정이 한 등급 오른다(Argon mid에서 Hydrogen high). 그만큼 agy 쿼터를 더 쓸 수 있다.
- 옛 결합 이름(`carbon_high` 등)의 표시 이름 폴백은 결합 이름이 있는 Hydrogen으로 옮긴다. 이 이름은 `~/.gemini/triflux-profiles.json` 호환용이고, 실제 실행은 가족 ID와 effort를 쓴다.
- Argon만 보이는 계정에서는 요청한 가족 ID가 그대로 agy에 전달된다. 따라서 agy 오류로 끝난다.
