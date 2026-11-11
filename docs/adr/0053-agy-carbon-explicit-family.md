---
id: 0053
title: agy Carbon 가족을 명시 지정 전용으로 추가하고 목록에 없으면 Argon으로 폴백한다
status: accepted
date: 2026-11-11
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0038, 0039, 0049]
pr: null
---

# ADR-0053: agy Carbon 가족을 명시 지정 전용으로 추가하고 목록에 없으면 Argon으로 폴백한다

## 결정

Gemini 4 Carbon(2026-11-10 출시)을 agy 모델 가족 `carbon`으로 추가하고 `carbon_low`, `carbon`, `carbon_high` 프로필을 만든다. 기본 역할 배정(`argon_high`, `argon`, `argon_low`)과 `--retry auto-escalate` 체인은 바꾸지 않는다. Carbon은 `TFX_GEMINI_PROFILE=carbon_high`처럼 명시할 때만 쓴다.

해석기는 `AGY_FAMILY_PROFILES`의 가족 목록으로 슬러그 정규식과 가족별 선택을 만든다. 새 가족은 이 표에 프로필을 더하면 된다.

Carbon은 Google AI Ultra 구독자만 쓴다. `agy models`를 읽었는데 Carbon이 없으면 같은 effort의 Argon으로 폴백하고, 해석 결과의 `fallbackFrom`과 stderr 한 줄로 알린다. 목록을 읽지 못한 경우는 마지막 성공 결과와 내장 기본값을 그대로 쓴다. `models.json`으로 고정한 가족은 폴백하지 않는다.

## 이유

- 공개 자료의 이득은 Google 자체 측정이 대부분이고 독립 검증이 없다. 같은 표에서 Carbon이 Argon보다 낮은 항목(RiemannBench)이 있다.
- 속도와 토큰 사용량이 Argon보다 크다. 같은 설계 과제에서 Carbon medium은 612초가 걸렸다. 현재 agy 기대 시간(600~900초)에 상시 "느림" 경고가 붙는다.
- 쿼터 풀이 Argon과 같은지 확인되지 않았다. 기본 배정을 옮기면 2026-10-14의 쿼터 소진을 앞당길 수 있다.
- Ultra가 없는 기기에서 기본 프로필이 깨지면 안 되므로 폴백이 필요하다.

## 검토한 대안

- 일부 역할(architect, critic, security-reviewer, verifier)을 Carbon high로 옮기기: 독립 측정이 없고 느린 데다 교차 벤더 리뷰 규칙(ADR-0039)의 보안 리뷰 배치와 맞부딪힌다. 4자 협의에서 Claude 반론 쪽이 한 역할만 옮기는 안을 냈으나 나머지 셋이 명시 지정 전용을 골랐다.
- 광범위 배정: 근거가 가장 약하고 쿼터 위험이 가장 크다.
- 폴백 신호를 stderr, 구분 필드, 반환 JSON 세 층으로 나누고 영속 기록까지 보호하기: 호출자가 쓰는 곳이 하나라 `fallbackFrom` 필드와 stderr 한 줄로 줄였다.
- `parseAgyModelSpec` 같은 새 파서로 정규식 세 곳을 묶기: 실제 중복은 resolver와 `tfx-route.sh` 두 곳뿐이라 가족 목록 내보내기로 충분하다.

## 한계

- `TFX_WORKER_MODEL`에 슬러그를 직접 넣는 경로는 프로필 해석을 건너뛰므로 폴백이 적용되지 않는다. 폴백이 필요하면 프로필 이름으로 지정한다.
- 비Ultra 계정의 `agy models`에 Carbon이 보이는지는 확인하지 못했다. 보이면 폴백이 일어나지 않고 agy가 호출 때 거부한다.
- 이득 판단은 공개 자료 기준이다. 쿼터 풀과 품질은 실사용 뒤 다시 본다.
