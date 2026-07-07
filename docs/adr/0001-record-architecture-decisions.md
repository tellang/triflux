---
id: 0001
title: ADR로 아키텍처 결정을 기록한다
status: accepted
date: 2026-07-01
deciders: [tellang]
supersedes: []
superseded_by: null
relates: []
pr: null
---

# ADR-0001: ADR로 아키텍처 결정을 기록한다

## 컨텍스트와 문제 (Context)
triflux의 "왜 이렇게 했나"가 `ROADMAP.md`, `.triflux/plans/`, `docs/design/`, PRD, 규칙 파일에 흩어져 있어, 신규 기여자(사람/에이전트)가 이미 확정된 결정을 재논쟁한다. 결정의 단일 집이 없다.

## 결정 (Decision)
우리는 아키텍처·정책·횡단 결정을 `docs/adr/`에 번호화된 불변 ADR로 기록한다. 포맷은 MADR-minimal(Nygard 골격 + 필수 `## 결정`·`## 검토한 대안`)이며, 운영 규약은 `docs/adr/CONVENTIONS.md`, 정책 캘리브레이션은 `.document-harness.toml`, 각 결정의 근거는 개별 ADR이 소유한다.

## 검토한 대안 (Considered Options)
- **A안: ADR 도입 (채택)** — 장점: 결정에 단일·검색가능·불변 집. 단점: 작성 규율 필요.
- **B안: 현행 유지 (design/plan 산재)** — 장점: 추가 작업 0. 단점: 결정 추적 불가, 재논쟁 반복.
- **C안: RFC repo (Rust/K8s식)** — 장점: 무거운 합의 프로세스. 단점: 소규모/솔로에 과잉.

## 결과 (Consequences)
긍정: 결정 이력이 git에 남아 온보딩·중복 방지. 부정: `accepted` 후 불변 규율 + 상태보드 등재 의무. 후속: ADR-0002가 문서 아키텍처·개발 플로우 전체를 규정한다.
