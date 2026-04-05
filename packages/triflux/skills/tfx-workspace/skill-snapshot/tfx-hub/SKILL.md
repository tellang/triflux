---
name: tfx-hub
description: tfx-hub 개방형 스킬 — 커맨드(start/stop/status) + 자유형 작업 모두 처리
triggers:
  - tfx-hub
argument-hint: "<start|stop|status|자유형 작업 설명>"
---

# tfx-hub — MCP 메시지 버스 관리 + 개방형 작업

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
Bash("codex --profile xhigh exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check '{작업}'")
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
# Codex
codex mcp add tfx-hub --url http://127.0.0.1:27888/mcp

# Gemini (settings.json)
# mcpServers.tfx-hub.url = "http://127.0.0.1:27888/mcp"

# Claude
claude mcp add --transport http tfx-hub http://127.0.0.1:27888/mcp
```

## MCP 도구 (8개)

| 도구 | 설명 |
|------|------|
| `register` | 에이전트 등록 + lease 발급 |
| `status` | 허브/에이전트/큐 상태 조회 |
| `publish` | 이벤트/응답 메시지 발행 |
| `ask` | 다른 에이전트에게 질문 (request/reply) |
| `poll_messages` | 수신함에서 메시지 폴링 |
| `handoff` | 작업 인계 |
| `request_human_input` | 사용자 입력 요청 (CAPTCHA/승인) |
| `submit_human_input` | 사용자 입력 응답 |

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
├── server.mjs    # MCP 서버 + REST 브릿지 엔드포인트
├── store.mjs     # SQLite WAL 상태 저장소
├── router.mjs    # Actor mailbox 라우터 + QoS
├── tools.mjs     # MCP 도구 8개 정의
├── hitl.mjs      # Human-in-the-Loop 매니저
├── bridge.mjs    # tfx-route.sh ↔ hub 브릿지 CLI
└── schema.sql    # DB 스키마
```

## 상태

**dev 전용** — 로컬 테스트 목적. 프로덕션 배포 전 안정화 필요.
