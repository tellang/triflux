---
name: tfx-hub
description: >
  tfx-hub MCP 메시지 버스 관리. CLI 에이전트 간 실시간 통신 허브를 시작/중지/상태확인하고,
  hub 도메인의 자유형 작업도 처리합니다.
  Use when: hub, 허브, 메시지 버스, message bus, 브릿지, bridge, MCP 서버 관리, 에이전트 통신
triggers:
  - tfx-hub
argument-hint: "<start|stop|status|자유형 작업 설명>"
---

# tfx-hub — MCP 메시지 버스 관리 + 개방형 작업

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> **인프라**: 다른 스킬이 내부적으로 사용. 직접 호출할 필요 없음.
> CLI 에이전트(Codex/Gemini/Claude) 간 실시간 메시지 허브를 관리합니다.
> **커맨드 매칭 + fallthrough**: start/stop/status에 매칭되면 즉시 실행,
> 매칭 안 되면 **hub 도메인 컨텍스트를 활용한 범용 작업**으로 처리합니다.

## 입력 해석 규칙

```
/tfx-hub start          → 커맨드 매칭 → 허브 시작
/tfx-hub stop           → 커맨드 매칭 → 허브 중지
/tfx-hub status         → 커맨드 매칭 → 상태 확인
/tfx-hub 테스트해줘      → fallthrough → hub 관련 범용 작업으로 처리
/tfx-hub 문서 저장해     → fallthrough → hub 관련 범용 작업으로 처리
/tfx-hub 브릿지 분석해   → fallthrough → hub 관련 범용 작업으로 처리
```

**fallthrough 규칙**: 인자가 start/stop/status/--port 등 커맨드 키워드에 매칭되지 않으면,
사용자의 입력을 **hub/브릿지/메시지버스 도메인의 자유형 작업**으로 해석한다.

fallthrough 라우팅:
```bash
# tfx-route.sh 경유 (권장)
Bash("bash ~/.claude/scripts/tfx-route.sh {에이전트} '{hub 컨텍스트 + 작업}' {mcp_profile}")

# codex 직접 호출 시 — 반드시 exec 서브커맨드 포함
Bash("codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check '{작업}'")
Bash("codex --profile gpt54_xhigh exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check '{작업}'")
#          ↑ --profile은 exec 앞에, --skip-git-repo-check은 exec 뒤에

# Claude 네이티브 (탐색/검증)
Agent(subagent_type="oh-my-claudecode:explore", prompt="{작업}")
```

## 커맨드

### start — 허브 시작

```bash
Bash("node hub/server.mjs", run_in_background=true)
```

- Streamable HTTP MCP 서버를 `http://127.0.0.1:27888/mcp` 에서 시작
- SQLite WAL DB: `~/.claude/cache/tfx-hub/state.db`
- PID 파일: `~/.claude/cache/tfx-hub/hub.pid`
- 환경변수: `TFX_HUB_PORT` (포트), `TFX_HUB_DB` (DB 경로)

### stop — 허브 중지

```bash
# PID 파일에서 프로세스 ID 읽어서 종료
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

### status — 상태 확인

```bash
# HTTP 상태 엔드포인트 조회
Bash("curl -s http://127.0.0.1:27888/status 2>/dev/null || echo '{\"error\":\"hub 미실행\"}'")
```

## 각 CLI 등록 방법

허브 시작 후 각 CLI에 MCP 서버로 등록:

```bash
# Codex (수동 opt-in 예시)
# triflux는 config.json을 자동 관리하며, standalone Codex 노이즈 방지를 위해
# 사전 등록은 disabled로 두고 `tfx hub start` 이후에만 enabled로 전환한다.
codex mcp add tfx-hub --url http://127.0.0.1:27888/mcp

# Gemini (settings.json)
# mcpServers.tfx-hub.url = "http://127.0.0.1:27888/mcp"

# Claude
claude mcp add --transport http tfx-hub http://127.0.0.1:27888/mcp
```

## MCP 도구 (20개)

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

## 브릿지 REST 엔드포인트 (4개)

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /bridge/register` | 에이전트 등록 (프로세스 수명 기반 lease) |
| `POST /bridge/result` | 결과 발행 (topic fanout) |
| `POST /bridge/context` | 선행 컨텍스트 폴링 (auto_ack) |
| `POST /bridge/deregister` | 에이전트 offline 마킹 |

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
├── paths.mjs             # 경로 상수 (PID 파일, DB 경로 등)
├── pipe.mjs              # Named Pipe 서버 (push 구독 채널)
├── assign-callbacks.mjs  # assign job 콜백 처리
├── intent.mjs            # 인텐트 파싱
├── reflexion.mjs         # reflexion 루프
├── research.mjs          # 리서치 프록시
├── token-mode.mjs        # 토큰 모드 관리
├── pipeline/             # 파이프라인 엔진
│   ├── index.mjs         # createPipeline() 팩토리
│   ├── state.mjs         # 파이프라인 상태 CRUD
│   ├── transitions.mjs   # 전이 규칙
│   └── gates/            # HITL 게이트 (selfcheck, confidence)
├── delegator/            # 작업 위임 레이어
│   ├── index.mjs
│   ├── service.mjs
│   ├── contracts.mjs
│   └── tool-definitions.mjs
├── team/                 # Claude Native Teams 통합
│   ├── nativeProxy.mjs   # Teams MCP 프록시
│   ├── orchestrator.mjs  # 팀 오케스트레이터
│   ├── session.mjs       # 세션 관리
│   ├── dashboard.mjs     # TUI 대시보드
│   ├── tui.mjs           # TUI 렌더러
│   └── cli/              # tfx team CLI 커맨드
├── workers/              # CLI 워커 어댑터
│   ├── factory.mjs
│   ├── claude-worker.mjs
│   ├── codex-mcp.mjs
│   ├── gemini-worker.mjs
│   └── delegator-mcp.mjs
├── middleware/           # 요청 미들웨어
│   └── request-logger.mjs
├── quality/              # 품질 검사
│   └── deslop.mjs
└── public/               # 정적 자산 (대시보드 HTML, 트레이 아이콘)
```

## 상태

**dev 전용** — 로컬 테스트 목적. 프로덕션 배포 전 안정화 필요.
