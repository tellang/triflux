# tfx-multi Routing Analysis

**Input:** `/tfx-multi 인증 리팩터링 + UI 개선 + 보안 리뷰`
**Skill:** `tfx-multi` (SKILL.md — v3 파이프라인 기반 멀티-CLI 팀 오케스트레이터)
**Mode detected:** `--quick` (기본값, `--thorough` 플래그 없음)

---

## Phase 0: Preflight Checks

**병렬 정책:** 자동 모드이므로 Phase 0(preflight) + Phase 2(triage)를 동시 병렬로 실행한다.
Agent spawn(Phase 3)은 Phase 2 완료 후 시작한다.

단일 Bash 명령으로 통합 실행:

```bash
Bash("curl -sf http://127.0.0.1:27888/status >/dev/null && test -f ~/.claude/scripts/tfx-route.sh && echo 'preflight: ok' || echo 'preflight: FAIL'")
```

점검 항목:
- Hub 상태: `http://127.0.0.1:27888/status` 응답 확인 (`/health` 단독 판정 금지)
- `tfx-route.sh` 파일 존재 여부: `~/.claude/scripts/tfx-route.sh`
- 필수 CLI 설치 여부: codex, gemini (검증 실패 시 해당 워커를 claude fallback으로 대체)

출력 정책: 성공 시 `preflight: ok (route/hub)` 한 줄만 노출. 실패 항목이 있을 때만 상세 출력.

---

## Phase 1: Input Parsing

입력 문자열: `"인증 리팩터링 + UI 개선 + 보안 리뷰"`

- `--tmux` / `--psmux` 플래그: 없음 → Phase 3-mux 분기 없음
- `--thorough` 플래그: 없음 → `--quick` (기본) 모드 확정
- `N:agent` 패턴: 없음 → 수동 모드 아님
- `--agents` 플래그: 없음
- 제어 커맨드 (`status`, `stop`, `kill`, `attach`, `list`, `send`): 없음
- 인자: 비어 있지 않음 → Phase 2로 진행 가능

결론: **자동 모드** (Codex 분류 → Opus 분해)로 Phase 2 진행.

---

## Phase 2: Triage (자동 모드)

### Step 2a: Codex 분류

```bash
Bash("codex exec --full-auto --skip-git-repo-check '다음 작업을 분석하고 각 부분에 적합한 agent를 분류하라.

  agent 선택:
  - codex: 코드 구현/수정/분석/리뷰/디버깅/설계 (기본값)
  - gemini: 문서/UI/디자인/멀티모달
  - claude: 코드베이스 탐색/테스트 실행/검증 (최후 수단)

  모든 역할은 Codex/Gemini 우선 배정:
  - explore, verifier, test-engineer, qa-tester 포함 전 역할이 Codex/Gemini로 라우팅
  - Codex/Gemini 미설치 시에만 claude-native(sonnet/haiku) fallback
  - claude 타입은 최후 수단으로만 사용

  작업: 인증 리팩터링 + UI 개선 + 보안 리뷰

  JSON만 출력:
  { \"parts\": [{ \"description\": \"...\", \"agent\": \"codex|gemini|claude\" }] }
'")
```

Codex 분류 실패 시 → Opus(오케스트레이터)가 직접 분류+분해.

### Step 2b: 인라인 분해 (예상 결과)

Codex 분류 결과를 기반으로 아래 서브태스크 배열을 구성한다:

| # | CLI    | Subtask       | Role      |
|---|--------|---------------|-----------|
| 1 | codex  | 인증 리팩터링 | executor  |
| 2 | gemini | UI 개선       | designer  |
| 3 | codex  | 보안 리뷰     | reviewer  |

```javascript
assignments = [
  { cli: "codex",  subtask: "인증 리팩터링", role: "executor" },
  { cli: "gemini", subtask: "UI 개선",       role: "designer" },
  { cli: "codex",  subtask: "보안 리뷰",     role: "reviewer" }
]
```

> 참고: 입력에 `+`로 구분된 3개의 명시적 파트가 있으므로 분류 결과는 이 3파트 기준으로 맞춰진다.
> 실제 Codex 분류 JSON에 따라 CLI 배정이 달라질 수 있다.

### Phase 2.5–2.6: 건너뜀

`--quick` 기본 모드이므로 Plan(2.5), PRD(2.6) 단계를 실행하지 않는다.

---

## Phase 3: Native Teams 실행

### Step 3a: TeamCreate

```javascript
teamName = "tfx-" + Date.now().toString(36).slice(-6)
// 예: "tfx-m3x7qk" (실행 시점에 따라 다름)

TeamCreate({
  team_name: teamName,         // e.g. "tfx-m3x7qk"
  description: "tfx-multi: 인증 리팩터링 + UI 개선 + 보안 리뷰"
})
```

### Step 3b: TaskCreate (공유 작업 등록)

각 서브태스크에 대해 순서대로 TaskCreate를 호출하고 반환된 taskId를 보존한다.

**서브태스크 1 (인증 리팩터링):**
```javascript
TaskCreate({
  subject: "인증 리팩터링",
  description: "CLI: codex, 역할: executor\n\n인증 리팩터링 작업 상세 내용",
  metadata: { cli: "codex", role: "executor" }
})
// taskId_1 = created_task.id
// agentName_1 = "codex-worker-1"
```

**서브태스크 2 (UI 개선):**
```javascript
TaskCreate({
  subject: "UI 개선",
  description: "CLI: gemini, 역할: designer\n\nUI 개선 작업 상세 내용",
  metadata: { cli: "gemini", role: "designer" }
})
// taskId_2 = created_task.id
// agentName_2 = "gemini-worker-2"
```

**서브태스크 3 (보안 리뷰):**
```javascript
TaskCreate({
  subject: "보안 리뷰",
  description: "CLI: codex, 역할: reviewer\n\n보안 리뷰 작업 상세 내용",
  metadata: { cli: "codex", role: "reviewer" }
})
// taskId_3 = created_task.id
// agentName_3 = "codex-worker-3"
```

### Step 3c: Agent 슬림 래퍼 spawn (codex/gemini 서브태스크)

3개 서브태스크 모두 cli가 `codex` 또는 `gemini`이므로, 3개 모두 슬림 래퍼 Agent로 spawn한다.
`mode: "bypassPermissions"`는 모든 Agent spawn에 반드시 포함된다.

**Agent 1 — codex-worker-1 (인증 리팩터링):**
```javascript
Agent({
  name: "codex-worker-1",
  team_name: teamName,            // "tfx-m3x7qk"
  mode: "bypassPermissions",      // [필수] 사용자 승인 없이 Bash 실행
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("codex", {
    subtask:   "인증 리팩터링",
    role:      "executor",
    teamName:  teamName,
    taskId:    taskId_1,
    agentName: "codex-worker-1",
    leadName:  "team-lead",
    mcp_profile: mcp_profile      // tfx-route.sh에 전달할 MCP 프로파일
  })
  // prompt 내용(buildSlimWrapperPrompt 출력, ~100 토큰):
  // 1. TaskUpdate(taskId_1, status: "in_progress")
  // 2. SendMessage(to: "team-lead", "작업 시작: codex-worker-1")
  // 3. Bash("bash ~/.claude/scripts/tfx-route.sh executor '인증 리팩터링' {mcp_profile}",
  //         timeout: 1140000)   // 1080초 + 60초 여유 = 1140초 → ms
  // 4. SendMessage(to: "team-lead", "결과: {요약}")
  // 5. 리드 피드백 대기 → 필요 시 Step 3 재실행
  // 6. TaskUpdate(taskId_1, status: "completed", metadata: {result: "success"|"failed"})
  //    + SendMessage(to: "team-lead") → 종료
})
```

Bash timeout 계산: `executor` 역할, 일반 프로파일 → 기본 1080초 + 60초 = **1140초 → 1,140,000 ms**

**Agent 2 — gemini-worker-2 (UI 개선):**
```javascript
Agent({
  name: "gemini-worker-2",
  team_name: teamName,
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("gemini", {
    subtask:   "UI 개선",
    role:      "designer",
    teamName:  teamName,
    taskId:    taskId_2,
    agentName: "gemini-worker-2",
    leadName:  "team-lead",
    mcp_profile: mcp_profile
  })
  // Bash 내부:
  // Bash("bash ~/.claude/scripts/tfx-route.sh designer 'UI 개선' {mcp_profile}",
  //      timeout: 1140000)
})
```

**Agent 3 — codex-worker-3 (보안 리뷰):**
```javascript
Agent({
  name: "codex-worker-3",
  team_name: teamName,
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("codex", {
    subtask:   "보안 리뷰",
    role:      "reviewer",
    teamName:  teamName,
    taskId:    taskId_3,
    agentName: "codex-worker-3",
    leadName:  "team-lead",
    mcp_profile: mcp_profile
  })
  // Bash 내부:
  // Bash("bash ~/.claude/scripts/tfx-route.sh reviewer '보안 리뷰' {mcp_profile}",
  //      timeout: 4260000)   // reviewer → review 프로파일 → 3600초 + 60초 = 3660초
  // ※ reviewer 역할은 review 프로파일로 분류될 수 있어 timeout이 3660초가 될 수 있음
})
```

> Bash timeout 참고:
> - `analyze/review` 프로파일 또는 `architect/analyst` 역할: 3600초 + 60초 = 3660초 → 3,660,000 ms
> - 그 외 기본: 1080초 + 60초 = 1140초 → 1,140,000 ms
> - `reviewer` 역할이 `review` 프로파일로 매핑되면 3,660,000 ms, 기본 프로파일이면 1,140,000 ms

### Step 3d: claude 타입 Agent 직접 실행

이 케이스에서는 `cli == "claude"` 서브태스크가 없으므로 Step 3d는 실행되지 않는다.

### Step 3e: 사용자 안내

```
"팀 '{teamName}' 생성 완료.
Codex/Gemini 워커가 슬림 래퍼 Agent로 네비게이션에 등록되었습니다.
Shift+Down으로 다음 워커로 전환 (마지막→리드 wrap). Shift+Tab으로 이전 워커 전환."
```

### Phase 3.5–3.7: 건너뜀

`--quick` 모드이므로 Verify(3.5), Fix Loop(3.6), Ralph Loop(3.7)을 실행하지 않는다.

---

## Phase 4: 결과 수집

truth source: `team_task_list`

```bash
Bash("node hub/bridge.mjs team-task-list --team ${teamName}")
```

1. 모든 백그라운드 Agent 완료를 대기한다.
2. 위 명령으로 `team_task_list`를 최종 truth source로 조회한다.
3. `status: "completed"` + `metadata.result == "failed"` 태스크가 있으면 Claude fallback 재시도한다.
4. 재시도 후 `team_task_list`를 재조회하여 최종 상태를 확정한다.
5. `send-message` 및 `result(task.result)` 이벤트는 진행 관찰 채널로만 사용한다. 최종 판정은 반드시 `team_task_list` 기준.

종합 보고서 형식:
```markdown
## tfx-multi 실행 결과

| # | Worker        | CLI    | 작업          | 상태      |
|---|---------------|--------|---------------|-----------|
| 1 | codex-worker-1  | codex  | 인증 리팩터링 | completed |
| 2 | gemini-worker-2 | gemini | UI 개선       | completed |
| 3 | codex-worker-3  | codex  | 보안 리뷰     | completed |
```

---

## Phase 5: Cleanup (TeamDelete)

반드시 실행 — 성공/실패 관계없이 건너뛸 수 없음.

1. 모든 백그라운드 Agent 완료를 **최대 30초** 대기한다.
2. 30초 후에도 미완료 Agent가 있으면 대기를 중단하고 정리를 진행한다.
3. `TeamDelete()` 호출:
   ```javascript
   TeamDelete({ team_name: teamName })
   ```
4. TeamDelete 실패 시 (활성 멤버 잔존) → `forceCleanupTeam(teamName)` 강제 정리.
   `forceCleanupTeam`도 실패 시 수동 정리 안내:
   ```bash
   rm -rf ~/.claude/teams/{teamName}/ ~/.claude/tasks/{teamName}/
   ```
5. 종합 보고서를 출력한다.

TeamDelete를 반드시 실행해야 하는 이유: `~/.claude/teams/{teamName}/`이 잔존하면
OMC hook이 "team executing"을 반복 감지하는 무한 루프에 빠진다.

---

## 핵심 규칙 확인

### `mode: "bypassPermissions"` 포함 여부

**포함 — 필수.** 모든 Agent spawn(codex-worker, gemini-worker, claude-worker)에 반드시 포함한다.
이 설정이 없으면 워커의 Bash 실행 시 사용자 승인이 요청되어 자동 실행이 중단된다.

본 케이스의 3개 Agent 모두:
- `Agent({ ..., mode: "bypassPermissions", ... })`

### `tfx-route.sh` 사용 여부 (Agent 내부)

**사용 — 필수.** 슬림 래퍼 Agent 내부에서 Codex/Gemini를 실행할 때 반드시 아래 형식만 허용:

```bash
bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' {mcp_profile}
```

**직접 호출 금지:**
- `codex exec "..."` — 직접 호출 금지
- `gemini -y -p "..."` — 직접 호출 금지

직접 호출 시 누락되는 항목:
- 모델 지정 (`-m gemini-3.1-pro-preview` 등)
- MCP 필터
- 팀 bridge 연동 (`TFX_TEAM_*`)
- Windows 호환 경로
- 타임아웃
- 후처리 (토큰 추적/이슈 로깅)

tfx-route.sh 내부에서 `TFX_TEAM_*` 환경변수를 통해 Hub 통신:
- `TFX_TEAM_NAME` — 팀 식별자 (`teamName`)
- `TFX_TEAM_TASK_ID` — 작업 식별자 (`taskId`)
- `TFX_TEAM_AGENT_NAME` — 워커 이름 (`agentName`)
- `TFX_TEAM_LEAD_NAME` — 리드 수신자 (`"team-lead"`)

Hub 통신 경로: Named Pipe(`\\.\pipe\triflux-{pid}`) 우선, HTTP(`127.0.0.1:27888`) fallback.

---

## 요약

| 항목                          | 값                                      |
|-------------------------------|-----------------------------------------|
| 감지 모드                     | 자동 모드, `--quick` (기본)             |
| Phase 0 병렬 실행             | preflight + Phase 2(triage) 동시 병렬   |
| 서브태스크 수                 | 3개                                     |
| Agent spawn 방식              | 슬림 래퍼 (Step 3c) × 3, Step 3d 없음  |
| `mode: "bypassPermissions"`   | 3개 Agent 모두 포함 (필수)              |
| tfx-route.sh 경유             | 3개 Agent 내부 Bash 모두 경유 (필수)    |
| Phase 2.5–2.6 (Plan/PRD)      | 건너뜀 (`--quick` 모드)                 |
| Phase 3.5–3.7 (Verify/Fix)    | 건너뜀 (`--quick` 모드)                 |
| Phase 5 (TeamDelete)          | 반드시 실행 (성공/실패 무관)            |
