---
id: 0018
title: CTO 자동 동작을 명시적으로 켜야 실행한다
status: proposed
date: 2026-09-24
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0010, 0011]
pr: null
---

# ADR-0018: CTO 자동 동작을 명시적으로 켜야 실행한다

## 컨텍스트와 문제

[#576 재평가](https://github.com/tellang/triflux/issues/576)에서 19개 저장소의 CTO lake 이벤트 8,134건은 `session_started`와 `collect` 두 종류뿐이었고, 이를 판단에 사용한 흔적은 없었다. 사람의 CTO 언급은 7월 203건에서 8월 0건, 9월 1건으로 줄었으며, 허브를 거친 CTO 메시지는 7월 17일 이후 0건이었다. 트레이는 26시간 동안 팝오버를 연 흔적이 한 번이고, 자동 기동이 사용자 설정에서 꺼져 있었다. 자동 동작의 비용에 비해 효용이 입증되지 않아 기본값을 재검토한다.

## 결정

우리는 CTO 관련 자동 동작을 명시적 opt-in으로 전환한다.

- North star 주입은 `TFX_CTO_NORTH_STAR=1`일 때만 실행한다.
- 허브 auto-collect와 SessionStart 등 훅의 lake 자동 기록은 `TFX_CTO_AUTO_COLLECT=1`일 때만 실행한다. 자동 수집이 꺼져 갱신되지 않는 lake의 CTO 값을 HUD에서 현재 상태처럼 표시하지 않는다.
- 허브의 트레이 자동 기동은 `TFX_HUB_AUTO_TRAY=1`일 때만 실행한다.
- `TFX_CTO=0` 마스터 스위치와 `TFX_CTO_MANAGER`, `TFX_LEAD_MANAGER`의 의미는 유지한다. CTO 코드와 기존 lake 데이터, `tfx cto collect|status|dashboard|hygiene|steward|event` 및 `tfx tray` 수동 명령은 유지한다.

## 검토한 대안

- **전부 제거**: 자동 비용은 사라지지만 명시적 조회와 기존 데이터의 가치까지 잃고, 다른 기능이 의존하는 경로도 한 번에 끊는다.
- **현상 유지**: 기존 사용법은 그대로지만 #576에서 확인된 자동 비용과 미사용 상태가 계속된다.
- **opt-in 전환(채택)**: 기본 실행 비용을 없애면서 환경변수로 자동 동작을 다시 켤 수 있다. 수동 명령과 데이터도 보존한다.

## 결과

기본 상태에서는 lake 자동 기록과 트레이 자동 기동이 멈춘다. lake 스냅샷은 수동 명령이나 명시적으로 켠 자동 수집이 갱신할 때까지 오래된 값일 수 있다. 이후 제거·통합 여부는 #576의 후속 단계에서 별도로 결정한다.
