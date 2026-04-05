---
name: tfx-multi
description: 멀티-CLI 팀 모드. Claude Native Agent Teams + Codex/Gemini 멀티모델 오케스트레이션.
triggers:
  - tfx-multi
argument-hint: '"작업 설명" | --agents codex,gemini "작업" | --tmux "작업" | status | stop'
---

# tfx-multi v3 — 파이프라인 기반 멀티-CLI 팀 오케스트레이터

> Claude Code Native Teams의 Shift+Down 네비게이션을 복원한다.
> Codex/Gemini 워커마다 최소 프롬프트(~100 토큰)의 슬림 Agent 래퍼를 spawn하여 네비게이션에 등록하고,
> 실제 작업은 `tfx-route.sh`가 수행한다. task 상태는 `team_task_list`를 truth source로 검증한다.
> v3 — `--quick`(기본, v2.2 호환) + `--thorough`(전체 파이프라인: plan→prd→exec→verify→fix loop).

> **[필수] Lead 고토큰 MCP 직접 사용 금지**
> Lead(Claude Opus)는 다음 MCP 도구를 직접 호출하지 마라:
> - **웹 서치**: brave-search, exa, tavily
> - **외부 서비스**: Notion (notion-*), Jira/Confluence (Atlassian mcp__claude_ai_Atlassian__*), Google Calendar, Gmail
> - **대량 조회**: 다중 페이지 읽기, 배치 검색, 이슈 목록 조회 등 반복적 MCP 호출
>
> 위임 방법:
> - 웹 서치/리서치 → `scientist` 또는 `document-specialist` 역할의 Codex 워커
> - Notion 대형 페이지 → `bash ~/.claude/scripts/notion-read.mjs --delegate` (다운로드 후 로컬 처리)
> - Jira/Confluence 배치 조회 → Codex `scientist` 워커에 위임 (워커가 MCP 직접 호출)
> - 단건 조회(이슈 1개 확인 등) → Lead 직접 허용하되, 3회 이상 반복 호출 시 위임 전환
>
> Lead가 MCP 도구에 직접 접근 가능하더라도, 위임해야 Claude 토큰을 절약할 수 있다.
> 특히 Notion/Jira는 응답이 크고 반복 호출이 잦아 토큰 소모가 매우 높다.

## 사용법

```
/tfx-multi "인증 리팩터링 + UI 개선 + 보안 리뷰"           # --quick (기본)
/tfx-multi --thorough "인증 리팩터링 + UI 개선 + 보안 리뷰"  # 전체 파이프라인
/tfx-multi --agents codex,gemini "프론트+백엔드"
/tfx-multi --tmux "작업"         # 레거시 tmux 모드
/tfx-multi status
/tfx-multi stop
```

## 실행 워크플로우

### Phase 0: 사전 점검 정책 (출력 최소화 + 즉시 spawn)

> **[필수] Agent spawn 지연 금지 — preflight와 Agent 생성을 병렬로 실행한다.**
> Lead가 preflight를 순차 완료한 뒤 Agent를 spawn하면 사용자 체감 지연이 발생한다.
> 수동 모드(`N:agent`)에서는 입력 파싱 직후 TeamCreate + Agent spawn을 먼저 시작하고,
> preflight는 **동시에 병렬**로 수행한다. preflight 실패 시에만 Agent를 중단한다.

- 원칙:
  - **수동 모드:** Phase 1 파싱 → Phase 3a~3c(TeamCreate + Agent spawn) + Phase 0(preflight) **동시 병렬**
  - **자동 모드:** Phase 0(preflight) + Phase 2(triage) **동시 병렬** → Phase 3
  - 사용자가 요청하지 않으면 `Searched for ...`, 개별 `Bash(...)` 로그를 전면 보고하지 않는다.
  - 리드에는 요약 한 줄만 노출한다. 예: `preflight: ok (route/hub)`
  - Hub 점검은 `/status`를 기준으로 한다 (`/health` 단독 판정 금지).
- 권장 체크 예시 (단일 Bash로 통합):
  - `curl -sf http://127.0.0.1:27888/status >/dev/null && test -f ~/.claude/scripts/tfx-route.sh && echo "preflight: ok" || echo "preflight: FAIL"`
- 실패 시에만 상세를 노출한다:
  - `tfx-route.sh` 없음
  - Hub 비정상/미기동
  - 필수 CLI 미설치

### Phase 1: 입력 파싱

> **[필수] 인자 없음 → 즉시 사용자에게 작업 입력 요청**
> `/tfx-multi`가 인자 없이 호출되면(ARGUMENTS가 빈 문자열 또는 공백만) Phase 2로 진행하지 마라.
> "어떤 작업을 실행할까요?" 등 짧은 프롬프트로 사용자에게 작업 내용을 요청하고,
> 사용자 응답을 받은 후에야 Phase 2로 진행한다.
> **절대로** 인자 없이 TeamCreate/Agent spawn/Claude 네이티브 팀 구성을 시작하지 마라.

```
입력: ""(빈 문자열)          → 사용자에게 작업 입력 요청 (Phase 2 진행 금지)
입력: "3:codex 리뷰"         → 수동 모드: N=3, agent=codex
입력: "인증 + UI + 테스트"    → 자동 모드: Codex 분류 → Opus 분해
입력: "--tmux 인증 + UI"     → tmux 레거시 모드 → Phase 3-tmux로 분기
입력: "status"               → 제어 커맨드
입력: "stop"                 → 제어 커맨드
```

**제어 커맨드 감지:**
- `status`, `stop`, `kill`, `attach`, `list`, `send` → `Bash("node bin/triflux.mjs multi {cmd}")` 직행
  (`bin/triflux.mjs` 절대경로는 triflux 패키지 루트 기준)
- 그 외 → Phase 2 트리아지

**--tmux/--psmux 감지:** 입력에 `--tmux` 또는 `--psmux`가 포함되면 Phase 3-mux로 분기. psmux가 primary (Windows).

### Phase 2: 트리아지 (tfx-auto와 동일)

#### 자동 모드 — Codex 분류 → Opus 분해

```bash
# Step 2a: Codex 분류 (무료)
Bash("codex exec --full-auto --skip-git-repo-check '다음 작업을 분석하고 각 부분에 적합한 agent를 분류하라.

  agent 선택:
  - codex: 코드 구현/수정/분석/리뷰/디버깅/설계 (기본값)
  - gemini: 문서/UI/디자인/멀티모달
  - claude: 코드베이스 탐색/테스트 실행/검증 (최후 수단)

  모든 역할은 Codex/Gemini 우선 배정:
  - explore, verifier, test-engineer, qa-tester 포함 전 역할이 Codex/Gemini로 라우팅
  - Codex/Gemini 미설치 시에만 claude-native(sonnet/haiku) fallback
  - claude 타입은 최후 수단으로만 사용

  작업: {task}

  JSON만 출력:
  { \"parts\": [{ \"description\": \"...\", \"agent\": \"codex|gemini|claude\" }] }
'")
```

> Codex 분류 실패 시 → Opus(오케스트레이터)가 직접 분류+분해

```
# Step 2b: 인라인 분해
분류 결과 → 서브태스크 배열 구성:
  [{ cli: "codex", subtask: "인증 리팩터링", role: "executor" },
   { cli: "gemini", subtask: "UI 개선", role: "designer" },
   { cli: "codex", subtask: "보안 리뷰", role: "reviewer" }]
```

#### 수동 모드 (`N:agent_type` 또는 `--agents`)

Codex 분류 건너뜀 → Opus가 직접 N개 서브태스크 분해.

### Phase 2.5–2.6: 파이프라인 Plan/PRD (`--thorough` 전용)

> `--quick`(기본) 모드에서는 이 단계를 건너뛰고 Phase 3으로 직행한다.
> `--thorough` 모드에서만 실행된다.

```
[--thorough 모드 감지]

Phase 2.5: Plan (Codex architect)
  1. Hub pipeline 초기화:
     Bash("node hub/bridge.mjs pipeline-advance --team ${teamName} --status plan")
     — 또는 createPipeline(db, teamName) 직접 호출
  2. Codex architect로 작업 분석 + 접근법 설계:
     bash ~/.claude/scripts/tfx-route.sh architect "${task}" analyze
  3. 결과를 파이프라인 artifact에 저장:
     pipeline.setArtifact('plan_path', planOutputPath)
  4. pipeline advance: plan → prd

Phase 2.6: PRD (Codex analyst)
  1. Codex analyst로 수용 기준 확정:
     bash ~/.claude/scripts/tfx-route.sh analyst "${task}" analyze
  2. 결과를 파이프라인 artifact에 저장:
     pipeline.setArtifact('prd_path', prdOutputPath)
  3. pipeline advance: prd → exec
```

### Phase 3: Native Teams 실행 (v2.1 개편)

트리아지 결과를 Claude Code 네이티브 Agent Teams로 실행한다.

#### Step 3a: 팀 생성

```
teamName = "tfx-" + Date.now().toString(36).slice(-6)

TeamCreate({
  team_name: teamName,
  description: "tfx-multi: {원본 작업 요약}"
})
```

#### Step 3b: 공유 작업 등록

각 서브태스크에 대해 `TaskCreate`를 호출하고 `taskId`를 보존한다.
리드가 실행 시 사용할 `agentName`도 함께 확정한다.

```
for each assignment in assignments (index i):
  TaskCreate({
    subject: assignment.subtask,
    description: "CLI: {assignment.cli}, 역할: {assignment.role}\n\n{상세 작업 내용}",
    metadata: { cli: assignment.cli, role: assignment.role }
  })
  taskId = created_task.id
  agentName = "{assignment.cli}-worker-{i+1}"
  runQueue.push({ taskId, agentName, ...assignment })
```

#### Step 3c: 슬림 래퍼 Agent 실행 (v2.2 네비게이션 복원)

> **[배경] Native Teams의 teammate는 Claude 모델만 가능하다.**
> Codex/Gemini는 teammate로 직접 등록할 수 없으므로, Claude slim wrapper를 spawn하고
> 래퍼 내부에서 `tfx-route.sh`로 Codex/Gemini CLI를 실행하는 구조이다.

> **[필수] Codex/Gemini 서브태스크는 워커 수에 관계없이 반드시 Agent 래퍼를 spawn해야 한다.**
> 단일 워커(1:gemini 등)여도 Lead가 직접 Bash를 실행하면 안 된다.
> Agent 래퍼를 생략하면 Shift+Down 네비게이션에 워커가 등록되지 않아 v2.2의 핵심 가치가 사라진다.
> Lead가 "효율적"이라고 판단해서 Agent를 건너뛰는 것은 금지한다.

Codex/Gemini 서브태스크마다 최소 프롬프트의 Agent를 spawn하여 네비게이션에 등록한다.
Agent 내부에서 `Bash(tfx-route.sh)`를 N회 실행할 수 있다. 리드 피드백을 받아 재실행하는 구조이다.

```
for each item in runQueue where item.cli in ["codex", "gemini"]:
  Agent({
    name: item.agentName,
    team_name: teamName,
    mode: "bypassPermissions",
    run_in_background: true,
    prompt: buildSlimWrapperPrompt(item.cli, {
      subtask: item.subtask,
      role: item.role,
      teamName: teamName,
      taskId: item.taskId,
      agentName: item.agentName,
      leadName: "team-lead",
      mcp_profile: mcp_profile
    })
  })
```

슬림 래퍼 프롬프트는 `hub/team/native.mjs`의 `buildSlimWrapperPrompt()`가 **단일 truth source**.
핵심 동작: Bash(tfx-route.sh) 실행 → SendMessage(결과 보고) → 리드 피드백 대기 → 필요 시 재실행(N회).
최종 완료 시 TaskUpdate(completed) + SendMessage → 종료.
status는 "completed"만 사용. 실패 여부는 `metadata.result`로 구분.

> **[핵심] 슬림 래퍼는 1회성이 아니다 — 리드↔워커 피드백 루프가 설계 의도이다.**
> 워커가 tfx-route.sh 실행 후 결과를 SendMessage로 보고하면 턴 경계가 생긴다.
> 리드는 이 턴 경계에서 방향 수정/추가 지시를 보낼 수 있고,
> 워커는 피드백을 반영하여 tfx-route.sh를 재실행한다.
> 래퍼 존재 이유: (1) Shift+Down 네비게이션 등록 (2) 리드↔워커 피드백 루프 (3) 실패 시 재실행

> **[필수] `mode: "bypassPermissions"` — 모든 Agent spawn에 반드시 포함한다.**
> 이 설정이 없으면 워커가 Bash 실행 시 사용자 승인을 요청하여 자동 실행이 중단된다.
> Codex/Gemini 래퍼, Claude 워커 모두 동일하게 적용한다.

> **[금지] Lead 또는 Agent 래퍼가 `gemini -y -p "..."` 또는 `codex exec "..."`를 직접 호출하면 안 된다.**
> 직접 호출하면 tfx-route.sh의 모델 지정(`-m gemini-3.1-pro-preview`), MCP 필터, 팀 bridge 연동,
> Windows 호환 경로, 타임아웃, 후처리(토큰 추적/이슈 로깅)가 모두 누락된다.
> 반드시 `bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' {mcp_profile}`을 통해 실행해야 한다.

> **[금지] 슬림 래퍼 워커가 코드를 직접 읽거나 수정하면 안 된다.**
> codex-worker는 반드시 tfx-route.sh를 통해 Codex에 위임하고, gemini-worker도 마찬가지다.
> 워커가 Read, Edit, Write, Grep, Glob 등 도구를 직접 사용하는 것은 위임 구조 위반이다.
> 이는 tfx-route.sh의 MCP 필터, 모델 지정, bridge 연동, 토큰 추적을 모두 우회하는 것이므로
> 어떤 경우에도 허용하지 않는다. 워커가 이 규칙을 위반하면 작업 실패로 간주한다.

**Bash timeout 동적 상속:** Bash timeout은 tfx-route.sh의 role/profile별 timeout + 60초 여유를 ms로 변환하여 동적 상속한다. `getRouteTimeout(role, mcpProfile)` 기준: analyze/review 프로필 또는 architect/analyst 역할은 3600초, 그 외 기본 1080초(18분).

**핵심 차이 vs v2:** 프롬프트 ~100 토큰 (v2의 ~500), task claim/complete/report는 tfx-route.sh가 Named Pipe(우선)/HTTP(fallback) 경유로 수행. 래퍼가 N회 실행을 지원하므로 리드가 결과를 보고 방향을 수정할 수 있다.

#### 인터럽트 프로토콜

워커가 Bash 실행 전에 SendMessage로 시작을 보고하면 턴 경계가 생겨 리드가 방향 전환 메시지를 보낼 수 있다.

```
1. TaskUpdate(taskId, status: in_progress) — task claim
2. SendMessage(to: team-lead, "작업 시작: {agentName}") — 시작 보고 (턴 경계 생성)
3. Bash(command: tfx-route.sh ..., timeout: {bashTimeoutMs}) — 실행
4. SendMessage(to: team-lead, "결과: {요약}") — 결과 보고 (턴 경계 생성)
5. 리드 피드백 대기 — 피드백 수신 시 Step 3으로 돌아가 재실행
6. 최종 완료 시 TaskUpdate(status: completed, metadata: {result}) + SendMessage → 종료
```

리드는 워커의 Step 2, Step 4 시점에 턴 경계를 인식하고, 방향 전환/추가 지시/재실행 요청을 보낼 수 있다.

`tfx-route.sh` 팀 통합 동작(이미 구현됨, `TFX_TEAM_*` 기반):
- `TFX_TEAM_NAME`: 팀 식별자
- `TFX_TEAM_TASK_ID`: 작업 식별자
- `TFX_TEAM_AGENT_NAME`: 워커 표기 이름
- `TFX_TEAM_LEAD_NAME`: 리드 수신자 이름 (기본 `team-lead`)

Hub 통신 (Named Pipe 우선, HTTP fallback):
- `bridge.mjs`가 Named Pipe(`\\.\pipe\triflux-{pid}`) 우선 연결, 실패 시 HTTP `/bridge/*` fallback
- 실행 시작: `node hub/bridge.mjs team-task-update --team {name} --task-id {id} --claim --status in_progress`
- 실행 종료: `node hub/bridge.mjs team-task-update --team {name} --task-id {id} --status completed|failed`
- 리드 보고: `node hub/bridge.mjs team-send-message --team {name} --from {agent} --to team-lead --text "..."`
- 결과 발행: `node hub/bridge.mjs result --agent {id} --topic task.result --file {output}`

#### Step 3d: claude 타입만 Agent 직접 실행

`cli == claude`인 서브태스크에만 `Agent(subagent_type)`를 사용한다.

```
Agent({
  name: "claude-worker-{n}",
  team_name: teamName,
  description: "claude-worker-{n}",
  mode: "bypassPermissions",
  run_in_background: true,
  subagent_type: "{role}",
  prompt: "너는 {teamName}의 Claude 워커이다.

1. TaskGet 후 TaskUpdate(status: in_progress, owner: 너의 이름)로 claim
2. 도구를 직접 사용해 작업 수행
3. 성공 시 TaskUpdate(status: completed, metadata: {result: 'success'}) + SendMessage(to: team-lead)
4. 실패 시 TaskUpdate(status: completed, metadata: {result: 'failed', error: '에러 요약'}) + SendMessage(to: team-lead)

중요: status는 'completed'만 사용. 'failed'는 API 미지원. 실패 여부는 metadata.result로 구분.
어떤 경우에도 TaskUpdate + SendMessage 후 반드시 종료하라."
})
```

#### Step 3e: 사용자 안내

```
"팀 '{teamName}' 생성 완료.
Codex/Gemini 워커가 슬림 래퍼 Agent로 네비게이션에 등록되었습니다.
Shift+Down으로 다음 워커로 전환 (마지막→리드 wrap). Shift+Tab으로 이전 워커 전환."
```

### Phase 3.5–3.7: Verify/Fix Loop (`--thorough` 전용)

> `--quick`(기본) 모드에서는 이 단계를 건너뛰고 Phase 4로 직행한다.
> `--thorough` 모드에서만 실행된다.

```
Phase 3.5: Verify (Codex review)
  1. pipeline advance: exec → verify
  2. Codex verifier로 결과 검증:
     bash ~/.claude/scripts/tfx-route.sh verifier "결과 검증: ${task}" review
     — verifier는 Codex --profile thorough review로 실행됨
  3. 검증 결과를 파이프라인 artifact에 저장:
     pipeline.setArtifact('verify_report', verifyOutputPath)
  4. 통과 → pipeline advance: verify → complete → Phase 5 (cleanup)
  5. 실패 → Phase 3.6

Phase 3.6: Fix (Codex executor, max 3회)
  1. pipeline advance: verify → fix
     — fix_attempt 자동 증가, fix_max(3) 초과 시 전이 거부
  2. fix_attempt > fix_max → Phase 3.7 (ralph loop) 또는 failed 보고 → Phase 5
  3. Codex executor로 실패 항목 수정:
     bash ~/.claude/scripts/tfx-route.sh executor "실패 항목 수정: ${failedItems}" implement
  4. pipeline advance: fix → exec (재실행)
  5. → Phase 3 (exec) → Phase 3.5 (verify) 재실행

Phase 3.7: Ralph Loop (fix 3회 초과 시)
  1. ralph_iteration 증가 (pipeline.restart())
  2. ralph_iteration > ralph_max(10) → 최종 failed → Phase 5
  3. fix_attempt 리셋, 전체 파이프라인 재시작 (Phase 2.5 plan부터)
```

### Phase 4: 결과 수집 (truth source = team_task_list)

1. 리드가 Step 3c에서 실행한 모든 백그라운드 Bash 프로세스 완료를 대기한다.
2. `team_task_list`를 최종 truth source로 조회한다.

```bash
Bash("node hub/bridge.mjs team-task-list --team ${teamName}")
```

3. `completed` 상태이지만 `metadata.result == "failed"`인 task가 있으면 Claude fallback으로 재시도한다.
4. 재시도 후 다시 `team_task_list`를 조회해 최종 상태를 확정한다.
5. `send-message`와 `result(task.result)` 이벤트는 진행 관찰 채널로 사용하고, 최종 판정은 반드시 `team_task_list` 기준으로 한다.
6. Hub `task-update`에서는 `status: "failed"`를 그대로 사용한다 (Hub API는 자체 상태 관리). Claude Code `TaskUpdate`만 `"completed"` + `metadata.result`로 구분한다.

종합 보고서 예시:
```markdown
## tfx-multi 실행 결과

| # | Worker | CLI | 작업 | 상태 |
|---|--------|-----|------|------|
| 1 | codex-worker-1 | codex | 인증 리팩터링 | completed |
| 2 | gemini-worker-1 | gemini | UI 개선 | completed |
| 3 | claude-worker-1 | claude | 실패 fallback 재시도 | completed |
```

### Phase 5: 정리 (반드시 실행)

> **[필수] Phase 5는 성공/실패에 관계없이 반드시 실행해야 한다.**
> 워커 실패, Bash 에러, fallback 실패 등 어떤 상황에서도 TeamDelete를 건너뛰면 안 된다.
> TeamDelete를 하지 않으면 `~/.claude/teams/{teamName}/`이 잔존하여 OMC hook이 "team executing"을
> 반복 감지하는 무한 루프에 빠진다.

정리 순서:
1. 모든 백그라운드 Agent 완료를 **최대 30초** 대기한다.
2. 30초 후에도 미완료 Agent가 있으면 대기를 중단하고 정리를 진행한다.
3. `TeamDelete()`를 호출한다.
4. TeamDelete가 실패하면 (활성 멤버 잔존) `forceCleanupTeam(teamName)`으로 강제 정리한다.
   이것도 실패하면 수동 정리를 안내한다:
   ```
   rm -rf ~/.claude/teams/{teamName}/ ~/.claude/tasks/{teamName}/
   ```
5. 종합 보고서를 출력한다.

### Phase 3-mux: 레거시 psmux/tmux 모드
`--tmux` 또는 `--psmux` 플래그 시 pane 기반 실행. `detectMultiplexer()`가 psmux → tmux → wsl-tmux → git-bash-tmux 순으로 자동 감지.
Windows에서는 **psmux가 1순위** (ADR-001).

Bash("node {PKG_ROOT}/bin/triflux.mjs multi --no-attach --agents {agents} \\\"{task}\\\"")
이후 사용자에게 세션 연결 안내.

## 에이전트 매핑
> 에이전트 매핑: codex/gemini → tfx-route.sh, claude → Agent(subagent_type) 직접 실행. 상세는 Phase 3c/3d 참조.

## 전제 조건

- **CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1** — settings.json env에 설정 (`tfx setup`이 자동 설정)
- **codex/gemini CLI** — 해당 에이전트 사용 시
- **tfx setup** — tfx-route.sh 동기화 + AGENT_TEAMS 자동 설정 (사전 실행 권장)
- **Hub 활성 상태** — Named Pipe(`\\.\pipe\triflux-{pid}`) 우선, HTTP `127.0.0.1:27888` fallback. `bridge.mjs`가 자동 선택. Hub 미실행 시 nativeProxy fallback.
- **멀티플렉서** — psmux(Windows 1순위) / tmux / wsl-tmux / git-bash-tmux 자동 감지 (`--tmux`/`--psmux` 모드)
- **출력 정책** — preflight는 비동기/요약 출력이 기본이며, 실패 시에만 상세 출력

## 에러 처리

| 에러 | 처리 |
|------|------|
| TeamCreate 실패 / Agent Teams 비활성 | `--psmux/--tmux` 폴백 (Phase 3-mux로 전환) |
| tfx-route.sh 없음 | `tfx setup` 실행 안내 |
| CLI 미설치 (codex/gemini) | 해당 서브태스크를 claude 워커로 대체 |
| Codex 분류 실패 | Opus 직접 분류+분해 |
| Bash 실행 실패 (Lead) | task를 `completed` + `metadata.result: "failed"`로 마킹 후 Claude fallback 재시도 |
| `team_task_list` 조회 실패 | Named Pipe/stdout로 임시 관찰 후 Hub 복구 뒤 상태 재검증 |
| claude fallback 실패 | 실패 task 목록/원인 요약 후 사용자 승인 대기 |

> **[중요] TaskUpdate 상태값 제약:** Claude Code API는 `pending`, `in_progress`, `completed`, `deleted`만 지원한다.
> `failed` 상태는 존재하지 않으므로 절대 사용하지 마라. 실패는 `status: "completed"` + `metadata: {result: "failed"}`로 표현한다.
> Hub API(`bridge.mjs team-task-update`)는 자체 상태 관리이므로 `"failed"` 사용 가능.

## 관련

| 항목 | 설명 |
|------|------|
| `scripts/tfx-route.sh` | 팀 통합 라우터 (`TFX_TEAM_*`, task claim/complete, send-message, Named Pipe/HTTP bridge) |
| `hub/team/native.mjs` | Native Teams 래퍼 (프롬프트 템플릿, 팀 설정 빌더) |
| `hub/team/cli/index.mjs` | tmux 팀 CLI 라우터 (`hub/team/cli/` 서브커맨드 구조) |
| `hub/pipeline/` | 파이프라인 상태 기계 (transitions, state, index) — `--thorough` 모드 |
| `tfx-auto` | one-shot 실행 오케스트레이터 (병행 유지) |
| `tfx-hub` | MCP 메시지 버스 관리 (tmux 모드용) |
