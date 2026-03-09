# tfx-hub — MCP 메시지 버스 관리

> CLI 에이전트(Codex/Gemini/Claude) 간 실시간 메시지 허브를 관리합니다.
> **tfx-auto와 완전 독립** — 별도 스킬로 운영됩니다.

## 사용법

```
/tfx-hub start               ← 허브 데몬 시작 (기본 포트 27888)
/tfx-hub start --port 28000  ← 커스텀 포트
/tfx-hub stop                ← 허브 중지
/tfx-hub status              ← 상태/메트릭 확인
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

## 상태

**dev 전용** — 로컬 테스트 목적. 프로덕션 배포 전 안정화 필요.
