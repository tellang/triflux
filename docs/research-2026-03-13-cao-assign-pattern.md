# AWS CAO Assign 패턴 딥 리서치 및 triflux 통합 전략

## 1. 요약
- **AWS CAO Assign 패턴**은 에이전트 간 협업 시 상위 에이전트(Supervisor)가 하위 에이전트에게 작업을 비동기로 위임하고 즉시 다음 단계로 넘어가는 병렬 처리 모델임.
- **핵심 메커니즘**은 비동기 작업 생성(Assign)과 결과 보고(Callback via Inbox)이며, CAO는 이를 tmux 상태 감지 및 SQLite 기반 메시지 수신함으로 구현함.
- **triflux 적용 방향**은 이미 구축된 Named Pipe 실시간 버스를 활용하여 `Assign Job` 레이어를 추가함으로써, CAO 수준의 병렬성을 확보하면서도 실시간 전송 우위를 유지하는 것임.

## 2. CAO 코드 분석
AWS CLI Agent Orchestrator(CAO)의 주요 통신 및 격리 메커니즘은 다음과 같음.

| 구분 | 상세 구현 내용 |
| :--- | :--- |
| **통신 패턴** | **Handoff**(동기/대기), **Assign**(비동기/즉시 반환), **Send**(인박스 메시지 전달) |
| **MCP 통신** | CLI ↔ MCP(Stdio), MCP ↔ CAO Core(HTTP/9889) 이중 구조 |
| **에이전트 격리** | `tmux` 세션(cao-) 내 윈도우 단위 분리. `pipe-pane`을 통한 로그 캡처 및 I/O 제어 |
| **상태 관리** | SQLite(`cli-agent-orchestrator.db`)를 사용하여 `terminals`, `inbox`, `flows` 관리 |

## 3. Assign(비동기) 상세 메커니즘
CAO의 비동기 실행은 단순한 백그라운드 실행을 넘어선 상태 보장 모델을 따름.

- **비동기 전이**: Supervisor가 `assign()` 호출 시 워커 터미널을 생성하고 입력 전송 후 즉시 `terminal_id`를 반환받아 다음 로직 실행.
- **콜백(Callback)**: 워커 에이전트는 작업 완료 시 `send_message(receiver_id=supervisor_id)`를 호출하여 인박스에 결과 기록.
- **메시지 전달(Inbox)**: `inbox_service`가 워커의 상태를 모니터링하다가 IDLE(tmux 로그 패턴 감지) 상태가 되면 대기 중인 콜백 메시지를 Supervisor에게 전달.
- **실패 감지**: 입력 전송 실패 시 `FAILED` 상태로 즉시 업데이트되나, 자동 재시도(Retry)는 CAO 코어 레벨에서 지원하지 않음.

## 4. triflux 갭 분석 및 통합 가능성
현재의 triflux와 CAO의 구조적 차이를 분석하여 통합 가능성을 타진함.

### 현재 상태 비교
| 기능 | AWS CAO | triflux (현재) | 비고 |
| :--- | :--- | :--- | :--- |
| **전송 계층** | HTTP Polling / tmux pipe | **Named Pipe (NDJSON) 실시간 버스** | triflux 우위 |
| **비동기 위임** | Assign (1급 개념) | run_in_background (관례적) | CAO 우위 |
| **상태 전이** | PollingObserver | **Event-driven (EventEmitter)** | triflux 우위 |
| **격리 방식** | tmux 윈도우 전제 | psmux / wt / In-process 혼합 | triflux 유연함 |

### 통합 전략: "Assign Job Layer"
- **통합 가능성**: CAO의 `assign` 세만틱을 triflux의 `router` 큐와 `trace_id` 체계에 결합 가능.
- **차별화**: CAO의 tmux 로그 기반 IDLE 감지 대신, triflux의 실시간 pipe-ack 메커니즘을 활용하여 더 낮은 지연시간(Latency)으로 콜백 구현.

## 5. 정량 이점
공식 벤치마크 데이터는 부재하나, 시나리오 기반 분석 시 다음과 같은 성능 향상 기대.

- **병렬 처리 효율**: 순차 실행(93s) 대비 병렬 Assign 패턴(33s) 사용 시 **약 64.5% 시간 단축 (2.8배 속도 향상)**.
- **전송 지연**: Named Pipe 사용 시 CAO의 HTTP 브릿지 대비 메시지 배달 지연(avg_delivery_ms)을 **5ms 미만**으로 유지 가능.

## 6. triflux 구체 변경안 (6개 파일)
`assign_jobs` 테이블과 비동기 제어 API를 추가함.

1.  **`hub/schema.sql`**: `assign_jobs` 테이블 추가 (job_id, supervisor_id, worker_id, status, result_json 등).
2.  **`hub/store.mjs`**: `createAssignJob()`, `updateJobStatus()`, `getJobResult()` 메서드 구현.
3.  **`hub/router.mjs`**: `handleAssignAsync()`, `reportJobResult()` 핸들러 및 비동기 응답 라우팅 로직 추가.
4.  **`hub/tools.mjs`**: `assign_async`, `assign_status` MCP 도구 정의 추가.
5.  **`hub/server.mjs`**: `/bridge/assign/result` 등 외부 콜백 수신 엔드포인트 노출.
6.  **`hub/pipe.mjs`**: Named Pipe 명령셋에 `assign`, `result` 액션 매핑.

## 7. 외부 소스
- [AWS Open Source Blog: Introducing CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator)
- [GitHub: awslabs/cli-agent-orchestrator (CODEBASE.md)](https://github.com/awslabs/cli-agent-orchestrator/blob/main/CODEBASE.md)
- [GitHub: awslabs/cli-agent-orchestrator (codex-cli.md)](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/codex-cli.md)
