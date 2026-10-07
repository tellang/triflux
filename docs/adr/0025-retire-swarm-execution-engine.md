---
id: 0025
title: swarm 실행 엔진 퇴역
status: accepted
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0005, 0008, 0024]
pr: null
---

# ADR-0025: swarm 실행 엔진 퇴역

## 컨텍스트와 문제

swarm 실행은 2026-07-17 이후 관측되지 않았다. 2026-07-16 데이터 손실 사고 뒤에도 기본 실행 경로로 안내하는 규칙이 남아 있었다. worktree lease 검사는 실패할 수 없는 구조이고, 실행 상태와 완료 판정에도 결함이 있다. 이제 Git worktree와 Claude Agent의 `isolation: worktree`로 코드 변경 작업을 격리하고 세션을 병렬로 실행할 수 있다.

## 결정

`tfx swarm` 실행 엔진과 전용 모듈, mesh 및 동적 라우팅을 퇴역한다. 코드 변경 병렬 작업은 작업별 worktree와 세션을 분리하고 각 세션에서 `tfx-auto`를 사용한다. 필요해지면 네이티브 worktree 격리와 `tfx-route.sh` 위에 얇게 다시 설계한다. 재설계는 이번 변경 범위에 포함하지 않는다.

## 검토한 대안

- **결함 수정 후 swarm 존치**: 기존 PRD shard 분배와 자동 통합 기능을 유지할 수 있지만, 사용 근거가 없고 lease 및 완료 판정 결함을 함께 고쳐야 한다.
- **실행 엔진 퇴역(채택)**: 사용하지 않는 실행 경로와 운영 부담을 제거하고, 병렬 코드 변경은 worktree와 세션으로 격리한다.

## 결과

`@triflux/core`의 `./mesh/*` export가 사라진다. `@triflux/remote` 배럴에서는 `createConductor`, `swarm-reconciler`를 포함한 Swarm 블록 전체가 빠진다. CLI에서 `tfx swarm`과 doctor `--dynamic-routing`을 제거하며 `TRIFLUX_DYNAMIC_ROUTING`은 실행 경로에서 더 이상 적용하지 않는다. `current.json`의 `sources`에서 `tfx_swarm`을 제거한다. 기존 swarm PRD와 Issue #281 계획은 `docs/_archive/`에 폐기 표시와 함께 보존한다.
