---
id: 0024
title: CTO 는 조회만 남긴다
status: accepted
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0010, 0018, 0022]
pr: null
---

# ADR-0024: CTO 는 조회만 남긴다

## 컨텍스트와 문제

2026-09-24 재평가에서 CTO 를 명시적 조회로 축소하고 역할 시스템을 동결하기로 했다. 트레이는 이후 제거됐다. lake 기록은 `collect`와 `session_started`뿐이고, 주기 steward 루프와 이벤트 CLI 프리셋, hygiene 적용, dashboard 사용 근거는 확인되지 않았다. 자동 수집이 꺼진 뒤 오래된 스냅샷을 현재 상태처럼 읽을 위험도 있다.

## 결정

CTO lake 의 사용자 명령은 명시적으로 호출하는 `tfx cto collect`와 `tfx cto status`를 중심으로 남긴다. 기존 트레이는 제거하고 역할 시스템은 동결한다. 이번 단계에서 steward 루프, event CLI, hygiene apply, dashboard, 사용되지 않는 `session_vault`·`agy`·`gbrain` 수집원을 제거한다. hygiene 는 dry-run 조회와 `tfx-live`가 사용하는 공개 함수만 유지한다. `status`의 사람용 출력에는 스냅샷 생성 시각과 경과 시간을 표시한다.

## 검토한 대안

- **자동 CTO 운영 유지**: 주기 수집과 역할 관리를 이어갈 수 있지만, 사용 근거가 없고 유지 비용이 남는다.
- **조회 명령만 유지(채택)**: 필요할 때 수집하고 시각이 드러나는 스냅샷을 확인한다.

## 결과

`current.json`의 `sources`에서 세 수집원 키가 빠진다. 이 단계에서 다른 묶음이 소유한 auto-collect, north star 주입, 역할 호출부는 변경하지 않는다.
