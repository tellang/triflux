---
name: tfx-hub
description: >
  tfx-hub MCP 메시지 버스 관리. AskUserQuestion 기반 인터랙티브 UI로
  허브 시작/중지/상태확인, MCP 서버 관리, 에이전트 조회, 파이프라인 조회를 수행합니다.
  Use when: hub, 허브, 메시지 버스, message bus, 브릿지, bridge, MCP 서버 관리, 에이전트 통신
triggers:
  - tfx-hub
argument-hint: "<start|stop|status|mcp|자유형 작업 설명>"
---

# tfx-hub — MCP 메시지 버스 관리

> **ARGUMENTS 처리**: `ARGUMENTS: <값>`과 함께 호출되면 해당 값을 입력으로 사용한다.
> start/stop/status/mcp에 매칭되면 즉시 실행, 나머지는 메인 메뉴를 표시한다.

## 입력 해석 규칙

```
/tfx-hub start   → 즉시 실행: 허브 시작
/tfx-hub stop    → 즉시 실행: 허브 중지
/tfx-hub status  → 즉시 실행: 상태 확인
/tfx-hub mcp     → 즉시 실행: MCP 서버 목록
/tfx-hub         → 메인 메뉴 표시
/tfx-hub 뭔가    → fallthrough: hub 도메인 범용 작업
```

## 워크플로우

### Step 0: 허브 상태 사전 확인

메뉴 표시 전 허브 실행 상태를 먼저 확인한다:

```bash
Bash("curl -sf http://127.0.0.1:27888/status 2>/dev/null | node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(JSON.stringify({running:true, uptime_ms:d.hub.uptime_ms, sessions:d.sessions, queues:d.queues, assigns:d.assigns}))\" 2>/dev/null || echo '{\"running\":false}'")
```

결과를 `hubState` 변수로 저장한다.

### Step 1: 메인 메뉴 (AskUserQuestion)

```
question: "tfx-hub 관리 — 어떤 작업을 수행하시겠습니까?"
header: "tfx-hub {hubState.running ? '● 실행 중' : '○ 중지됨'} | 세션: {sessions} | 큐: urgent {queues.urgent_depth} / normal {queues.normal_depth} / DLQ {queues.dlq_depth}"
options:
  - label: "허브 상태 보기"
    description: "상세 상태 — 에이전트, 큐, 파이프라인, assign 현황"
  - label: "허브 시작"
    description: "MCP 서버를 :27888에서 시작"
  - label: "허브 중지"
    description: "실행 중인 허브 프로세스 종료"
  - label: "MCP 서버 관리"
    description: "등록된 MCP 서버 목록 조회, 추가, 제거"
  - label: "파이프라인 조회"
    description: "활성 파이프라인 목록 + 상태"
  - label: "Assign 작업 조회"
    description: "비동기 작업 목록 + 상태"
  - label: "DLQ 관리"
    description: "Dead Letter Queue 조회 + 재시도/삭제"
```

허브가 중지됨 상태라면 "허브 시작" 외 항목 선택 시 "허브가 실행 중이 아닙니다. 먼저 시작하시겠습니까?" 확인을 표시한다.

### Step 2: 선택에 따른 분기

#### "허브 상태 보기"

```bash
Bash("curl -s http://127.0.0.1:27888/status 2>/dev/null || echo '{\"error\":\"hub 미실행\"}'")
```

결과를 파싱하여 표시:

```markdown
## Hub Status

| 항목 | 값 |
|------|-----|
| 상태 | ● healthy |
| Uptime | 22m 3s |
| PID | 24504 |
| 포트 | 27888 |
| 인증 | localhost-only |
| 세션 | 0 |

### 큐
| urgent | normal | DLQ |
|--------|--------|-----|
| 0      | 0      | 10  |

### Assign
| queued | running | failed | timed_out |
|--------|---------|--------|-----------|
| 0      | 0       | 0      | 1         |
```

표시 후 메인 메뉴로 돌아갈지 AskUserQuestion:
```
question: "추가 작업이 있으십니까?"
options:
  - label: "메인 메뉴로"
  - label: "종료"
```

#### "허브 시작"

```bash
Bash("node hub/server.mjs", run_in_background=true)
```

시작 후 2초 대기하여 상태 확인:
```bash
Bash("sleep 2 && curl -sf http://127.0.0.1:27888/status >/dev/null 2>&1 && echo 'OK' || echo 'FAIL'")
```

- OK → "허브가 시작되었습니다. http://127.0.0.1:27888"
- FAIL → "허브 시작에 실패했습니다. `node hub/server.mjs`를 직접 실행해 보세요."

#### "허브 중지"

```bash
Bash("node -e \"
  const fs = require('fs');
  const path = require('path');
  const pidFile = path.join(require('os').homedir(), '.claude/cache/tfx-hub/hub.pid');
  if (fs.existsSync(pidFile)) {
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    process.kill(info.pid, 'SIGTERM');
    console.log('tfx-hub 종료 (PID ' + info.pid + ')');
  } else {
    console.log('tfx-hub 미실행');
  }
\"")
```

#### "MCP 서버 관리"

먼저 현재 등록된 MCP 서버 목록을 수집:

```bash
Bash("claude mcp list 2>/dev/null")
```

결과를 파싱하여 테이블로 표시:

```markdown
## 등록된 MCP 서버

| # | 이름 | 상태 | 명령어 |
|---|------|------|--------|
| 1 | context7 | ✓ Connected | cmd /c npx -y @upstash/context7-mcp@latest |
| 2 | exa | ✓ Connected | cmd /c npx -y exa-mcp-server |
| 3 | powerpoint | ✓ Connected | uvx ppt-mcp |
| ... | ... | ... | ... |
```

그 후 AskUserQuestion:
```
question: "MCP 서버 관리 — 어떤 작업을 하시겠습니까?"
header: "MCP Servers ({connected}개 연결 / {failed}개 실패 / {disabled}개 비활성)"
options:
  - label: "서버 제거"
    description: "등록된 서버를 선택하여 제거"
  - label: "서버 추가"
    description: "새 MCP 서버 등록"
  - label: "실패한 서버 재시작"
    description: "연결 실패 서버를 재시작 시도"
  - label: "뒤로"
    description: "메인 메뉴로 돌아가기"
```

##### "서버 제거" 선택 시

AskUserQuestion (multiSelect):
```
question: "제거할 서버를 선택하세요"
header: "MCP 서버 제거"
options:
  (등록된 서버를 각각 옵션으로 나열)
  - label: "powerpoint"
    description: "[local] uvx ppt-mcp — ✓ Connected"
  - label: "stability-ai"
    description: "[local] npx -y mcp-server-stability-ai — ✘ Failed"
  ...
multiSelect: true
```

선택된 서버들을 제거:
```bash
Bash("claude mcp remove '{서버명}' -s {scope}")
```

제거 후 결과 표시.

##### "서버 추가" 선택 시

AskUserQuestion:
```
question: "추가할 서버 유형을 선택하세요"
header: "MCP 서버 추가"
options:
  - label: "stdio (npx/uvx)"
    description: "npx, uvx 등 stdio 기반 서버"
  - label: "SSE/HTTP"
    description: "URL 기반 원격 서버"
```

stdio 선택 시 AskUserQuestion:
```
question: "서버 이름과 명령어를 입력하세요 (예: myserver -- cmd /c npx -y my-mcp-server)"
header: "stdio 서버 추가"
```

입력값을 파싱하여:
```bash
Bash("claude mcp add '{name}' -s local -- {command}")
```

SSE/HTTP 선택 시 AskUserQuestion:
```
question: "서버 이름과 URL을 입력하세요 (예: myserver http://localhost:8080/mcp)"
header: "HTTP 서버 추가"
```

입력값을 파싱하여:
```bash
Bash("claude mcp add --transport http '{name}' '{url}' -s local")
```

##### "실패한 서버 재시작" 선택 시

`claude mcp list` 결과에서 Failed 서버만 필터:

```
question: "재시작할 서버를 선택하세요"
header: "실패한 MCP 서버"
options:
  (Failed 서버만 나열)
multiSelect: true
```

선택된 서버를 제거 후 재등록하여 재시작.

#### "파이프라인 조회"

```bash
Bash("curl -s http://127.0.0.1:27888/bridge/pipeline/list -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo '{\"error\":\"hub 미실행\"}'")
```

결과를 테이블로 표시.

#### "Assign 작업 조회"

```bash
Bash("curl -s http://127.0.0.1:27888/bridge/assign/status -X POST -H 'Content-Type: application/json' -d '{\"list\":true}' 2>/dev/null || echo '{\"error\":\"hub 미실행\"}'")
```

결과를 테이블로 표시. 실패 작업이 있으면 재시도 옵션 제공.

#### "DLQ 관리"

```bash
Bash("curl -s http://127.0.0.1:27888/status 2>/dev/null | node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('DLQ depth: '+d.queues.dlq_depth)\"")
```

DLQ가 비어있으면 "DLQ가 비어있습니다." 표시.
내용이 있으면 AskUserQuestion:
```
question: "DLQ 처리 — 어떻게 하시겠습니까?"
header: "Dead Letter Queue ({count}건)"
options:
  - label: "전체 조회"
    description: "DLQ 메시지 목록 표시"
  - label: "전체 재시도"
    description: "모든 DLQ 메시지를 다시 큐에 넣기"
  - label: "전체 삭제"
    description: "DLQ 비우기"
  - label: "뒤로"
```

## fallthrough 라우팅

메인 메뉴 항목에 매칭되지 않는 자유형 입력은 hub 도메인 컨텍스트 범용 작업으로 처리:

```bash
# tfx-route.sh 경유 (권장)
Bash("bash ~/.claude/scripts/tfx-route.sh {에이전트} '{hub 컨텍스트 + 작업}' {mcp_profile}")

# Claude 네이티브 (탐색/검증)
Agent(subagent_type="oh-my-claudecode:explore", prompt="{작업}")
```

## CLI 등록 방법

허브 시작 후 각 CLI에 MCP 서버로 등록:

```bash
# Claude
claude mcp add --transport http tfx-hub http://127.0.0.1:27888/mcp

# Codex
codex mcp add tfx-hub --url http://127.0.0.1:27888/mcp

# Gemini (settings.json)
# mcpServers.tfx-hub.url = "http://127.0.0.1:27888/mcp"
```

## MCP 도구 레퍼런스 (20개)

### Core — 기본 통신

| 도구 | 설명 |
|------|------|
| `register` | 에이전트 등록 + lease 발급 |
| `status` | 허브/에이전트/큐/트레이스 상태 조회 |
| `publish` | 이벤트/응답 메시지 발행 (topic fanout 지원) |
| `ask` | 다른 에이전트에게 질문 (request/reply, await_response_ms 폴링 지원) |
| `handoff` | 작업 인계 (acceptance_criteria 지정 가능) |
| `poll_messages` | 수신함에서 메시지 폴링 **(Deprecated — Named Pipe 사용)** |

### Assign — 비차단 작업 할당

| 도구 | 설명 |
|------|------|
| `assign_async` | AWS CAO 스타일 비차단 job 생성 + 워커 실시간 전달 |
| `assign_result` | job 진행/완료 결과 보고 |
| `assign_status` | job 단건 상태 또는 목록 조회 |

### Team — Claude Native Teams 프록시

| 도구 | 설명 |
|------|------|
| `team_info` | Teams 메타/멤버/경로 정보 조회 |
| `team_task_list` | task 목록 조회 (owner/status 필터) |
| `team_task_update` | task claim/update |
| `team_send_message` | Teams inbox에 메시지 append |

### Pipeline — 파이프라인 관리

| 도구 | 설명 |
|------|------|
| `pipeline_init` | 새 파이프라인 초기화 |
| `pipeline_state` | 파이프라인 상태 조회 |
| `pipeline_advance` | 다음 단계로 전이 (전이 규칙 + fix loop 바운딩) |
| `pipeline_advance_gated` | HITL 승인 게이트 포함 전이 |
| `pipeline_list` | 활성 파이프라인 목록 조회 |

### HITL — Human-in-the-Loop

| 도구 | 설명 |
|------|------|
| `request_human_input` | 사용자 입력 요청 (CAPTCHA/승인/자격증명/선택/텍스트) |
| `submit_human_input` | 사용자 입력 응답 (accept/decline/cancel) |

## CLI 대응

| 스킬 UI | CLI 명령 |
|---------|---------|
| 허브 상태 보기 | `curl http://127.0.0.1:27888/status` |
| 허브 시작 | `node hub/server.mjs` |
| 허브 중지 | PID 파일에서 kill |
| MCP 서버 목록 | `claude mcp list` |
| MCP 서버 추가 | `claude mcp add ...` |
| MCP 서버 제거 | `claude mcp remove ...` |

## 에러 처리

| 상황 | 처리 |
|------|------|
| 허브 미실행 상태에서 조회 | "허브가 실행 중이 아닙니다. 시작하시겠습니까?" AskUserQuestion |
| curl 타임아웃 | "허브가 응답하지 않습니다. PID 파일을 확인하세요." |
| MCP 서버 추가 실패 | 에러 메시지 표시 + "다시 시도" 옵션 |
| PID 파일 없음 | "허브가 실행 중이 아닙니다." |

## 프로젝트 구조

```
hub/
├── server.mjs            # MCP 서버 + REST 브릿지 엔드포인트
├── store.mjs             # SQLite WAL 상태 저장소
├── router.mjs            # Actor mailbox 라우터 + QoS
├── tools.mjs             # MCP 도구 20개 정의
├── hitl.mjs              # Human-in-the-Loop 매니저
├── bridge.mjs            # tfx-route.sh ↔ hub 브릿지 CLI
├── schema.sql            # DB 스키마
├── paths.mjs             # 경로 상수
├── pipe.mjs              # Named Pipe 서버
├── assign-callbacks.mjs  # assign job 콜백
├── pipeline/             # 파이프라인 엔진
├── delegator/            # 작업 위임 레이어
├── team/                 # Claude Native Teams 통합
├── workers/              # CLI 워커 어댑터
├── middleware/            # 요청 미들웨어
├── quality/              # 품질 검사
└── public/               # 정적 자산
```

## 상태

**dev 전용** — 로컬 테스트 목적. 프로덕션 배포 전 안정화 필요.
