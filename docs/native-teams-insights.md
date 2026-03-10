# Claude Code Native Agent Teams — 리버스 엔지니어링 인사이트

## 1. 환경 설정

### 활성화 조건 (P7 함수)
- 환경변수: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (`settings.json`의 `env`에 설정)
- growthbook gate: `tengu_amber_flint = true` (Anthropic 서버측 피처 플래그, 제어 불가)
- 두 조건 모두 충족해야 `TeamCreate`/`TeamDelete`/`SendMessage` 도구가 등록됨

### teammateMode 설정
- 가능한 값: `"auto" | "tmux" | "in-process"`
- 설정 위치: `settings.json` 최상위 키 (`teammateMode`)
- `auto` (기본): tmux 밖이면 in-process, tmux 안이면 split-pane
- `in-process`: 항상 현재 터미널에서 실행 (Shift+Down으로 전환)
- `tmux`: 항상 split-pane 모드

### 저장 경로
- 팀 설정: `~/.claude/teams/{team-name}/config.json`
- 작업 목록: `~/.claude/tasks/{team-name}/` (개별 task JSON 파일)

## 2. 도구 API 스키마 (소스코드에서 추출)

### TeamCreate
- inputSchema: `{ team_name: string (필수), description?: string, agent_type?: string }`
- 생성물: team config + task list 디렉토리
- 반환: `{ team_name, team_file_path, lead_agent_id }`
- 제약: 팀당 1세션, 중첩 팀 불가, 리드만 팀 생성 가능
- `config.json` 초기 구조: `members` 배열에 lead 1명만 포함

### TeamDelete
- inputSchema: `{}` (파라미터 없음)
- 세션 컨텍스트에서 `teamName` 자동 감지
- 활성 멤버가 있으면 실패 (`isActive !== false`인 멤버)
- 팀 디렉토리 + 태스크 디렉토리 삭제

### TaskCreate
- inputSchema: `{ subject: string (필수), description: string (필수), activeForm?: string, metadata?: Record<string, unknown> }`
- 반환: `{ task: { id, subject } }`
- status 기본값: `pending`, owner: `undefined`

### TaskGet
- inputSchema: `{ taskId: string (필수) }`
- 반환: `{ task: { id, subject, description, status, blocks, blockedBy } | null }`

### TaskUpdate
- inputSchema: `{ taskId: string (필수), subject?: string, description?: string, activeForm?: string, status?: "pending"|"in_progress"|"completed"|"deleted", addBlocks?: string[], addBlockedBy?: string[], owner?: string, metadata?: Record<string, unknown> }`
- status를 `in_progress`로 바꾸면서 owner가 없으면 현재 agent 이름으로 자동 설정
- status를 `completed`로 바꾸면 completion validation 실행
- status를 `deleted`로 바꾸면 영구 삭제

### TaskList
- inputSchema: `{}` (파라미터 없음)
- 반환: `{ tasks: [{ id, subject, status, owner?, blockedBy }] }`
- `_internal` 메타데이터가 있는 태스크는 필터링됨

### SendMessage
- type: `"message"` — DM (recipient, content, summary 필수)
- type: `"broadcast"` — 전체 메시지 (content, summary 필수, 비용 주의)
- type: `"shutdown_request"` — 종료 요청 (recipient, content)
- type: `"shutdown_response"` — 종료 응답 (request_id, approve, content?)
- type: `"plan_approval_response"` — 플랜 승인/거부

## 3. Teammate 스폰 메커니즘

### 핵심: Agent 도구에 team_name + name 파라미터
- `TeamCreate`는 teammate를 생성하지 않음 (lead만 생성)
- `Agent({ team_name: "...", name: "worker-1", prompt: "..." })`로 teammate 스폰
- 내부적으로 `NAq` → `WoY` 호출
  - in-process 모드: `PoY` (`xT6/GE1`로 prompt 포함 실행 컨텍스트 시작)
  - split-pane 모드: `DoY/XoY` (새 프로세스 + inbox에 prompt 메시지)
- 숨겨진 CLI 인자: `--agent-id` `--agent-name` `--team-name` `--agent-color` `--parent-session-id`

### config.json 멤버 구조
```json
{
  "agentId": "codex-worker-1@team-name",
  "name": "codex-worker-1",
  "model": "claude-opus-4-6",
  "prompt": "...",
  "color": "blue",
  "planModeRequired": false,
  "joinedAt": 1773056246180,
  "tmuxPaneId": "in-process",
  "cwd": "C:\\Users\\...",
  "subscriptions": [],
  "backendType": "in-process",
  "isActive": true
}
```

### 통신 흐름
- teammate → lead: `SendMessage(type: message, recipient: team-lead)`
- lead → teammate: `SendMessage(type: message, recipient: worker-name)`
- 메시지 자동 배달 (폴링 불필요)
- idle 상태에서 메시지 수신하면 자동 wake

## 4. Team Workflow (공식 흐름)
1. `TeamCreate({ team_name })` — 팀 + 태스크 디렉토리 생성
2. `TaskCreate` × N — 공유 작업 등록
3. `Agent({ team_name, name })` × N — teammate 스폰 (`run_in_background: true`)
4. `TaskUpdate({ owner })` — 작업 배정
5. Teammate: `TaskList` → `TaskGet` → `TaskUpdate(in_progress)` → 작업 → `TaskUpdate(completed)` → `SendMessage`
6. `SendMessage(shutdown_request)` — 각 teammate에게 종료 요청
7. `TeamDelete()` — 팀 정리 (활성 멤버 없어야 함)

## 5. 실험 결과

### 테스트: tfx-test-hello
- `TeamCreate` ✓, `TaskCreate` ✓, `Agent(team_name, name)` ✓
- 워커가 task claim → `in_progress` → `completed` 처리 ✓
- `SendMessage` 전송 확인 ✓
- in-process 모드 (`backendType: in-process`) 확인 ✓
- 문제: teammate 모델이 Opus 고정 (Haiku 지정 불가)
- 문제: `shutdown_request`에 자동 응답 안 됨 → `isActive: false` 수동 설정 필요

### 핵심 발견: Claude 래퍼 오버헤드
- teammate = Claude Code 인스턴스 (Opus) → Bash(`tfx-route.sh`) → Codex/Gemini
- Opus 토큰을 단순 래퍼(실행+보고)에 낭비
- 해결: Hub MCP를 확장하여 Native Teams TaskList/Mailbox 프록시
  → Codex/Gemini가 직접 MCP로 task claim + 결과 보고
  → Claude 래퍼 불필요

## 6. 아키텍처 발전 경로

### v1 (tmux): tmux pane + Hub MCP
### v2 (native): Claude teammate wrapper + Native TaskList/Mailbox  
### v2.1 (direct): Hub MCP → Native Teams 프록시 + 직행 Bash 실행

v2.1 목표:
- Hub MCP에 `team_task_list`, `team_task_update`, `team_task_complete`, `team_send_message` 추가
- Codex/Gemini가 Hub MCP를 통해 직접 `TaskList`/`Mailbox` 사용
- Lead(Claude)는 `TeamCreate` + `TaskCreate` 후 Bash(`tfx-route.sh`) 직행
- Claude 토큰: 오케스트레이션만 (최소)
- Codex/Gemini 토큰: 실제 작업 수행 (무료)

## 7. 관련 파일 경로
- `hub/server.mjs`: Hub MCP 서버
- `hub/bridge.mjs`: CLI ↔ Hub 브릿지
- `hub/team/native.mjs`: teammate 프롬프트 템플릿
- `hub/team/cli.mjs`: tmux 팀 CLI
- `scripts/tfx-route.sh`: CLI 라우팅 래퍼
- `skills/tfx-team/SKILL.md`: 팀 스킬 정의
- `scripts/setup.mjs`: 자동 설정 (`AGENT_TEAMS`, `teammateMode`)

---
**참고 자료:**
- Claude Code 공식 라이브러리 (v2.1.39): [/anthropics/claude-code](https://context7.com/anthropics/claude-code)
- Claude Code Slash Commands 및 아키텍처: [llms.txt](https://context7.com/anthropics/claude-code/llms.txt)
- `triflux` 프로젝트 소스 코드 (`hub/team/native.mjs`, `scripts/setup.mjs`)
