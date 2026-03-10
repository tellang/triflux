# Codex 팀 런타임 요구사항

## 1) 목적
- Claude Agent Team UX와 유사한 팀 기반 작업 경험(역할 분리, 병렬 작업, 상태 가시성)을 제공한다.
- 백엔드는 Codex 실행 환경과 tfx hub 모델에 맞게 구성한다.

## 2) 핵심 제약
> native Claude TeamCreate/TaskCreate APIs are not available in Codex; use Hub task/message abstraction instead.

## 3) 기능 요구사항 (CR1..CR8)
- `CR1 팀 런타임 생성`: 팀 세션은 `team_id`, `trace_id`, `topic`으로 식별하고 Hub 토픽에 매핑되어야 한다.
- `CR2 작업 생성/할당`: 사용자 요청은 Hub의 task/message 추상화로 변환되어야 하며, 작업은 담당 에이전트와 완료 기준을 포함해야 한다.
- `CR3 병렬 실행`: 독립 작업은 병렬 실행 가능해야 하며, 기본 동시성 제한과 큐잉 정책을 제공해야 한다.
- `CR4 상태 전이`: 작업은 `queued -> running -> blocked -> done/failed` 상태를 가져야 하고, 전이 이벤트가 남아야 한다.
- `CR5 메시지 상관관계`: 모든 작업/메시지는 `correlation_id`와 `trace_id`를 가져야 하며, 요청-응답 추적이 가능해야 한다.
- `CR6 실패 복구`: 재시도(지수 백오프), 중복 실행 방지(idempotency), 타임아웃 후 보상 처리 규칙을 제공해야 한다.
- `CR7 운영 가시성`: 팀/작업/에이전트 단위 메트릭(지연, 실패율, 큐 길이)과 감사 로그를 조회할 수 있어야 한다.
- `CR8 호환성`: 기존 `tfx team/hub` 스키마와 라우팅 규칙을 유지하고, 점진적 전환이 가능해야 한다.

## 4) 수용 기준(요약)
- `CR1~CR8` 각각에 대해 최소 1개 이상의 통합 시나리오 테스트가 통과해야 한다.
- 기존 hub consumer 변경 없이(또는 feature flag off 시) 현행 동작이 유지되어야 한다.

## 5) CLI 표면 (초기)
- `tfx codex-team "작업"`: Codex 워커 2개(`--agents codex,codex`) 기본 주입으로 팀 시작
- `tfx codex-team status|attach|stop|kill|send|list`: 기존 `tfx team` 제어 명령을 그대로 전달
- `tfx codex-team --agents ...`: 명시한 경우 기본 주입을 덮어쓴다
