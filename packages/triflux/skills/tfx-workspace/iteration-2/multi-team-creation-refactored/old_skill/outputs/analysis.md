# tfx-multi Routing Accuracy Analysis

**Input:** `/tfx-multi 인증 리팩터링 + UI 개선 + 보안 리뷰`
**Skill Definition:** SKILL.md (tfx-multi v3)
**Analysis Type:** DRY RUN — no commands executed

---

## Phase 0: Preflight Checks

The skill specifies that in **auto mode** (no `N:agent` prefix, no `--agents` flag), Phase 0 (preflight) and Phase 2 (triage) run **concurrently in parallel**. Preflight does NOT block Phase 2.

The single combined Bash preflight check would be:

```bash
Bash(
  command: "curl -sf http://127.0.0.1:27888/status >/dev/null && test -f ~/.claude/scripts/tfx-route.sh && echo 'preflight: ok' || echo 'preflight: FAIL'",
  description: "Hub status + tfx-route.sh existence check"
)
```

**What is verified:**
1. Hub is running and healthy at `http://127.0.0.1:27888/status` (not `/health` alone — `/status` is the required endpoint per policy)
2. `~/.claude/scripts/tfx-route.sh` exists on the filesystem

**Output policy:** Lead only surfaces a one-line summary (e.g., `preflight: ok (route/hub)`). Individual Bash logs are not surfaced to the user unless preflight fails.

**Failure conditions that would be reported:**
- `tfx-route.sh` missing → advise running `tfx setup`
- Hub not running or unhealthy → advise starting Hub
- Required CLI (codex/gemini) not installed → the affected subtask would be reassigned to a claude worker

**Timing:** Preflight runs **simultaneously** with Phase 2 triage (Codex classification). Agent spawn begins at Phase 3, which waits for Phase 2 output. If preflight fails, Agent spawn is aborted.

---

## Phase 1: Input Parsing

**Raw input string:** `인증 리팩터링 + UI 개선 + 보안 리뷰`

**Parsing decision tree:**

| Check | Result |
|-------|--------|
| Is ARGUMENTS empty/whitespace? | No → proceed |
| Does input match `N:agent_type`? | No (no colon-separated numeric prefix) |
| Does input contain `--tmux` or `--psmux`? | No → not mux mode |
| Does input contain `--agents`? | No → not manual agent-list mode |
| Does input contain `--thorough`? | No → `--quick` mode (default) |
| Does input match a control command (`status`, `stop`, `kill`, `attach`, `list`, `send`)? | No → not a control command |

**Conclusion:** Input is parsed as **auto mode** with `--quick` (default). The full task string `인증 리팩터링 + UI 개선 + 보안 리뷰` is forwarded to Phase 2 triage.

Control commands would have dispatched directly to:
```bash
Bash("node bin/triflux.mjs multi {cmd}")
```
...but that path is not taken here.

---

## Phase 2: Triage — Decomposition into Subtasks

Since this is auto mode, triage follows the **Codex classification → Opus decomposition** path.

### Step 2a: Codex Classification (free, runs in parallel with preflight)

```bash
Bash(
  command: "codex exec --full-auto --skip-git-repo-check '다음 작업을 분석하고 각 부분에 적합한 agent를 분류하라.\n\n  agent 선택:\n  - codex: 코드 구현/수정/분석/리뷰/디버깅/설계 (기본값)\n  - gemini: 문서/UI/디자인/멀티모달\n  - claude: 코드베이스 탐색/테스트 실행/검증 (최후 수단)\n\n  모든 역할은 Codex/Gemini 우선 배정:\n  - explore, verifier, test-engineer, qa-tester 포함 전 역할이 Codex/Gemini로 라우팅\n  - Codex/Gemini 미설치 시에만 claude-native(sonnet/haiku) fallback\n  - claude 타입은 최후 수단으로만 사용\n\n  작업: 인증 리팩터링 + UI 개선 + 보안 리뷰\n\n  JSON만 출력:\n  { \"parts\": [{ \"description\": \"...\", \"agent\": \"codex|gemini|claude\" }] }'"
)
```

**Expected Codex JSON output (predicted):**
```json
{
  "parts": [
    { "description": "인증 리팩터링", "agent": "codex" },
    { "description": "UI 개선",      "agent": "gemini" },
    { "description": "보안 리뷰",    "agent": "codex" }
  ]
}
```

Rationale per skill's agent selection rules:
- `인증 리팩터링` — code refactoring → **codex** (코드 구현/수정)
- `UI 개선` — UI/design improvement → **gemini** (UI/디자인/멀티모달)
- `보안 리뷰` — code review/analysis → **codex** (리뷰/분석)

**Fallback:** If Codex classification fails, Opus (the Lead orchestrator) directly classifies and decomposes without the Codex step.

### Step 2b: Inline Decomposition

Opus maps the Codex output to the subtasks array:

```
assignments = [
  { cli: "codex",  subtask: "인증 리팩터링", role: "executor"  },
  { cli: "gemini", subtask: "UI 개선",       role: "designer"  },
  { cli: "codex",  subtask: "보안 리뷰",     role: "reviewer"  }
]
```

Role mapping rationale:
- `인증 리팩터링` → implementation task → role: `executor`
- `UI 개선` → design/UI improvement → role: `designer`
- `보안 리뷰` → code review → role: `reviewer`

**Note:** `--quick` mode is the default (no `--thorough` flag detected), so **Phase 2.5 (Plan) and Phase 2.6 (PRD) are skipped entirely**. Execution proceeds directly to Phase 3.

---

## Phase 3: Exact Tool Call Parameters

### Step 3a: TeamCreate

```
TeamCreate({
  team_name: "tfx-" + Date.now().toString(36).slice(-6),   // e.g., "tfx-m7x2p1"
  description: "tfx-multi: 인증 리팩터링 + UI 개선 + 보안 리뷰"
})
```

`teamName` (e.g., `"tfx-m7x2p1"`) is stored and reused throughout all subsequent calls.

### Step 3b: TaskCreate (one per subtask)

**TaskCreate #1 — 인증 리팩터링:**
```
TaskCreate({
  subject: "인증 리팩터링",
  description: "CLI: codex, 역할: executor\n\n인증 관련 코드를 리팩터링하고 구조를 개선한다.",
  metadata: { cli: "codex", role: "executor" }
})
→ taskId_1 = <created task id>
→ agentName_1 = "codex-worker-1"
```

**TaskCreate #2 — UI 개선:**
```
TaskCreate({
  subject: "UI 개선",
  description: "CLI: gemini, 역할: designer\n\nUI 컴포넌트 및 사용자 인터페이스를 개선한다.",
  metadata: { cli: "gemini", role: "designer" }
})
→ taskId_2 = <created task id>
→ agentName_2 = "gemini-worker-1"
```

**TaskCreate #3 — 보안 리뷰:**
```
TaskCreate({
  subject: "보안 리뷰",
  description: "CLI: codex, 역할: reviewer\n\n코드베이스의 보안 취약점을 검토하고 리뷰한다.",
  metadata: { cli: "codex", role: "reviewer" }
})
→ taskId_3 = <created task id>
→ agentName_3 = "codex-worker-2"
```

runQueue after Step 3b:
```
[
  { taskId: taskId_1, agentName: "codex-worker-1",  cli: "codex",  subtask: "인증 리팩터링", role: "executor"  },
  { taskId: taskId_2, agentName: "gemini-worker-1", cli: "gemini", subtask: "UI 개선",       role: "designer"  },
  { taskId: taskId_3, agentName: "codex-worker-2",  cli: "codex",  subtask: "보안 리뷰",     role: "reviewer"  }
]
```

### Step 3c: Agent Slim Wrapper Spawns (codex and gemini items)

All three assignments in this input have `cli` of `"codex"` or `"gemini"`, so **all three go through Step 3c** (slim wrapper Agent spawn). None take the Step 3d (claude direct) path.

**Agent #1 — codex-worker-1 (인증 리팩터링):**
```
Agent({
  name: "codex-worker-1",
  team_name: teamName,                  // e.g., "tfx-m7x2p1"
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("codex", {
    subtask:   "인증 리팩터링",
    role:      "executor",
    teamName:  teamName,
    taskId:    taskId_1,
    agentName: "codex-worker-1",
    leadName:  "team-lead",
    mcp_profile: <resolved mcp_profile>
  })
})
```

The slim wrapper prompt (generated by `hub/team/native.mjs:buildSlimWrapperPrompt()`) instructs the agent to:
1. `TaskUpdate(taskId_1, status: "in_progress")` — claim
2. `SendMessage(to: "team-lead", "작업 시작: codex-worker-1")` — turn boundary
3. `Bash(command: "bash ~/.claude/scripts/tfx-route.sh executor '인증 리팩터링' <mcp_profile>", timeout: 1140000)` — execute via tfx-route.sh (1080s + 60s = 1140s = 1,140,000ms; executor role → default timeout)
4. `SendMessage(to: "team-lead", "결과: <요약>")` — result boundary
5. Await lead feedback; re-execute (Step 3) if directed
6. On final completion: `TaskUpdate(taskId_1, status: "completed", metadata: {result: "success"|"failed"})` + `SendMessage`

**Agent #2 — gemini-worker-1 (UI 개선):**
```
Agent({
  name: "gemini-worker-1",
  team_name: teamName,
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("gemini", {
    subtask:   "UI 개선",
    role:      "designer",
    teamName:  teamName,
    taskId:    taskId_2,
    agentName: "gemini-worker-1",
    leadName:  "team-lead",
    mcp_profile: <resolved mcp_profile>
  })
})
```

Internal slim wrapper execution:
```bash
bash ~/.claude/scripts/tfx-route.sh designer 'UI 개선' <mcp_profile>
```
Timeout: 1140000ms (1080s default + 60s buffer).

**Agent #3 — codex-worker-2 (보안 리뷰):**
```
Agent({
  name: "codex-worker-2",
  team_name: teamName,
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("codex", {
    subtask:   "보안 리뷰",
    role:      "reviewer",
    teamName:  teamName,
    taskId:    taskId_3,
    agentName: "codex-worker-2",
    leadName:  "team-lead",
    mcp_profile: <resolved mcp_profile>
  })
})
```

Internal slim wrapper execution:
```bash
bash ~/.claude/scripts/tfx-route.sh reviewer '보안 리뷰' <mcp_profile>
```
Timeout: 3660000ms (reviewer role maps to "review" profile → 3600s + 60s buffer = 3,660,000ms).

> Note on Bash timeout: `getRouteTimeout(role, mcpProfile)` determines the timeout. The `reviewer` role with a `review`-type profile yields **3600s** (not the default 1080s), resulting in a 3,660,000ms Bash timeout. The `executor` and `designer` roles use the default 1080s, giving 1,140,000ms.

### Step 3d: Claude Direct Agent (not applicable here)

No subtasks have `cli == "claude"` in this input. Step 3d is **not executed**.

### Step 3e: User Notification

After all three Agent spawns:
```
"팀 '{teamName}' 생성 완료.
Codex/Gemini 워커가 슬림 래퍼 Agent로 네비게이션에 등록되었습니다.
Shift+Down으로 다음 워커로 전환 (마지막→리드 wrap). Shift+Tab으로 이전 워커 전환."
```

---

## Phase 4: Result Collection

Phase 4 runs after all background Agent processes complete (or are awaited by the Lead).

**Step 1:** Lead awaits completion signals from all three background Agents.

**Step 2:** `team_task_list` is queried as the **single truth source**:
```bash
Bash("node hub/bridge.mjs team-task-list --team tfx-m7x2p1")
```

**Step 3:** For each task in the list:
- If `status == "completed"` AND `metadata.result == "failed"` → the task is retried using a Claude fallback worker (Step 3d pattern)
- If `status == "completed"` AND `metadata.result == "success"` → accepted as done

**Step 4:** After any fallback retries, `team-task-list` is queried again to confirm final state.

**Step 5:** `send-message` events and `result(task.result)` topic events are used only as **progress observation channels** — they do NOT determine the final outcome. Only `team_task_list` state is authoritative.

**Final report (example):**
```markdown
## tfx-multi 실행 결과

| # | Worker | CLI | 작업 | 상태 |
|---|--------|-----|------|------|
| 1 | codex-worker-1 | codex | 인증 리팩터링 | completed |
| 2 | gemini-worker-1 | gemini | UI 개선 | completed |
| 3 | codex-worker-2 | codex | 보안 리뷰 | completed |
```

---

## Phase 5: Cleanup (TeamDelete)

Phase 5 is **mandatory** regardless of success or failure. It runs after Phase 4 result collection.

**Cleanup sequence:**

1. Wait up to **30 seconds** for all background Agent processes to complete.
2. If any Agent is still running after 30s, stop waiting and proceed with cleanup anyway.
3. Call TeamDelete:
   ```
   TeamDelete(teamName)   // e.g., TeamDelete("tfx-m7x2p1")
   ```
4. If TeamDelete fails (active members still present):
   - Call `forceCleanupTeam(teamName)` (force cleanup utility)
   - If that also fails → instruct user to manually run:
     ```bash
     rm -rf ~/.claude/teams/tfx-m7x2p1/ ~/.claude/tasks/tfx-m7x2p1/
     ```
5. Output the final summary report (from Phase 4).

**Why this is mandatory:** Without TeamDelete, `~/.claude/teams/{teamName}/` persists on disk and the OMC hook continuously detects "team executing," causing an infinite detection loop.

---

## Key Boolean Flags

### `mode: "bypassPermissions"` in Agent calls

**YES — included in all three Agent spawns.**

The skill explicitly states (Phase 3c):
> **[필수] `mode: "bypassPermissions"` — 모든 Agent spawn에 반드시 포함한다.**
> 이 설정이 없으면 워커가 Bash 실행 시 사용자 승인을 요청하여 자동 실행이 중단된다.
> Codex/Gemini 래퍼, Claude 워커 모두 동일하게 적용한다.

All three `Agent({...})` calls in this analysis include `mode: "bypassPermissions"`.

### `tfx-route.sh` usage inside Agent wrappers

**YES — all slim wrapper Agents use `tfx-route.sh` exclusively.**

The skill explicitly prohibits direct CLI invocation:
> **[금지] Lead 또는 Agent 래퍼가 `gemini -y -p "..."` 또는 `codex exec "..."`를 직접 호출하면 안 된다.**

The required form inside each slim wrapper Agent is:
```bash
bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' {mcp_profile}
```

This ensures that model specification (`-m gemini-3.1-pro-preview`), MCP filters, team bridge integration (`TFX_TEAM_*` env vars), Windows-compatible paths, timeouts, and post-processing (token tracking, issue logging) are all properly applied.

The three concrete `tfx-route.sh` invocations in this session:
```bash
# codex-worker-1
bash ~/.claude/scripts/tfx-route.sh executor '인증 리팩터링' <mcp_profile>

# gemini-worker-1
bash ~/.claude/scripts/tfx-route.sh designer 'UI 개선' <mcp_profile>

# codex-worker-2
bash ~/.claude/scripts/tfx-route.sh reviewer '보안 리뷰' <mcp_profile>
```

---

## Summary Table

| Phase | Action | Key Parameters / Notes |
|-------|--------|------------------------|
| 0 | Preflight (parallel with Phase 2) | `curl http://127.0.0.1:27888/status` + `test -f ~/.claude/scripts/tfx-route.sh` |
| 1 | Input parsed as **auto mode, --quick** | No `N:agent`, no `--tmux`, no `--thorough`, no control command |
| 2a | Codex classification | Task: `인증 리팩터링 + UI 개선 + 보안 리뷰` → codex / gemini / codex |
| 2b | Subtask array | 3 items: executor/designer/reviewer |
| 3a | TeamCreate | `team_name: "tfx-<6chars>"`, `description: "tfx-multi: 인증 리팩터링 + UI 개선 + 보안 리뷰"` |
| 3b | 3x TaskCreate | subjects: 인증 리팩터링, UI 개선, 보안 리뷰 |
| 3c | 3x Agent (slim wrapper) | `mode: "bypassPermissions"`, `run_in_background: true`, uses `tfx-route.sh` internally |
| 3d | 0x Agent (claude direct) | Not applicable — no `cli: "claude"` assignments |
| 4 | Result collection | `node hub/bridge.mjs team-task-list --team {teamName}` as truth source |
| 5 | TeamDelete | Mandatory; max 30s wait; force cleanup fallback if needed |

---

*Analysis generated by DRY RUN — no commands were executed.*
