---
id: 0038
title: Antigravity를 Argon으로 바꾸고 역할 배정을 다시 정한다
status: superseded
date: 2026-10-14
deciders: [tellang]
supersedes: []
superseded_by: 0039
relates: [0037]
pr: null
---

# ADR-0038: Antigravity를 Argon으로 바꾸고 역할 배정을 다시 정한다

## 컨텍스트와 문제

ADR-0037의 가족 해석기는 `agy models`에서 Flash 가족만 자동 선택한다. 2026-10-14에 Gemini 4 Argon 가족과 Gemini 3.8 Flash High를 같은 과제 세 개로 비교했다(agy 1.3.4, 과제당 1회 실행). 네 모델 모두 세 과제를 맞혔고, 차이는 응답 시간과 생각 토큰이었다.

- 수식 파서 구현(31개 테스트): Flash High 296초(생각 토큰 41K), Argon Low 9.6초, Medium 10.0초, High 52.5초.
- bash 3.2 빈 배열 버그 찾기: Flash High 76.5초, Argon Low 5.1초, Medium 4.7초, High 9.0초.
- 4x4 점등 퍼즐: Flash High 112.7초(생각 토큰 18K), Argon Low 19.5초, Medium 32.8초, High 44.0초.

## 결정

Antigravity 프로필을 `argon_low`, `argon`, `argon_high` 하나의 가족으로 바꾸고 Flash 가족을 뺀다. 같은 가족의 사용 가능한 숫자 버전 중 최신 모델을 고르고, `models.json`의 `argon` 고정을 적용한다. 옛 `flash`, `flash_low`, `flash_high`와 버전이 붙은 `flash38_*` 이름은 effort와 관계없이 `argon_low`로 해석한다. 측정한 어떤 과제에서도 Argon Low가 Flash High보다 빨랐다. Flash와 Pro는 자동 선택하지 않는다.

Gemini 4 세대 Flash가 나오면 같은 과제로 다시 재고, 저지연 lane에 넣을지 새 ADR로 정한다.

역할 배정은 Claude, Codex, Argon High의 독립 토론(1라운드, 세 참여자 모두 응답)에서 셋 다 동의한 것만 바꾼다. 원자료는 `.omc/artifacts/consensus/2026-10-14-argon-lanes/`에 있다.

- `document-specialist`(외부 문서 조사)를 Codex에서 Antigravity로 옮긴다. 근거는 Google 출시 표의 간접 프롬프트 주입 공격 성공률(Argon 0.7%, Opus 5.5 1.0%, Astra 8.5%)이다.
- 입력이 큰 코드베이스 읽기는 Antigravity로 보낸다. 근거는 GraphWalks(Argon 84.2, Astra 71.8, Opus 66.8)와 1M 공유 문맥이다.
- 구현, 디버깅, 리뷰, 계획, 재시도 체인은 그대로 둔다.
- explore는 Claude에 그대로 둔다. 토론은 Argon Low를 제안했지만, 측정해 보니 셋 중 가장 느렸다. 같은 22개 과제(explore 10, 요약 5, 분류 7, 1회 실행)에서 세 모델 모두 전부 맞혔고, 걸린 시간은 다음과 같았다.
  - explore: Codex Luna 20.4초, Claude Haiku 31.6초, Argon Low 43.9초
  - 요약: Luna 10.7초, Haiku 12.1초, Argon Low 13.1초
  - 분류: Luna 6.1초, Haiku 7.0초, Argon Low 10.4초

## 검토한 대안

- 검토와 설계 lane만 Argon으로 옮기기: 나머지 lane에 더 느린 Flash를 남길 이유가 없다.
- Argon을 기본으로 하고 Flash 가족을 명시 호출용으로 남기기: 3.8 Flash는 Argon Low보다 느려서 고를 이유가 없다. 남겨 두면 프로필 표와 해석기만 길어진다.
- Argon 프로필만 추가하고 기본은 Flash로 유지하기: 측정한 응답 시간 차이를 기본 라우팅에 반영하지 못한다.
- 벤치마크 강점대로 lane을 전부 다시 배정하기: 근거가 Google 출시 표 하나뿐이고 그 안에서도 엇갈린다. DeepSWE에서는 Argon이 이기지만 FrontierSWE에서는 Astra에, Terminal-bench 4.0에서는 Opus에 진다.
- 재시도 체인 맨 앞에 Argon 넣기: Argon 참여자만 제안했고, 추가 단계가 실패를 줄인다는 근거가 없다.
