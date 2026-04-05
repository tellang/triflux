# Agent 래퍼 상세 규칙

## 슬림 래퍼의 존재 이유

Native Teams의 teammate는 Claude 모델만 가능하다.
Codex/Gemini는 teammate로 직접 등록할 수 없으므로, Claude slim wrapper를 spawn하고
래퍼 내부에서 `tfx-route.sh`로 Codex/Gemini CLI를 실행하는 구조이다.

래퍼가 존재하는 이유:
1. **Shift+Down 네비게이션 등록** — 래퍼 없이 Lead가 직접 Bash를 실행하면 네비게이션에 등록되지 않음
2. **리드↔워커 피드백 루프** — 워커가 결과를 보고하면 턴 경계가 생겨 리드가 방향을 수정할 수 있음
3. **실패 시 재실행** — N회 실행을 지원

## 필수 규칙

### 1. Agent 래퍼 생략 금지

Codex/Gemini 서브태스크는 워커 수에 관계없이 반드시 Agent 래퍼를 spawn해야 한다.
단일 워커(1:gemini 등)여도 Lead가 직접 Bash를 실행하면 안 된다.
Lead가 "효율적"이라고 판단해서 Agent를 건너뛰는 것은 금지한다.

### 2. mode: bypassPermissions 필수

모든 Agent spawn에 반드시 `mode: "bypassPermissions"`를 포함한다.
이 설정이 없으면 워커가 Bash 실행 시 사용자 승인을 요청하여 자동 실행이 중단된다.

### 3. tfx-route.sh 경유 필수

Lead 또는 Agent 래퍼가 `gemini -y -p "..."` 또는 `codex exec "..."`를 직접 호출하면 안 된다.
직접 호출하면 다음이 누락된다:
- tfx-route.sh의 모델 지정(`-m gemini-3.1-pro-preview`)
- MCP 필터
- 팀 bridge 연동
- Windows 호환 경로
- 타임아웃
- 후처리(토큰 추적/이슈 로깅)

반드시 `bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' {mcp_profile}`을 통해 실행해야 한다.

### 4. 코드 직접 조작 금지

슬림 래퍼 워커가 코드를 직접 읽거나 수정하면 안 된다.
codex-worker는 반드시 tfx-route.sh를 통해 Codex에 위임하고, gemini-worker도 마찬가지다.
워커가 Read, Edit, Write, Grep, Glob 등 도구를 직접 사용하는 것은 위임 구조 위반이다.

## 인터럽트 프로토콜

워커가 Bash 실행 전에 SendMessage로 시작을 보고하면 턴 경계가 생겨 리드가 방향 전환 메시지를 보낼 수 있다.

```
1. TaskUpdate(taskId, status: in_progress) — task claim
2. SendMessage(to: team-lead, "작업 시작: {agentName}") — 시작 보고 (턴 경계 생성)
3. Bash(command: tfx-route.sh ..., timeout: {bashTimeoutMs}) — 실행
4. SendMessage(to: team-lead, "결과: {요약}") — 결과 보고 (턴 경계 생성)
5. 리드 피드백 대기 — 피드백 수신 시 Step 3으로 돌아가 재실행
6. 최종 완료 시 TaskUpdate(status: completed, metadata: {result}) + SendMessage → 종료
```

리드는 워커의 Step 2, Step 4 시점에 턴 경계를 인식하고, 방향 전환/추가 지시/재실행 요청을 보낼 수 있다.

## Async 실행 프로토콜 (v2.5+)

Claude Code Bash 도구는 최대 600초(10분) 하드코딩 제한이 있다.
scientist(24분), scientist-deep(60분) 등 장시간 워커는 이 제한에 걸린다.

**해결: `--async` 3단계 패턴**

| 단계 | 명령 | Bash timeout | 소요 |
|------|------|-------------|------|
| 시작 | `tfx-route.sh --async {role} '{task}' {profile} {timeout}` | 15초 | <1초 |
| 대기 | `tfx-route.sh --job-wait {job_id} 540` | 570초 | 최대 540초/회 |
| 결과 | `tfx-route.sh --job-result {job_id}` | 30초 | <1초 |

- `--job-wait`는 내부에서 15초 간격으로 폴링하며 `done`/`timeout`/`failed`/`still_running` 반환
- `still_running` 시 같은 `--job-wait` 명령을 반복 (무한 반복 가능)
- 실제 워커 timeout은 tfx-route.sh의 `timeout` 명령으로 관리 (Bash 도구와 무관)

**이전 방식 (deprecated):**
Bash timeout을 role/profile별 timeout + 60초로 설정했으나, 600초 초과 시 Bash 도구가 강제 종료했다.

## tfx-route.sh 팀 통합 동작

`TFX_TEAM_*` 환경변수 기반 (이미 구현됨):
- `TFX_TEAM_NAME`: 팀 식별자
- `TFX_TEAM_TASK_ID`: 작업 식별자
- `TFX_TEAM_AGENT_NAME`: 워커 표기 이름
- `TFX_TEAM_LEAD_NAME`: 리드 수신자 이름 (기본 `team-lead`)

Hub 통신 (Named Pipe 우선, HTTP fallback):
- `bridge.mjs`가 Named Pipe(`\\.\pipe\triflux-{pid}`) 우선 연결, 실패 시 HTTP `/bridge/*` fallback
- 실행 시작: `node hub/bridge.mjs team-task-update --team {name} --task-id {id} --claim --status in_progress`
- 실행 종료: `node hub/bridge.mjs team-task-update --team {name} --task-id {id} --status completed|failed`
- 리드 보고: `node hub/bridge.mjs team-send-message --team {name} --from {agent} --to team-lead --text "..."`
- 결과 발행: `node hub/bridge.mjs result --agent {id} --topic task.result --file {output}`
