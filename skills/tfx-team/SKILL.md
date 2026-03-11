---
name: tfx-team
description: 멀티-CLI 팀 모드. Claude Native Agent Teams + Codex/Gemini 멀티모델 오케스트레이션.
triggers:
  - tfx-team
argument-hint: '"작업 설명" | --agents codex,gemini "작업" | --tmux "작업" | status | stop'
---

# tfx-team v2.2 — 슬림 래퍼 + 네비게이션 복원 기반 멀티-CLI 팀 오케스트레이터

> Claude Code Native Teams의 Shift+Down 네비게이션을 복원한다.
> Codex/Gemini 워커마다 최소 프롬프트(~100 토큰)의 슬림 Agent 래퍼를 spawn하여 네비게이션에 등록하고,
> 실제 작업은 `tfx-route.sh`가 수행한다. task 상태는 `team_task_list`를 truth source로 검증한다.
> v2.2 현재 — 슬림 래퍼 Agent로 Shift+Down 네비게이션 복원, Opus 토큰 77% 절감.

## 사용법

```
/tfx-team "인증 리팩터링 + UI 개선 + 보안 리뷰"
/tfx-team --agents codex,gemini "프론트+백엔드"
/tfx-team --tmux "작업"         # 레거시 tmux 모드
/tfx-team status
/tfx-team stop
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

```
입력: "3:codex 리뷰"         → 수동 모드: N=3, agent=codex
입력: "인증 + UI + 테스트"    → 자동 모드: Codex 분류 → Opus 분해
입력: "--tmux 인증 + UI"     → tmux 레거시 모드 → Phase 3-tmux로 분기
입력: "status"               → 제어 커맨드
입력: "stop"                 → 제어 커맨드
```

**제어 커맨드 감지:**
- `status`, `stop`, `kill`, `attach`, `list`, `send` → `Bash("node bin/triflux.mjs team {cmd}")` 직행
  (`bin/triflux.mjs` 절대경로는 triflux 패키지 루트 기준)
- 그 외 → Phase 2 트리아지

**--tmux 감지:** 입력에 `--tmux`가 포함되면 Phase 3-tmux로 분기.

### Phase 2: 트리아지 (tfx-auto와 동일)

#### 자동 모드 — Codex 분류 → Opus 분해

```bash
# Step 2a: Codex 분류 (무료)
Bash("codex exec --full-auto --skip-git-repo-check '다음 작업을 분석하고 각 부분에 적합한 agent를 분류하라.

  agent 선택:
  - codex: 코드 구현/수정/분석/리뷰/디버깅/설계 (기본값)
  - gemini: 문서/UI/디자인/멀티모달
  - claude: 코드베이스 탐색/테스트 실행/검증 (최후 수단)

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

### Phase 3: Native Teams 실행 (v2.1 개편)

트리아지 결과를 Claude Code 네이티브 Agent Teams로 실행한다.

#### Step 3a: 팀 생성

```
teamName = "tfx-" + Date.now().toString(36).slice(-6)

TeamCreate({
  team_name: teamName,
  description: "tfx-team: {원본 작업 요약}"
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

> **[필수] Codex/Gemini 서브태스크는 워커 수에 관계없이 반드시 Agent 래퍼를 spawn해야 한다.**
> 단일 워커(1:gemini 등)여도 Lead가 직접 Bash를 실행하면 안 된다.
> Agent 래퍼를 생략하면 Shift+Down 네비게이션에 워커가 등록되지 않아 v2.2의 핵심 가치가 사라진다.
> Lead가 "효율적"이라고 판단해서 Agent를 건너뛰는 것은 금지한다.

Codex/Gemini 서브태스크마다 최소 프롬프트의 Agent를 spawn하여 네비게이션에 등록한다.
Agent 내부에서 `Bash(tfx-route.sh)` 1회 실행 후 결과 보고하고 종료한다.

```
for each item in runQueue where item.cli in ["codex", "gemini"]:
  Agent({
    name: item.agentName,
    team_name: teamName,
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
핵심 동작: Bash 1회 실행(tfx-route.sh) → TaskUpdate(completed) + SendMessage → 종료.
status는 "completed"만 사용. 실패 여부는 `metadata.result`로 구분.

> **[금지] Lead 또는 Agent 래퍼가 `gemini -y -p "..."` 또는 `codex exec "..."`를 직접 호출하면 안 된다.**
> 직접 호출하면 tfx-route.sh의 모델 지정(`-m gemini-3.1-pro-preview`), MCP 필터, 팀 bridge 연동,
> Windows 호환 경로, 타임아웃, 후처리(토큰 추적/이슈 로깅)가 모두 누락된다.
> 반드시 `bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' {mcp_profile}`을 통해 실행해야 한다.

**핵심 차이 vs v2:** 프롬프트 ~100 토큰 (v2의 ~500), task claim/complete/report는 tfx-route.sh Hub bridge가 수행.

`tfx-route.sh` 팀 통합 동작(이미 구현됨, `TFX_TEAM_*` 기반):
- `TFX_TEAM_NAME`: 팀 식별자
- `TFX_TEAM_TASK_ID`: 작업 식별자
- `TFX_TEAM_AGENT_NAME`: 워커 표기 이름
- `TFX_TEAM_LEAD_NAME`: 리드 수신자 이름 (기본 `team-lead`)

Bridge 연동:
- 실행 시작 시 `POST /bridge/team/task-update`로 `claim + in_progress`
- 실행 종료 시 `POST /bridge/team/task-update`로 `completed|failed`
- 리드 보고 `POST /bridge/team/send-message`
- 이벤트 채널 `POST /bridge/result` (`topic=task.result`) 발행

#### Step 3d: claude 타입만 Agent 직접 실행

`cli == claude`인 서브태스크에만 `Agent(subagent_type)`를 사용한다.

```
Agent({
  name: "claude-worker-{n}",
  team_name: teamName,
  description: "claude-worker-{n}",
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
Shift+Down으로 다음 워커 (마지막→리드 wrap), Shift+Tab으로 이전 워커 전환이 가능합니다.
(Shift+Up은 Claude Code 미지원 — 대부분 터미널에서 scroll-up으로 먹힘)"
```

### Phase 4: 결과 수집 (truth source = team_task_list)

1. 리드가 Step 3c에서 실행한 모든 백그라운드 Bash 프로세스 완료를 대기한다.
2. `team_task_list`를 최종 truth source로 조회한다.

```bash
Bash("curl -sf http://127.0.0.1:27888/bridge/team/task-list -H \"Content-Type: application/json\" -d \"{\\\"team_name\\\":\\\"${teamName}\\\"}\"")
```

3. `completed` 상태이지만 `metadata.result == "failed"`인 task가 있으면 Claude fallback으로 재시도한다.
4. 재시도 후 다시 `team_task_list`를 조회해 최종 상태를 확정한다.
5. `send-message`와 `/bridge/result(task.result)` 이벤트는 진행 관찰 채널로 사용하고, 최종 판정은 반드시 `team_task_list` 기준으로 한다.
6. Hub bridge의 `task-update`에서는 `status: "failed"`를 그대로 사용한다 (Hub API는 자체 상태 관리). Claude Code `TaskUpdate`만 `"completed"` + `metadata.result`로 구분한다.

종합 보고서 예시:
```markdown
## tfx-team 실행 결과

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
4. TeamDelete가 실패하면 (활성 멤버 잔존) 수동 정리를 안내한다:
   ```
   rm -rf ~/.claude/teams/{teamName}/ ~/.claude/tasks/{teamName}/
   ```
5. 종합 보고서를 출력한다.

### Phase 3-tmux: 레거시 tmux 모드
--tmux 플래그 시 기존 v1 방식으로 실행: Bash("node {PKG_ROOT}/bin/triflux.mjs team --no-attach --agents {agents} \\\"{task}\\\"")
이후 사용자에게 tmux 세션 연결 안내.

## 에이전트 매핑
> 에이전트 매핑: codex/gemini → tfx-route.sh, claude → Agent(subagent_type) 직접 실행. 상세는 Phase 3c/3d 참조.

## 전제 조건

- **CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1** — settings.json env에 설정 (`tfx setup`이 자동 설정)
- **codex/gemini CLI** — 해당 에이전트 사용 시
- **tfx setup** — tfx-route.sh 동기화 + AGENT_TEAMS 자동 설정 (사전 실행 권장)
- **Hub bridge 활성 상태** — 기본 `http://127.0.0.1:27888` (`/bridge/team/*`, `/bridge/result` 사용)
- **출력 정책** — preflight는 비동기/요약 출력이 기본이며, 실패 시에만 상세 출력

## 에러 처리

| 에러 | 처리 |
|------|------|
| TeamCreate 실패 / Agent Teams 비활성 | `--tmux` 폴백 (Phase 3-tmux로 전환) |
| tfx-route.sh 없음 | `tfx setup` 실행 안내 |
| CLI 미설치 (codex/gemini) | 해당 서브태스크를 claude 워커로 대체 |
| Codex 분류 실패 | Opus 직접 분류+분해 |
| Bash 실행 실패 (Lead) | task를 `completed` + `metadata.result: "failed"`로 마킹 후 Claude fallback 재시도 |
| `team_task_list` 조회 실패 | `/bridge/result`/stdout로 임시 관찰 후 bridge 복구 뒤 상태 재검증 |
| claude fallback 실패 | 실패 task 목록/원인 요약 후 사용자 승인 대기 |

> **[중요] TaskUpdate 상태값 제약:** Claude Code API는 `pending`, `in_progress`, `completed`, `deleted`만 지원한다.
> `failed` 상태는 존재하지 않으므로 절대 사용하지 마라. 실패는 `status: "completed"` + `metadata: {result: "failed"}`로 표현한다.
> Hub bridge API(`/bridge/team/task-update`)는 자체 상태 관리이므로 `"failed"` 사용 가능.

## 관련

| 항목 | 설명 |
|------|------|
| `scripts/tfx-route.sh` | 팀 통합 라우터 (`TFX_TEAM_*`, task claim/complete, send-message, `/bridge/result`) |
| `hub/team/native.mjs` | Native Teams 래퍼 (프롬프트 템플릿, 팀 설정 빌더) |
| `hub/team/cli.mjs` | tmux 팀 CLI (`--tmux` 레거시 모드) |
| `tfx-auto` | one-shot 실행 오케스트레이터 (병행 유지) |
| `tfx-hub` | MCP 메시지 버스 관리 (tmux 모드용) |
