---
name: tfx-team
description: 멀티-CLI 팀 모드. Claude Native Agent Teams + Codex/Gemini 멀티모델 오케스트레이션.
triggers:
  - tfx-team
argument-hint: '"작업 설명" | --agents codex,gemini "작업" | --tmux "작업" | status | stop'
---

# tfx-team v2.1 — Lead Direct Bash 기반 멀티-CLI 팀 오케스트레이터

> Claude Code Native Teams는 유지하되, Codex/Gemini 실행 경로에서 Claude teammate 래퍼를 제거한다.
> 리드가 `tfx-route.sh`를 직접 병렬 실행하고, task 상태는 `team_task_list`를 truth source로 검증한다.

| 구분 | v2 (기존) | v2.1 (현재) |
|--|--|--|
| 실행 | `Agent(teammate)` → `Bash(tfx-route.sh)` | `Lead` → `Bash(tfx-route.sh)` 직접 |
| teammate | Claude Opus 인스턴스 × N | Codex/Gemini용 없음 |
| task claim | teammate가 `TaskUpdate` 호출 | `tfx-route.sh`가 Hub bridge로 claim |
| 결과 보고 | teammate가 `SendMessage` 호출 | `tfx-route.sh`가 Hub bridge로 `send-message` 호출 |
| 결과 수집 | SendMessage 자동 수신 중심 | `team_task_list` 폴링 + stdout/결과 로그 |
| 정리 | `shutdown_request` × N 후 `TeamDelete` | `TeamDelete` 직접 |
| Opus 토큰 | N × 래퍼 오버헤드 | 래퍼 오버헤드 0 |

## 사용법

```
/tfx-team "인증 리팩터링 + UI 개선 + 보안 리뷰"
/tfx-team --agents codex,gemini "프론트+백엔드"
/tfx-team --tmux "작업"         # 레거시 tmux 모드
/tfx-team status
/tfx-team stop
```

## 실행 워크플로우

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

#### Step 3c: 리드가 직접 Bash 병렬 실행 (teammate 스폰 제거)

Codex/Gemini 서브태스크는 teammate를 만들지 않고, 리드가 직접 `Bash(..., run_in_background=true)`를 병렬 호출한다.

```
for each item in runQueue where item.cli in ["codex", "gemini"]:
  Bash(
    "TFX_TEAM_NAME={teamName} TFX_TEAM_TASK_ID={item.taskId} TFX_TEAM_AGENT_NAME={item.agentName} TFX_TEAM_LEAD_NAME=team-lead bash ~/.claude/scripts/tfx-route.sh {item.role} \"{item.subtask}\" {mcp_profile}",
    run_in_background=true
  )
```

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
3. 성공 시 TaskUpdate(status: completed) + SendMessage(to: team-lead)
4. 실패 시 TaskUpdate(status: failed) + SendMessage(to: team-lead)"
})
```

#### Step 3e: 사용자 안내

```
"팀 '{teamName}' 생성 완료.
Codex/Gemini 작업은 리드가 백그라운드 Bash로 병렬 실행 중이며,
claude 작업만 teammate로 실행됩니다."
```

### Phase 4: 결과 수집 (truth source = team_task_list)

1. 리드가 Step 3c에서 실행한 모든 백그라운드 Bash 프로세스 완료를 대기한다.
2. `team_task_list`를 최종 truth source로 조회한다.

```bash
Bash("curl -sf http://127.0.0.1:27888/bridge/team/task-list -H \"Content-Type: application/json\" -d \"{\\\"team_name\\\":\\\"${teamName}\\\"}\"")
```

3. 상태가 `failed`인 task가 있으면 Claude fallback으로 재시도한다.
4. 재시도 후 다시 `team_task_list`를 조회해 최종 상태를 확정한다.
5. `send-message`와 `/bridge/result(task.result)` 이벤트는 진행 관찰 채널로 사용하고, 최종 판정은 반드시 `team_task_list` 기준으로 한다.

종합 보고서 예시:
```markdown
## tfx-team 실행 결과

| # | Worker | CLI | 작업 | 상태 |
|---|--------|-----|------|------|
| 1 | codex-worker-1 | codex | 인증 리팩터링 | completed |
| 2 | gemini-worker-1 | gemini | UI 개선 | completed |
| 3 | claude-worker-1 | claude | 실패 fallback 재시도 | completed |
```

### Phase 5: 정리 (간소화)

teammate 래퍼를 제거했으므로 `shutdown_request` 브로드캐스트를 사용하지 않는다.
정리 단계는 `TeamDelete()` 직접 호출로 마무리한다.

> **중요:** claude 타입 백그라운드 Agent가 아직 실행 중이면 `TeamDelete`가 실패할 수 있다. 해당 작업 완료를 확인한 뒤 삭제한다.

### Phase 3-tmux: 레거시 tmux 모드

`--tmux` 플래그가 있으면 기존 v1 방식으로 실행:

```bash
# PKG_ROOT: triflux 패키지 루트 (Bash로 확인)
Bash("node {PKG_ROOT}/bin/triflux.mjs team --no-attach --agents {agents.join(',')} \"{task}\"")
```

이후 Phase 4-5 대신 사용자에게 tmux 세션 안내:

```
"tmux 세션이 생성되었습니다.
  tmux attach -t {sessionId}     세션 연결
  Ctrl+B → 방향키               pane 전환
  Ctrl+B → D                    세션 분리
  Ctrl+B → Z                    pane 전체화면"
```

## 에이전트 매핑

| 분류 결과 | CLI | 역할 | 실행 방법 |
|----------|-----|------|----------|
| codex | codex | Lead 직접 라우팅 | `TFX_TEAM_* bash ~/.claude/scripts/tfx-route.sh {role} "{task}" {mcp_profile}` |
| gemini | gemini | Lead 직접 라우팅 | `TFX_TEAM_* bash ~/.claude/scripts/tfx-route.sh {role} "{task}" {mcp_profile}` |
| claude | claude | Claude 직접 실행 | `Agent(subagent_type={role})`로 직접 수행 |

> **핵심 아이디어:** Codex/Gemini 작업은 `tfx-route.sh`가 팀 상태 동기화까지 직접 수행한다.
> 리드는 오케스트레이션에 집중하고, Claude 토큰은 래퍼 오버헤드 없이 필요한 직접 실행(`claude` 타입)에만 사용한다.

## 전제 조건

- **CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1** — settings.json env에 설정 (`tfx setup`이 자동 설정)
- **codex/gemini CLI** — 해당 에이전트 사용 시
- **tfx setup** — tfx-route.sh 동기화 + AGENT_TEAMS 자동 설정 (사전 실행 권장)
- **Hub bridge 활성 상태** — 기본 `http://127.0.0.1:27888` (`/bridge/team/*`, `/bridge/result` 사용)

## 에러 처리

| 에러 | 처리 |
|------|------|
| TeamCreate 실패 / Agent Teams 비활성 | `--tmux` 폴백 (Phase 3-tmux로 전환) |
| tfx-route.sh 없음 | `tfx setup` 실행 안내 |
| CLI 미설치 (codex/gemini) | 해당 서브태스크를 claude 워커로 대체 |
| Codex 분류 실패 | Opus 직접 분류+분해 |
| Bash 실행 실패 (Lead) | task를 `failed`로 마킹 후 Claude fallback 재시도 |
| `team_task_list` 조회 실패 | `/bridge/result`/stdout로 임시 관찰 후 bridge 복구 뒤 상태 재검증 |
| claude fallback 실패 | 실패 task 목록/원인 요약 후 사용자 승인 대기 |

## 관련

| 항목 | 설명 |
|------|------|
| `scripts/tfx-route.sh` | 팀 통합 라우터 (`TFX_TEAM_*`, task claim/complete, send-message, `/bridge/result`) |
| `hub/team/native.mjs` | Native Teams 래퍼 (프롬프트 템플릿, 팀 설정 빌더) |
| `hub/team/cli.mjs` | tmux 팀 CLI (`--tmux` 레거시 모드) |
| `tfx-auto` | one-shot 실행 오케스트레이터 (병행 유지) |
| `tfx-hub` | MCP 메시지 버스 관리 (tmux 모드용) |
