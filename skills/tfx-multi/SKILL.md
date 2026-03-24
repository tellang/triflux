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
> v3 — `--thorough`(기본: plan→prd→exec→verify→fix loop) + `--quick`(경량 모드).

> **Lead 고토큰 MCP 직접 사용 금지**
> Lead(Claude Opus)는 웹 서치(brave-search, exa, tavily), 외부 서비스(Notion, Jira/Confluence, Calendar, Gmail),
> 대량 조회를 직접 호출하지 않는다. Codex `scientist`/`document-specialist` 워커에 위임하면 Claude 토큰을 절약할 수 있다.
> 단건 조회(이슈 1개 확인 등)는 Lead 직접 허용하되, 3회 이상 반복 호출 시 위임 전환.

## 사용법

```
/tfx-multi "인증 리팩터링 + UI 개선 + 보안 리뷰"           # --thorough (기본)
/tfx-multi --quick "인증 리팩터링 + UI 개선 + 보안 리뷰"    # 경량 모드 (plan/verify 생략)
/tfx-multi --agents codex,gemini "프론트+백엔드"
/tfx-multi --tmux "작업"         # 레거시 tmux 모드
/tfx-multi status
/tfx-multi stop
```

## 실행 워크플로우

### Phase 0: 사전 점검 (출력 최소화 + 즉시 spawn)

preflight와 Agent 생성을 병렬로 실행하여 사용자 체감 지연을 최소화한다.

- **수동 모드:** Phase 1 파싱 → Phase 3a~3c(TeamCreate + Agent spawn) + Phase 0(preflight) **동시 병렬**
- **자동 모드:** Phase 0(preflight) + Phase 2(triage) **동시 병렬** → Phase 3
- 리드에는 요약 한 줄만 노출. 예: `preflight: ok (route/hub)`
- 권장 체크: `curl -sf http://127.0.0.1:27888/status >/dev/null && test -f ~/.claude/scripts/tfx-route.sh && echo "preflight: ok" || echo "preflight: FAIL"`
- 실패 시에만 상세 노출 (tfx-route.sh 없음, Hub 비정상, CLI 미설치)

### Phase 1: 입력 파싱

인자 없이 호출되면 "어떤 작업을 실행할까요?" 등으로 입력 요청. TeamCreate/Agent spawn을 시작하지 않는다.

```
""(빈 문자열)          → 사용자에게 작업 입력 요청
"3:codex 리뷰"         → 수동 모드: N=3, agent=codex
"인증 + UI + 테스트"    → 자동 모드 (--thorough 기본): Codex 분류 → Opus 분해 → Pipeline
"--quick 인증 + UI"    → 경량 모드: plan/verify 생략, 즉시 실행
"--tmux 인증 + UI"     → Phase 3-mux 분기
"status" / "stop"      → Bash("node bin/triflux.mjs multi {cmd}") 직행
```

**모드 결정:**
- `--quick` 명시 → quick 모드 (Phase 2.5-2.6, 3.5-3.7 생략)
- `--thorough` 명시 또는 플래그 없음 → thorough 모드 (기본, 전체 파이프라인)
- 커맨드 숏컷 (tfx-auto 경유 단일 실행) → quick 유지 (오버헤드 불필요)

### Phase 2: 트리아지 (tfx-auto와 동일)

**자동 모드:**
1. Codex `--full-auto --skip-git-repo-check` 분류 → JSON `{parts: [{description, agent}]}`
2. Opus 인라인 분해 → 서브태스크 배열 `[{cli, subtask, role}]`
3. Codex 분류 실패 시 → Opus가 직접 분류+분해

**수동 모드:** Codex 분류 건너뜀 → Opus가 직접 N개 서브태스크 분해.

### Phase 2.5–2.6 + 3.5–3.7: 파이프라인 (기본)

> `--thorough`(기본) 모드에서 실행된다. `--quick` 플래그 시 건너뛴다.
> 상세는 → [`references/thorough-pipeline.md`](references/thorough-pipeline.md) 참조.

### Phase 3: Native Teams 실행

#### Step 3a: 팀 생성

```
teamName = "tfx-" + Date.now().toString(36).slice(-6)
TeamCreate({ team_name: teamName, description: "tfx-multi: {원본 작업 요약}" })
```

#### Step 3b: 공유 작업 등록

```
for each assignment (index i):
  TaskCreate({ subject: assignment.subtask, metadata: { cli, role } })
  agentName = "{cli}-worker-{i+1}"
```

#### Step 3c: 슬림 래퍼 Agent 실행

Codex/Gemini 서브태스크마다 슬림 래퍼 Agent를 spawn하여 Shift+Down 네비게이션에 등록한다.
래퍼 내부에서 `tfx-route.sh`로 CLI를 실행하고, 리드 피드백을 받아 재실행하는 구조이다.

```
for each item where item.cli in ["codex", "gemini"]:
  Agent({
    name: item.agentName,
    team_name: teamName,
    mode: "bypassPermissions",
    run_in_background: true,
    prompt: buildSlimWrapperPrompt(item.cli, { subtask, role, teamName, taskId, agentName, leadName: "team-lead", mcp_profile })
  })
```

슬림 래퍼 프롬프트의 단일 truth source: `hub/team/native.mjs`의 `buildSlimWrapperPrompt()`.
핵심 동작: Bash(tfx-route.sh) → SendMessage(보고) → 피드백 대기 → 재실행(N회) → TaskUpdate(completed) → 종료.

**핵심 규칙 요약:**
- Agent 래퍼 생략 금지 — 단일 워커도 반드시 Agent로 spawn (네비게이션 등록)
- `mode: "bypassPermissions"` 필수 — 모든 Agent에 포함
- `tfx-route.sh` 경유 필수 — 직접 `codex exec`/`gemini -y -p` 호출 금지
- 코드 직접 조작 금지 — 워커가 Read/Edit/Write 등 도구 직접 사용 금지

> 래퍼 규칙의 상세 이유와 인터럽트 프로토콜 → [`references/agent-wrapper-rules.md`](references/agent-wrapper-rules.md) 참조.

#### Step 3d: claude 타입만 Agent 직접 실행

```
Agent({
  name: "claude-worker-{n}", team_name: teamName, mode: "bypassPermissions",
  run_in_background: true, subagent_type: "{role}",
  prompt: "TaskGet → TaskUpdate(in_progress) → 작업 수행 → TaskUpdate(completed, metadata: {result}) + SendMessage(to: team-lead)"
})
```

status는 "completed"만 사용. 실패 여부는 `metadata.result`로 구분.

#### Step 3e: 사용자 안내

"팀 생성 완료. Shift+Down으로 워커 전환, Shift+Tab으로 이전 워커."

### Phase 4: 결과 수집

`team_task_list`가 최종 truth source: `Bash("node hub/bridge.mjs team-task-list --team ${teamName}")`
- `metadata.result == "failed"` → Claude fallback 재시도
- Hub `task-update`에서는 `"failed"` 사용 가능. Claude Code `TaskUpdate`만 `"completed"` + `metadata.result`로 구분.

### Phase 5: 정리 (반드시 실행)

성공/실패에 관계없이 반드시 실행. TeamDelete를 건너뛰면 `~/.claude/teams/{teamName}/`이 잔존하여 무한 루프 발생.

1. 백그라운드 Agent 완료를 **최대 30초** 대기
2. `TeamDelete()` 호출
3. 실패 시 `forceCleanupTeam(teamName)` → 그래도 실패 시 `rm -rf ~/.claude/teams/{teamName}/` 안내
4. 종합 보고서 출력

### Phase 3-direct: Lead-Direct Headless 실행 (v6.0.0, 기본)

CLI 워커(Codex/Gemini/Claude)를 Agent 래퍼 없이 Lead가 headless.mjs로 직접 실행.
Windows Terminal에 psmux 세션이 자동 팝업되어 사용자가 실시간으로 CLI 출력을 확인.

**핵심 기능:**
- `progressive: true` (기본) — pane이 하나씩 split-window로 추가 (실시간 스플릿)
- `autoAttach: true` — 세션 생성 즉시 Windows Terminal 자동 팝업
- `progressIntervalSec` — N초마다 각 pane 스냅샷을 onProgress로 전달
- `applyTrifluxTheme()` — status bar + pane border 테마 자동 적용
- 피드백 재실행 — 같은 pane에 후속 명령 dispatch (세션 유지)

**Lead 오케스트레이션 패턴:**

```javascript
// headless.mjs의 runHeadlessInteractive()를 Bash 내에서 호출
// Lead는 Bash의 결과를 직접 파싱 — Agent 래퍼 불필요
const handle = await runHeadlessInteractive("tfx-session", [
  { cli: "codex", prompt: "코드 리뷰", role: "reviewer" },
  { cli: "gemini", prompt: "문서 작성", role: "writer" },
  { cli: "claude", prompt: "테스트 실행", role: "tester" },
], {
  timeoutSec: 300,
  autoAttach: true,          // WT 자동 팝업
  progressive: true,         // 실시간 스플릿 (기본)
  progressIntervalSec: 10,   // 10초마다 진행 스냅샷
});
// handle: { results, dispatch(), capture(), snapshots(), waitFor(), kill() }
```

**결정 로직:**
```
Phase 3 선택:
  assignments.every(a => a.cli !== 'claude')
    → Phase 3-direct (headless, 전부 CLI)
  assignments.some(a => a.cli === 'claude') AND Claude 워커가 Read/Edit 필요
    → Claude 워커: Agent(subagent_type), CLI 워커: Phase 3-direct
  fallback (psmux 미설치)
    → Phase 3 Native Teams (기존 slim wrapper)
```

**CLI 헤드리스 명령 패턴:**
| CLI | 명령 | 출력 |
|-----|-------|------|
| Codex | `codex exec 'prompt' -o result.txt --color never` | 파일 |
| Gemini | `gemini -p 'prompt' -o text > result.txt 2>result.txt.err` | 리다이렉트 |
| Claude | `claude -p 'prompt' --output-format text > result.txt 2>&1` | 리다이렉트 |

**E4 크래시 복구:** `waitForCompletion`이 세션 사망 시 `{sessionDead: true}` 반환 (throw 대신).
**elevation 불필요:** psmux IPC는 TCP 기반. 비-elevated 환경에서 정상 실행. (v5.2.0 검증 완료)
**시각적 확인:** Windows Terminal 자동 팝업 + pane 타이틀 `codex (reviewer)` + triflux 테마.
**실수로 닫아도:** psmux 세션은 독립적. `psmux attach -t 세션이름`으로 재연결.

**레거시 인터랙티브 모드:** `Bash("node {PKG_ROOT}/bin/triflux.mjs multi --no-attach --agents {agents} \\\"{task}\\\"")`

## 전제 조건

- **CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1** — `tfx setup`이 자동 설정
- **codex/gemini CLI** — 해당 에이전트 사용 시
- **Hub 활성 상태** — Named Pipe 우선, HTTP `127.0.0.1:27888` fallback. Hub 미실행 시 nativeProxy fallback.

## 에러 처리

| 에러 | 처리 |
|------|------|
| TeamCreate 실패 / Agent Teams 비활성 | `--psmux/--tmux` 폴백 |
| tfx-route.sh 없음 | `tfx setup` 실행 안내 |
| CLI 미설치 (codex/gemini) | claude 워커로 대체 |
| Codex 분류 실패 | Opus 직접 분류+분해 |
| Bash 실행 실패 | `completed` + `metadata.result: "failed"` 마킹 후 Claude fallback |
| claude fallback 실패 | 실패 목록/원인 요약 후 사용자 승인 대기 |

> TaskUpdate 상태값: `pending`, `in_progress`, `completed`, `deleted`만 지원. `failed` 사용 금지.

## 관련

| 항목 | 설명 |
|------|------|
| `scripts/tfx-route.sh` | 팀 통합 라우터 (v2.5: `--async`/`--job-wait`/`--job-status`/`--job-result`) |
| `hub/team/native.mjs` | Native Teams 래퍼 (프롬프트 템플릿) |
| `hub/pipeline/` | 파이프라인 상태 기계 (`--thorough` 모드) |
| `tfx-auto` | one-shot 실행 오케스트레이터 |
| `tfx-hub` | MCP 메시지 버스 관리 |
