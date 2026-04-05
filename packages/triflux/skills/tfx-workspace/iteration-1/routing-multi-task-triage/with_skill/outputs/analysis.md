# Routing Analysis: `/tfx-auto 프론트엔드 리팩터링하고 보안 리뷰도 해줘`

## 1. Mode Selection

**Selected mode: AUTO**

The input `/tfx-auto 프론트엔드 리팩터링하고 보안 리뷰도 해줘` uses the `tfx-auto` trigger directly with a free-form natural language task description. It does not match any command shortcut keyword (e.g., `implement`, `cleanup`, `analyze`), and it does not use the manual `N:agent_type` prefix syntax.

Per the SKILL.md mode table:

| Input pattern | Mode | Triage |
|---|---|---|
| `/tfx-auto "리팩터링 + UI"` | 자동 (auto) | Codex 분류 → Opus 분해 |

This request falls exactly into the **auto mode** pattern.

---

## 2. Triage Trigger

Triage **IS triggered** because the mode is auto (not a command shortcut, not manual).

The triage proceeds in two steps:

### Step 1 — Codex Classification
```
codex exec --full-auto --skip-git-repo-check
```
Input: `"프론트엔드 리팩터링하고 보안 리뷰도 해줘"`

Expected output JSON:
```json
{
  "parts": [
    { "description": "프론트엔드 리팩터링", "agent": "codex" },
    { "description": "보안 리뷰", "agent": "codex" }
  ]
}
```

### Step 2 — Opus Inline Decomposition
Opus receives the classified parts and decomposes them into a structured subtask graph:

```json
{
  "graph_type": "INDEPENDENT",
  "subtasks": [
    {
      "id": "st-1",
      "description": "프론트엔드 코드 리팩터링",
      "scope": "frontend source files",
      "agent": "executor",
      "mcp_profile": "implement",
      "depends_on": [],
      "context_output": "refactor-summary",
      "context_input": null
    },
    {
      "id": "st-2",
      "description": "보안 리뷰 수행",
      "scope": "전체 코드베이스 또는 프론트엔드",
      "agent": "security-reviewer",
      "mcp_profile": "review",
      "depends_on": [],
      "context_output": "security-review-report",
      "context_input": null
    }
  ]
}
```

The two tasks ("리팩터링" and "보안 리뷰") are **semantically independent**: refactoring does not depend on the security review and vice versa, so `graph_type` resolves to `INDEPENDENT`.

If Codex classification fails, Opus performs both classification and decomposition directly (fallback path per SKILL.md §트리아지).

---

## 3. Task Decomposition into Subtasks

The request contains two distinct tasks:

| # | Description | Agent | MCP Profile |
|---|---|---|---|
| st-1 | 프론트엔드 리팩터링 | `executor` | `implement` |
| st-2 | 보안 리뷰 | `security-reviewer` | `review` |

Agent assignments follow the SKILL.md agent mapping table:
- Refactoring → `executor` → Codex, MCP: `implement`
- Security review → `security-reviewer` → Codex (review mode), MCP: `review`

---

## 4. Subtask Count >= 2 → Delegation to tfx-multi

**Subtask count = 2, which satisfies `>= 2`.**

Per SKILL.md §멀티 태스크 라우팅:

> 트리아지 결과 서브태스크가 2개 이상이면 tfx-multi Native Teams 모드로 자동 전환한다.

The skill **automatically delegates to tfx-multi Phase 3**, skipping tfx-multi's own Phase 2 (triage) since triage has already been completed by tfx-auto.

The handoff logic:
```
if subtasks.length >= 2:
  → tfx-multi Phase 3 실행 (트리아지 결과 재사용)
  → TeamCreate → TaskCreate × N → Agent 래퍼 spawn (Phase 3a~3c)
  → Phase 4 결과 수집 → Phase 5 정리
```

---

## 5. Exact Sequence of Actions

```
[Step 1] Mode detection
  Input: "/tfx-auto 프론트엔드 리팩터링하고 보안 리뷰도 해줘"
  → No command shortcut match
  → No N:agent_type prefix
  → Mode = AUTO, triage = ENABLED

[Step 2] Triage — Codex classification
  codex exec --full-auto --skip-git-repo-check
  Prompt: "프론트엔드 리팩터링하고 보안 리뷰도 해줘"
  Output: { parts: [ {description: "프론트엔드 리팩터링", agent: "codex"},
                     {description: "보안 리뷰", agent: "codex"} ] }

[Step 3] Triage — Opus inline decomposition
  Input: classified parts from Step 2
  Output: {
    graph_type: "INDEPENDENT",
    subtasks: [
      { id: "st-1", description: "프론트엔드 리팩터링", agent: "executor",
        mcp_profile: "implement", depends_on: [] },
      { id: "st-2", description: "보안 리뷰", agent: "security-reviewer",
        mcp_profile: "review", depends_on: [] }
    ]
  }

[Step 4] Subtask count check
  subtasks.length = 2  →  >= 2 condition TRUE
  → Delegate to tfx-multi Phase 3 (skip tfx-multi Phase 2)

[Step 5] tfx-multi Phase 3a — TeamCreate
  Create a Native Teams session with the decomposed subtask list

[Step 6] tfx-multi Phase 3b — TaskCreate × 2
  Task 1: "프론트엔드 리팩터링" → executor / implement
  Task 2: "보안 리뷰" → security-reviewer / review

[Step 7] tfx-multi Phase 3c — Agent wrapper spawn (parallel, INDEPENDENT graph)
  Bash("bash ~/.claude/scripts/tfx-route.sh executor '프론트엔드 리팩터링' implement",
       run_in_background=true)
  Bash("bash ~/.claude/scripts/tfx-route.sh security-reviewer '보안 리뷰' review",
       run_in_background=true)
  Both tasks run concurrently because graph_type = INDEPENDENT (no depends_on).

[Step 8] tfx-multi Phase 4 — Result collection
  Await both background tasks.
  Parse exit codes and extract OUTPUT sections.
  On timeout (exit 124): use PARTIAL OUTPUT.
  On failure (exit ≠ 0): Claude fallback → Agent(subagent_type="oh-my-claudecode:executor", model="sonnet")

[Step 9] tfx-multi Phase 5 — Cleanup & report
  Produce final report in tfx-auto format:
  ## tfx-auto 완료
  **모드**: auto | **그래프**: INDEPENDENT | **레벨**: 0
  | # | 서브태스크 | Agent | CLI | MCP | 레벨 | 상태 | 시간 |
  |---|---|---|---|---|---|---|---|
  | 1 | 프론트엔드 리팩터링 | executor | codex | implement | 0 | ✓ | Xs |
  | 2 | 보안 리뷰 | security-reviewer | codex | review | 0 | ✓ | Ys |
  ### 워커 1: 프론트엔드 리팩터링
  (리팩터링 결과 요약)
  ### 워커 2: 보안 리뷰
  (보안 리뷰 결과 요약)
  ### Token Savings Report
  (node ~/.claude/scripts/token-snapshot.mjs report {session-id})
```

---

## Summary

| Item | Value |
|---|---|
| Mode | AUTO |
| Triage triggered | Yes (Codex classification → Opus decomposition) |
| Graph type | INDEPENDENT |
| Subtask count | 2 |
| Delegation to tfx-multi | Yes (Phase 3 entry, skipping Phase 2) |
| Execution style | Parallel (both tasks run concurrently via run_in_background=true) |
| st-1 agent/MCP | executor / implement |
| st-2 agent/MCP | security-reviewer / review |
