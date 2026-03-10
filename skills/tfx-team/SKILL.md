---
name: tfx-team
description: 멀티-CLI 팀 모드. Claude Native Agent Teams + Codex/Gemini 멀티모델 오케스트레이션.
triggers:
  - tfx-team
argument-hint: '"작업 설명" | --agents codex,gemini "작업" | --tmux "작업" | status | stop'
---

# tfx-team v2 — Claude Native Teams 기반 멀티-CLI 팀 오케스트레이터

> Claude Code의 네이티브 Agent Teams (in-process 모드)를 활용하여
> tmux 없이 현재 터미널에서 Codex/Gemini/Claude 멀티모델 팀을 구성한다.
> 각 teammate는 Claude Code 인스턴스이지만 Codex/Gemini CLI **래퍼**로 동작하여 토큰을 최소화한다.

| | tfx-auto | tfx-team v1 (tmux) | **tfx-team v2 (native)** |
|--|----------|--------------------|-----------------------------|
| 트리아지 | Codex 분류 → Opus 분해 | 동일 | **동일** |
| 실행 | tfx-route.sh one-shot | tmux pane interactive | **Native Teams in-process** |
| 관찰 | stdout 반환 | Ctrl+B 방향키 | **Shift+Down teammate 전환** |
| 통신 | 없음 | Hub MCP 버스 | **내장 Mailbox + Task List** |
| 개입 | 불가 | tfx team send | **SendMessage** |
| tmux 필요 | ✗ | ✓ | **✗** |

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

### Phase 3: Native Teams 실행

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

각 서브태스크에 대해 TaskCreate를 호출한다:

```
for each assignment in assignments:
  TaskCreate({
    subject: assignment.subtask,
    description: "CLI: {assignment.cli}, 역할: {assignment.role}\n\n{상세 작업 내용}",
    metadata: { cli: assignment.cli, role: assignment.role }
  })
```

#### Step 3c: Teammate 스폰

**Agent 도구**에 `team_name`과 `name` 파라미터를 전달하여 teammate를 생성한다.
**모든 teammate를 `run_in_background: true`로 병렬 스폰한다.**

각 CLI 타입별 teammate 프롬프트:

**codex-worker (Codex CLI 래퍼):**

```
Agent({
  name: "codex-worker-{n}",
  team_name: teamName,
  description: "codex-worker-{n}",
  run_in_background: true,
  prompt: "너는 {teamName}의 Codex 워커이다.

[실행 규칙]
1. TaskList를 호출하여 너에게 배정된 pending 작업을 확인하라
2. TaskGet으로 작업 상세를 읽고, TaskUpdate(status: in_progress, owner: 너의 이름)로 claim
3. Bash(\"bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' auto\")로 실행
4. 결과를 확인하고:
   - 성공: TaskUpdate(status: completed) + SendMessage(type: message, recipient: team-lead, summary: '작업 완료')
   - 실패: TaskUpdate에 에러 기록 + SendMessage로 리드에게 보고
5. TaskList를 다시 확인하고 추가 pending 작업이 있으면 반복

[규칙]
- 실제 구현은 Codex CLI가 수행 — 너는 실행+보고 역할만
- tfx-route.sh 결과를 그대로 보고하라 (요약하지 말 것)"
})
```

**gemini-worker (Gemini CLI 래퍼):**

```
Agent({
  name: "gemini-worker-{n}",
  team_name: teamName,
  description: "gemini-worker-{n}",
  run_in_background: true,
  prompt: "너는 {teamName}의 Gemini 워커이다.

[실행 규칙]
1. TaskList를 호출하여 너에게 배정된 pending 작업을 확인하라
2. TaskGet으로 작업 상세를 읽고, TaskUpdate(status: in_progress, owner: 너의 이름)로 claim
3. Bash(\"bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' auto\")로 실행
4. 결과를 확인하고:
   - 성공: TaskUpdate(status: completed) + SendMessage(type: message, recipient: team-lead, summary: '작업 완료')
   - 실패: TaskUpdate에 에러 기록 + SendMessage로 리드에게 보고
5. TaskList를 다시 확인하고 추가 pending 작업이 있으면 반복

[규칙]
- 실제 구현은 Gemini CLI가 수행 — 너는 실행+보고 역할만
- tfx-route.sh 결과를 그대로 보고하라 (요약하지 말 것)"
})
```

**claude-worker (직접 실행):**

```
Agent({
  name: "claude-worker-{n}",
  team_name: teamName,
  description: "claude-worker-{n}",
  run_in_background: true,
  prompt: "너는 {teamName}의 Claude 워커이다.

[실행 규칙]
1. TaskList를 호출하여 너에게 배정된 pending 작업을 확인하라
2. TaskGet으로 작업 상세를 읽고, TaskUpdate(status: in_progress, owner: 너의 이름)로 claim
3. Glob, Grep, Read, Bash 등 도구를 직접 사용하여 작업 수행
4. 완료 시 TaskUpdate(status: completed) + SendMessage(type: message, recipient: team-lead, summary: '작업 완료')
5. TaskList를 다시 확인하고 추가 pending 작업이 있으면 반복

에러 시 TaskUpdate + SendMessage로 리드에게 보고."
})
```

#### Step 3d: 사용자 안내

```
"팀 '{teamName}' 생성 완료 ({N}명의 teammate).
Shift+Down으로 각 teammate의 진행 상황을 확인할 수 있습니다."
```

### Phase 4: 결과 수집

리드(이 오케스트레이터)가:
1. teammate들의 SendMessage를 자동 수신 (폴링 불필요 — 자동 배달됨)
2. 모든 teammate가 결과를 보고하면 TaskList로 전체 상태 확인
3. 모든 작업이 completed이면 종합 보고서 출력:

```markdown
## tfx-team 실행 결과

| # | Teammate | CLI | 작업 | 상태 |
|---|----------|-----|------|------|
| 1 | codex-worker-1 | codex | 인증 리팩터링 | ✓ completed |
| 2 | gemini-worker-1 | gemini | UI 개선 | ✓ completed |
| 3 | codex-worker-2 | codex | 보안 리뷰 | ✓ completed |
```

### Phase 5: 정리

```
# 각 teammate에 shutdown 요청
for each teammate in teammates:
  SendMessage({
    type: "shutdown_request",
    recipient: teammate.name,
    content: "모든 작업 완료. 종료합니다."
  })

# 모든 teammate 종료 후 팀 삭제
TeamDelete()
```

> **중요:** TeamDelete는 활성 멤버가 있으면 실패한다. 반드시 모든 teammate에 shutdown_request를 보내고 종료를 확인한 후 호출.

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

| 분류 결과 | CLI | teammate 역할 | 실행 방법 |
|----------|-----|--------------|----------|
| codex | codex | Codex CLI 래퍼 | `tfx-route.sh {role} '{task}' auto` via Bash |
| gemini | gemini | Gemini CLI 래퍼 | `tfx-route.sh {role} '{task}' auto` via Bash |
| claude | claude | 직접 실행 | Glob/Grep/Read/Bash 직접 사용 |

> **핵심 아이디어:** Claude teammate = Codex/Gemini 실행 래퍼
> - Native Teams 인프라 (in-process, Task List, Mailbox) 활용
> - 실제 작업은 Codex/Gemini가 수행 (비용 최소화)
> - teammate의 Claude 토큰은 "실행+보고" 래퍼 역할에만 소비

## 전제 조건

- **CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1** — settings.json env에 설정 (`tfx setup`이 자동 설정)
- **codex/gemini CLI** — 해당 에이전트 사용 시
- **tfx setup** — tfx-route.sh 동기화 + AGENT_TEAMS 자동 설정 (사전 실행 권장)

## 에러 처리

| 에러 | 처리 |
|------|------|
| TeamCreate 실패 / Agent Teams 비활성 | `--tmux` 폴백 (Phase 3-tmux로 전환) |
| tfx-route.sh 없음 | `tfx setup` 실행 안내 |
| CLI 미설치 (codex/gemini) | 해당 서브태스크를 claude 워커로 대체 |
| Codex 분류 실패 | Opus 직접 분류+분해 |
| teammate 실행 에러 | TaskUpdate(status: failed) + SendMessage로 리드에게 보고 |
| teammate shutdown 거부 | 재시도 1회, 이후 사용자에게 보고 |

## 관련

| 항목 | 설명 |
|------|------|
| `hub/team/native.mjs` | Native Teams 래퍼 (프롬프트 템플릿, 팀 설정 빌더) |
| `hub/team/cli.mjs` | tmux 팀 CLI (`--tmux` 레거시 모드) |
| `tfx-auto` | one-shot 실행 오케스트레이터 (병행 유지) |
| `tfx-hub` | MCP 메시지 버스 관리 (tmux 모드용) |
