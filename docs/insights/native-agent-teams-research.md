# Claude Code Native Agent Teams Research

본 문서는 Claude Code의 실험적 기능인 **Native Agent Teams**에 대한 역공학 및 분석 결과를 담고 있습니다.
`triflux` 프로젝트에서 이 기능을 활용하거나 Hub MCP와 연동하기 위한 기술적 기초를 제공합니다.

---

## 1. 활성화 및 환경 설정

### 1.1 필수 조건

| 조건 | 설명 | 제어 가능 |
|------|------|-----------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | settings.json env 또는 환경변수 | ✓ |
| `tengu_amber_flint` growthbook gate | Anthropic 서버 측 피처 플래그 | ✗ |

두 조건이 **모두 true**여야 TeamCreate/SendMessage 등 도구가 등록됨.

활성화 함수 (`P7()`):
```
P7() = CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS truthy
     AND tengu_amber_flint gate == true
```

### 1.2 teammateMode 설정

`settings.json` 최상위 키 또는 CLI `--teammate-mode` 플래그:

| 값 | 동작 |
|----|------|
| `auto` (기본) | tmux 안이면 split-pane, 밖이면 in-process |
| `in-process` | 같은 터미널, Shift+Down으로 전환 |
| `tmux` | tmux/iTerm2 split-pane |

non-interactive 환경에서는 강제 in-process.

### 1.3 settings.json 예시

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "teammateMode": "auto"
}
```

---

## 2. API 스키마 (리버스 엔지니어링)

소스: `@anthropic-ai/claude-code/cli.js` (번들)

### 2.1 TeamCreate

```json
{
  "team_name": "string (필수)",
  "description": "string (선택) — 팀 목적",
  "agent_type": "string (선택) — 리드 역할"
}
```

**생성물:**
- `~/.claude/teams/{team-name}/config.json`
- `~/.claude/tasks/{team-name}/` (작업 디렉토리)

**반환:**
```json
{
  "data": {
    "team_name": "tfx-test",
    "team_file_path": "~/.claude/teams/tfx-test/config.json",
    "lead_agent_id": "team-lead@tfx-test"
  }
}
```

**제약:**
- 한 번에 하나의 팀만 리드 가능
- 이미 팀 리더인 경우 Error 발생
- members 배열에 lead만 포함 (teammate는 Agent 도구로 별도 추가)

### 2.2 TaskCreate

```json
{
  "subject": "string (필수) — 작업 제목",
  "description": "string (필수) — 상세 설명",
  "activeForm": "string (선택) — in_progress 시 스피너 텍스트",
  "metadata": "Record<string, unknown> (선택)"
}
```

**반환:** `Task #{id} created successfully: {subject}`

### 2.3 TaskGet

```json
{
  "taskId": "string (필수)"
}
```

**반환:**
```json
{
  "data": {
    "task": {
      "id": "1",
      "subject": "작업 제목",
      "description": "상세 설명",
      "status": "pending | in_progress | completed",
      "blocks": ["2"],
      "blockedBy": []
    }
  }
}
```

### 2.4 TaskList

```json
{}
```
파라미터 없음. 현재 팀 컨텍스트에서 자동 감지.

**반환:**
```json
{
  "data": {
    "tasks": [
      {
        "id": "1",
        "subject": "작업 제목",
        "status": "in_progress",
        "owner": "codex-worker-1",
        "blockedBy": []
      }
    ]
  }
}
```

### 2.5 TaskUpdate

```json
{
  "taskId": "string (필수)",
  "subject": "string (선택)",
  "description": "string (선택)",
  "activeForm": "string (선택)",
  "status": "pending | in_progress | completed | deleted (선택)",
  "addBlocks": "string[] (선택)",
  "addBlockedBy": "string[] (선택)",
  "owner": "string (선택)",
  "metadata": "Record<string, unknown> (선택)"
}
```

**특수 동작:**
- `status: "deleted"` → 영구 삭제
- `status: "in_progress"` + `owner` 미지정 → 팀 모드에서 자동으로 현재 에이전트 이름 할당
- `status: "completed"` → 완료 검증 로직 실행 (블로킹 에러 확인)

### 2.6 SendMessage

| 타입 | 필수 파라미터 | 용도 |
|------|-------------|------|
| `message` | recipient, content, summary | 1:1 DM |
| `broadcast` | content, summary | 전체 공지 (비용 주의) |
| `shutdown_request` | recipient, content | 종료 요청 |
| `shutdown_response` | request_id, approve | 종료 승인/거부 |
| `plan_approval_response` | request_id, recipient, approve | 계획 승인/거부 |

**message 예시:**
```json
{
  "type": "message",
  "recipient": "codex-worker-1",
  "content": "작업 상태를 보고하라.",
  "summary": "작업 상태 확인 요청"
}
```

### 2.7 TeamDelete

```json
{}
```
파라미터 없음. 세션 컨텍스트에서 자동 감지.

**제약:** 활성 멤버가 있으면 실패 → shutdown_request 먼저 보내야 함.

---

## 3. Teammate 생성 메커니즘

### 3.1 핵심 발견

**TeamCreate는 teammate를 생성하지 않는다.**
teammate는 **Agent 도구**에 `team_name` + `name` 파라미터를 전달하여 생성한다.

```
Agent({
  name: "codex-worker-1",
  team_name: "tfx-test",
  description: "codex-worker-1",
  prompt: "너는 Codex 워커이다. ...",
  run_in_background: true
})
```

### 3.2 내부 동작 (소스 분석)

1. Agent 도구에 `name` + `team_name`이 있으면 teammate spawn 분기
2. 모드에 따라:
   - `in-process` → 같은 프로세스에서 실행 (Shift+Down 전환)
   - `split-pane` → tmux/iTerm2 새 pane에서 별도 프로세스
3. 숨겨진 CLI 인자 전달:
   ```
   --agent-id --agent-name --team-name --agent-color
   --parent-session-id [--agent-type] [--plan-mode-required]
   ```
4. config.json `members` 배열에 자동 등록

### 3.3 config.json 멤버 구조

```json
{
  "agentId": "codex-worker-1@tfx-test",
  "name": "codex-worker-1",
  "model": "claude-opus-4-6",
  "prompt": "너는 Codex 워커이다...",
  "color": "blue",
  "planModeRequired": false,
  "joinedAt": 1773056246180,
  "tmuxPaneId": "in-process",
  "cwd": "/path/to/project",
  "subscriptions": [],
  "backendType": "in-process"
}
```

### 3.4 제약사항

- teammate는 또 다른 팀을 생성할 수 없음 (리드만 가능)
- in-process teammate는 `/resume` 미지원
- 팀당 1세션, 중첩 팀 불가
- split-pane은 tmux/iTerm2 필요 (Windows Terminal, VS Code 미지원)
- **teammate 모델 변경 불가** → 항상 리드와 동일 모델 (Opus)

---

## 4. 표준 워크플로우

```
1. TeamCreate({team_name, description})
     ↓
2. TaskCreate × N (공유 작업 목록)
     ↓
3. Agent({team_name, name, prompt, run_in_background}) × N
     ↓
4. Teammates: TaskList → TaskUpdate(claim) → 작업 → TaskUpdate(completed)
     ↓
5. Lead: SendMessage 자동 수신 (폴링 불필요)
     ↓
6. SendMessage(shutdown_request) → teammate가 shutdown_response(approve)
     ↓
7. TeamDelete()
```

**통신 규칙:**
- 텍스트 출력은 다른 에이전트에게 보이지 않음 → **반드시 SendMessage 사용**
- 메시지는 자동 배달 (폴링 불필요)
- idle 상태는 정상 — SendMessage로 깨울 수 있음
- teammate 이름으로 참조 (UUID 아닌 name 사용)

---

## 5. 파일 시스템 구조

```
~/.claude/
├── teams/
│   └── {team-name}/
│       ├── config.json          # 팀 메타 + members 배열
│       └── inboxes/
│           └── {agent}.json     # 수신함 (메시지 배열)
├── tasks/
│   └── {team-name}/             # 또는 {leadSessionId}/
│       ├── 1.json               # Task #1
│       ├── 2.json               # Task #2
│       └── .highwatermark       # 내부 관리 파일
└── settings.json                # teammateMode, env 설정
```

**경로 해석 주의:**
- tasks 디렉토리는 `team-name` 또는 `leadSessionId` 기반
- 환경에 따라 달라질 수 있음 → 다중 후보 경로 탐색 필요

---

## 6. triflux v2 → v2.1 진화

### 6.1 v2 문제점 (Claude Wrapper)

```
Claude Opus teammate ($$$)
  → Bash(tfx-route.sh)
    → Codex/Gemini (무료)
```

- Opus 토큰을 "Bash 실행 + 결과 보고" 래퍼에 낭비
- teammate 모델을 Haiku로 변경 불가 (Native Teams 제한)
- shutdown_request에 자동 응답하지 않는 경우 수동 개입 필요

### 6.2 v2.1 설계 (Hub MCP Proxy)

```
Claude lead (오케스트레이터만)
  → TeamCreate + TaskCreate
  → Bash(tfx-route.sh) 직행 (Claude wrapper 없음)
    → tfx-route.sh가 Hub MCP를 통해:
      - team_task_update(claim)
      - Codex/Gemini 실행
      - team_task_update(completed)
      - team_send_message(to: team-lead)
```

**Hub MCP 확장 도구 4개:**

| 도구 | 용도 | 프록시 대상 |
|------|------|-----------|
| `team_info` | 팀 메타/멤버 조회 | config.json |
| `team_task_list` | 작업 목록 | tasks/{team}/*.json |
| `team_task_update` | 작업 claim/complete | task JSON 수정 |
| `team_send_message` | 리드에게 메시지 | inboxes/{agent}.json |

**tfx-route.sh 환경변수:**
- `TFX_TEAM_NAME` — 팀 이름
- `TFX_TEAM_TASK_ID` — 대상 task ID
- `TFX_TEAM_AGENT_NAME` — 에이전트 이름 (예: codex-worker-1)
- `TFX_TEAM_LEAD_NAME` — 리드 이름 (기본: team-lead)

**PRD:** `.omc/plans/tfx-team-v2.1-prd.md`

---

## 7. 실전 테스트 결과

### 7.1 성공 항목

| 단계 | 도구 | 결과 |
|------|------|------|
| 팀 생성 | TeamCreate | ✓ tfx-test-hello |
| 작업 등록 | TaskCreate | ✓ #1 hello 테스트 |
| teammate 스폰 | Agent(team_name, name) | ✓ codex-worker-1 (in-process) |
| 작업 claim | TaskUpdate (워커) | ✓ in_progress |
| 작업 완료 | TaskUpdate (워커) | ✓ completed |
| 메시지 전송 | SendMessage | ✓ 전송 확인 |
| 팀 정리 | TeamDelete | ✓ 정리 완료 |

### 7.2 발견된 이슈

| 이슈 | 상세 | 우회 방법 |
|------|------|----------|
| shutdown 무응답 | 워커가 shutdown_request에 자동 응답 안 함 | config.json에서 `isActive: false` 수동 설정 |
| 워커 응답 지연 | tfx-route.sh → codex exec 실행 시간 | 타임아웃 설정 |
| 모델 고정 | teammate가 항상 Opus 사용 | v2.1에서 Claude wrapper 제거로 해결 |

---

*Last Updated: 2026-03-09*
*Source: triflux session — Claude Code Native Agent Teams reverse engineering*
