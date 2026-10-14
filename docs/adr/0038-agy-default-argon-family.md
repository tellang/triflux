---
id: 0038
title: Antigravity 가족을 Flash에서 Argon으로 바꾼다
status: accepted
date: 2026-10-14
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0037]
pr: null
---

# ADR-0038: Antigravity 가족을 Flash에서 Argon으로 바꾼다

## 컨텍스트와 문제

ADR-0037의 가족 해석기는 `agy models`에서 Flash 가족만 자동 선택한다. 2026-10-14에 Gemini 4 Argon 가족과 Gemini 3.8 Flash High를 같은 과제 세 개로 비교했다(agy 1.3.4, 과제당 1회 실행). 네 모델 모두 세 과제를 맞혔고, 차이는 응답 시간과 생각 토큰이었다.

- 수식 파서 구현(31개 테스트): Flash High 296초(생각 토큰 41K), Argon Low 9.6초, Medium 10.0초, High 52.5초.
- bash 3.2 빈 배열 버그 찾기: Flash High 76.5초, Argon Low 5.1초, Medium 4.7초, High 9.0초.
- 4x4 점등 퍼즐: Flash High 112.7초(생각 토큰 18K), Argon Low 19.5초, Medium 32.8초, High 44.0초.

## 결정

Antigravity 프로필을 `argon_low`, `argon`, `argon_high` 하나의 가족으로 바꾸고 Flash 가족을 뺀다. 같은 가족의 사용 가능한 숫자 버전 중 최신 모델을 고르고, `models.json`의 `argon` 고정을 적용한다. 옛 `flash`, `flash_low`, `flash_high`와 버전이 붙은 `flash38_*` 이름은 effort와 관계없이 `argon_low`로 해석한다. 측정한 어떤 과제에서도 Argon Low가 Flash High보다 빨랐다. Flash와 Pro는 자동 선택하지 않는다.

Gemini 4 세대 Flash가 나오면 같은 과제로 다시 재고, 저지연 lane에 넣을지 새 ADR로 정한다.

## 검토한 대안

- 검토와 설계 lane만 Argon으로 옮기기: 나머지 lane에 더 느린 Flash를 남길 이유가 없다.
- Argon을 기본으로 하고 Flash 가족을 명시 호출용으로 남기기: 3.8 Flash는 Argon Low보다 느려서 고를 이유가 없다. 남겨 두면 프로필 표와 해석기만 길어진다.
- Argon 프로필만 추가하고 기본은 Flash로 유지하기: 측정한 응답 시간 차이를 기본 라우팅에 반영하지 못한다.
