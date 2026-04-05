# tfx-multi 라우팅 정확도 분석 — DRY RUN

**입력:** `/tfx-multi 인증 리팩터링 + UI 개선 + 보안 리뷰`
**분석 대상 파일:**
- `skills/tfx-multi/SKILL.md`
- `skills/tfx-multi/references/thorough-pipeline.md`
- `skills/tfx-multi/references/agent-wrapper-rules.md`

---

## Phase 0: Preflight 점검

`--quick`(기본) 모드이므로, 수동 모드 분기가 아닌 자동 모드 분기가 적용된다.
자동 모드에서는 Phase 0(preflight)과 Phase 2(triage)를 **동시 병렬** 실행한다.

실행할 단일 명령:

```bash
curl -sf http://127.0.0.1:27888/status >/dev/null \
  && test -f ~/.claude/scripts/tfx-route.sh \
  && echo "preflight: ok" \
  || echo "preflight: FAIL"
```

점검 항목:
1. Hub HTTP 엔드포인트(`127.0.0.1:27888`) 응답 여부
2. `~/.claude/scripts/tfx-route.sh` 파일 존재 여부

출력 정책: 성공 시 리드에 `preflight: ok (route/hub)` 한 줄만 노출.
실패 시에만 상세 항목(tfx-route.sh 없음, Hub 비정상, CLI 미설치) 노출.

---

## Phase 1: 입력 파싱

원본 입력: `"인증 리팩터링 + UI 개선 + 보안 리뷰"`

파싱 결과 분류:

| 조건 | 해당 여부 |
|------|-----------|
| 빈 문자열 | 아니오 |
| `"N:agent"` 수동 모드 패턴 | 아니오 |
| `--tmux` / `--psmux` | 아니오 |
| `status` / `stop` | 아니오 |
| `--thorough` | 아니오 (플래그 없음) |
| 자연어 복합 작업 | **YES** |

**결론:** `--quick`(기본) 자동 모드로 분기. `--thorough` 플래그가 없으므로
Phase 2.5~2.6 및 Phase 3.5~3.7(thorough 파이프라인)은 건너뛴다.

---

## Phase 2: 트리아지 — 서브태스크 분해

자동 모드 흐름:

### Step 2-1: Codex 분류

```bash
# Phase 0과 동시 병렬 실행
codex --full-auto --skip-git-repo-check \
  "다음 작업을 분류하라: 인증 리팩터링 + UI 개선 + 보안 리뷰
   출력: JSON {parts: [{description, agent}]}"
```

예상 Codex 분류 결과 (JSON):

```json
{
  "parts": [
    { "description": "인증 리팩터링", "agent": "codex" },
    { "description": "UI 개선",       "agent": "codex" },
    { "description": "보안 리뷰",     "agent": "codex" }
  ]
}
```

### Step 2-2: Opus 인라인 분해

Codex 분류 결과를 바탕으로 Opus가 인라인으로 서브태스크 배열 생성:

```json
[
  {
    "cli": "codex",
    "subtask": "인증 모듈 리팩터링: 토큰 갱신 로직 개선, 세션 관리 단순화",
    "role": "engineer",
    "agentName": "codex-worker-1"
  },
  {
    "cli": "codex",
    "subtask": "UI 개선: 컴포넌트 구조 정리, 접근성 향상, 스타일 일관성 적용",
    "role": "engineer",
    "agentName": "codex-worker-2"
  },
  {
    "cli": "codex",
    "subtask": "보안 리뷰: 인증 흐름 취약점 분석, 의존성 감사, 보안 권고 작성",
    "role": "reviewer",
    "agentName": "codex-worker-3"
  }
]
```

**Fallback:** Codex 분류 실패 시 → Opus가 직접 분류+분해 수행.

서브태스크 목록 (CLI / Role):

| # | CLI   | Role     | 서브태스크 요약          |
|---|-------|----------|--------------------------|
| 1 | codex | engineer | 인증 모듈 리팩터링       |
| 2 | codex | engineer | UI 컴포넌트 개선         |
| 3 | codex | reviewer | 보안 리뷰 및 권고 작성   |

---

## Phase 3: Native Teams 실행

### Step 3a: 팀 생성 (TeamCreate)

`Date.now().toString(36).slice(-6)` 예시값 `"n4z8k1"` 사용:

```
TeamCreate({
  team_name: "tfx-n4z8k1",
  description: "tfx-multi: 인증 리팩터링 + UI 개선 + 보안 리뷰"
})
```

### Step 3b: 공유 작업 등록 (TaskCreate × 3)

```
TaskCreate({
  subject: "인증 모듈 리팩터링: 토큰 갱신 로직 개선, 세션 관리 단순화",
  metadata: { cli: "codex", role: "engineer" }
})
→ taskId: task-1

TaskCreate({
  subject: "UI 개선: 컴포넌트 구조 정리, 접근성 향상, 스타일 일관성 적용",
  metadata: { cli: "codex", role: "engineer" }
})
→ taskId: task-2

TaskCreate({
  subject: "보안 리뷰: 인증 흐름 취약점 분석, 의존성 감사, 보안 권고 작성",
  metadata: { cli: "codex", role: "reviewer" }
})
→ taskId: task-3
```

### Step 3c: 슬림 래퍼 Agent 실행 (Agent × 3)

모든 서브태스크의 `cli`가 `"codex"`이므로, 3개 모두 슬림 래퍼로 spawn한다.

**Agent 호출 1:**

```
Agent({
  name: "codex-worker-1",
  team_name: "tfx-n4z8k1",
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("codex", {
    subtask:   "인증 모듈 리팩터링: 토큰 갱신 로직 개선, 세션 관리 단순화",
    role:      "engineer",
    teamName:  "tfx-n4z8k1",
    taskId:    "task-1",
    agentName: "codex-worker-1",
    leadName:  "team-lead",
    mcp_profile: <환경 기본값>
  })
})
```

**Agent 호출 2:**

```
Agent({
  name: "codex-worker-2",
  team_name: "tfx-n4z8k1",
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("codex", {
    subtask:   "UI 개선: 컴포넌트 구조 정리, 접근성 향상, 스타일 일관성 적용",
    role:      "engineer",
    teamName:  "tfx-n4z8k1",
    taskId:    "task-2",
    agentName: "codex-worker-2",
    leadName:  "team-lead",
    mcp_profile: <환경 기본값>
  })
})
```

**Agent 호출 3:**

```
Agent({
  name: "codex-worker-3",
  team_name: "tfx-n4z8k1",
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: buildSlimWrapperPrompt("codex", {
    subtask:   "보안 리뷰: 인증 흐름 취약점 분석, 의존성 감사, 보안 권고 작성",
    role:      "reviewer",
    teamName:  "tfx-n4z8k1",
    taskId:    "task-3",
    agentName: "codex-worker-3",
    leadName:  "team-lead",
    mcp_profile: <환경 기본값>
  })
})
```

**참고 — 각 슬림 래퍼 내부의 실행 순서 (인터럽트 프로토콜):**

```
1. TaskUpdate(taskId, status: "in_progress")           — task claim
2. SendMessage(to: "team-lead", "작업 시작: {agentName}") — 시작 보고 (턴 경계)
3. Bash(
     command: "bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' {mcp_profile}",
     timeout: <동적 상속 ms>
   )                                                    — tfx-route.sh 경유 실행
4. SendMessage(to: "team-lead", "결과: {요약}")         — 결과 보고 (턴 경계)
5. 리드 피드백 대기 → 피드백 수신 시 Step 3으로 돌아가 재실행
6. TaskUpdate(status: "completed", metadata: {result})
   + SendMessage(to: "team-lead", "완료: {agentName}") — 종료
```

Bash timeout 동적 상속:
- `reviewer` role → analyze/review 프로필 해당 → **3600초(3600000ms)**
- `engineer` role → 기본 → **1080초(1080000ms)**

**Step 3d 적용 여부:** 모든 `cli`가 `"codex"`이므로 `claude` 타입 직접 실행(Step 3d)은 없다.

**Step 3e 사용자 안내:**
```
"팀 생성 완료. Shift+Down으로 워커 전환, Shift+Tab으로 이전 워커."
```

---

## Phase 4: 결과 수집

truth source: `team_task_list`

```bash
Bash("node hub/bridge.mjs team-task-list --team tfx-n4z8k1")
```

수집 로직:
- 각 task의 `metadata.result` 확인
- `metadata.result == "failed"` → Claude fallback 재시도
- `metadata.result == "failed"` (Claude fallback도 실패) → 실패 목록/원인 요약 후 사용자 승인 대기
- 모든 task `status: "completed"` → Phase 5 진행

주의: `TaskUpdate` 상태값은 `pending`, `in_progress`, `completed`, `deleted`만 허용.
`"failed"` 상태값은 Claude Code `TaskUpdate`에서 사용 불가.
실패 여부는 `metadata.result: "failed"`로만 표현.

---

## Phase 5: 정리 (TeamDelete)

성공/실패에 관계없이 **반드시** 실행.

```
1. 백그라운드 Agent 완료를 최대 30초 대기
2. TeamDelete("tfx-n4z8k1")
3. 실패 시:
     forceCleanupTeam("tfx-n4z8k1")
   그래도 실패 시:
     사용자에게 안내: rm -rf ~/.claude/teams/tfx-n4z8k1/
4. 종합 보고서 출력
```

TeamDelete를 건너뛰면 `~/.claude/teams/tfx-n4z8k1/`이 잔존하여 무한 루프 발생.

---

## 핵심 규칙 준수 여부 체크리스트

| 규칙 | 적용 여부 | 비고 |
|------|-----------|------|
| `mode: "bypassPermissions"` 포함 | YES | 모든 Agent 호출에 포함 |
| Agent 래퍼 생략 금지 | YES | 3개 서브태스크 모두 Agent로 spawn |
| `tfx-route.sh` 경유 | YES | 래퍼 내부 Bash에서 `bash ~/.claude/scripts/tfx-route.sh` 사용 |
| 직접 `codex exec` 호출 금지 | YES | tfx-route.sh로만 실행 |
| 코드 직접 조작 금지 | YES | 워커가 Read/Edit/Write 등 직접 사용 안 함 |
| Lead 고토큰 MCP 직접 사용 금지 | YES | 필요시 scientist/document-specialist 워커에 위임 |
| TaskUpdate 상태값 제한 | YES | "completed"만 사용, failed는 metadata.result로 표현 |
| TeamDelete 생략 금지 | YES | Phase 5에서 반드시 실행 |

---

## thorough 파이프라인 건너뜀 여부

입력에 `--thorough` 플래그가 없으므로 `--quick`(기본) 모드 적용.
아래 Phase는 **실행되지 않는다:**
- Phase 2.5 (Plan — Codex architect)
- Phase 2.6 (PRD — Codex analyst)
- Phase 3.5 (Verify — Codex review)
- Phase 3.6 (Fix — max 3회)
- Phase 3.7 (Ralph Loop)

`thorough-pipeline.md`는 이 입력에 적용되지 않는다.
단, `--thorough` 모드로 재실행 시 적용될 Phase들의 정확한 파라미터를 제공한다.

---

## 참조 파일이 제공한 추가 컨텍스트

### `references/thorough-pipeline.md`
- `--quick` 모드에서는 적용되지 않음을 명시 확인
- plan/prd/exec/verify/fix/ralph 각 Phase의 `tfx-route.sh` 호출 형태 명확화
- `pipeline-advance` bridge 명령어 패턴 제공
- fix_max(3), ralph_max(10) 한도 명시

### `references/agent-wrapper-rules.md`
- 슬림 래퍼가 존재해야 하는 3가지 이유를 구체화
  (Shift+Down 등록, 피드백 루프, 재실행 지원)
- 인터럽트 프로토콜 6단계 순서 명확화
- Bash timeout 동적 상속 기준:
  - analyze/review 프로필 또는 architect/analyst 역할 → 3600초
  - 그 외 기본 → 1080초
- `TFX_TEAM_*` 환경변수 목록 및 Named Pipe/HTTP fallback 순서 확인
- `tfx-route.sh` 직접 호출을 금지해야 하는 7가지 기술적 이유
  (모델 지정, MCP 필터, bridge 연동, Windows 호환, 타임아웃, 후처리)

두 참조 파일 모두 SKILL.md의 핵심 규칙에 대한 이유와 상세 파라미터를 제공하여,
라우팅 구현 시 모호한 부분(timeout 값, 인터럽트 순서, pipeline advance 명령)을 명확히 했다.
