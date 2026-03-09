# Codex 팀 런타임 구현 계획

## 1) 전제
> native Claude TeamCreate/TaskCreate APIs are not available in Codex; use Hub task/message abstraction instead.

## 2) 단계별 실행
### Phase 0: 정합성 정의 (M0)
- 산출물: 팀/작업 공통 스키마(`team_id`, `task_id`, `trace_id`, `correlation_id`, `topic`)와 상태 전이 표준.
- 산출물: Codex 전용 진입 커맨드 `tfx codex-team` 추가 (초기에는 `tfx team` 래퍼)
- 완료 기준: 기존 `tfx hub` 메시지 포맷과 충돌 없음 검증 완료.

### Phase 1: 런타임 어댑터 구축 (M1)
- 산출물: Team/Task 요청을 Hub handoff/publish/ask/poll로 변환하는 어댑터 계층.
- 완료 기준: 단일 팀, 단일 작업 E2E 성공(생성/실행/완료/실패 보고).

### Phase 2: 병렬 오케스트레이션 (M2)
- 산출물: 동시성 제한, 큐 정책, 우선순위, 타임아웃/재시도 제어.
- 완료 기준: 병렬 시나리오에서 SLA 내 완료율 목표 충족(기준값은 운영 환경에서 확정).

### Phase 3: 관측성 및 운영 통제 (M3)
- 산출물: 상태 대시보드 지표, 감사 로그, 실패 분석 리포트.
- 완료 기준: 장애 재현 시 추적 경로(요청->작업->에이전트) 100% 식별 가능.

### Phase 4: 점진 롤아웃 (M4)
- 산출물: feature flag 기반 canary 전환 및 롤백 절차.
- 완료 기준: 호환성 이슈 없이 기존 팀 워크플로우 유지.

## 3) 리스크 통제
- `스키마 드리프트`: 버전 필드와 계약 테스트(contract test)로 차단.
- `중복 실행`: `task_id + idempotency_key` 중복 검사와 원자적 상태 전이 적용.
- `큐 적체`: 동시성 상한, 백프레셔, 우선순위 재정렬 정책 적용.
- `부분 실패 전파`: 단계별 타임아웃과 보상 처리(재시도/실패 격리)로 피해 범위 제한.
- `관측성 공백`: 필수 상관키 누락 시 배포 차단(게이트) 적용.

## 4) 기존 tfx team/hub 호환 정책
- 기존 hub API/토픽 계약은 기본적으로 유지한다(비파괴 변경 우선).
- 신규 필드는 optional로 추가하고, 필수화는 메이저 버전에서만 수행한다.
- 어댑터 계층은 기존 consumer가 이해하는 이벤트를 우선 생성한다.
- feature flag off 시 기존 경로로 즉시 롤백 가능해야 한다.
