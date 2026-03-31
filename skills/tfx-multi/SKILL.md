---
name: tfx-multi
description: 멀티-CLI 팀 모드. Claude Native Agent Teams + Codex/Gemini 멀티모델 오케스트레이션.
triggers:
  - tfx-multi
argument-hint: '"작업 설명" | --agents codex,gemini "작업" | --tmux "작업" | status | stop'
---

# tfx-multi v3 — 파이프라인 기반 멀티-CLI 팀 오케스트레이터

> **인프라**: 다른 스킬이 내부적으로 사용. 직접 호출할 필요 없음.
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
1. Codex `exec --skip-git-repo-check` 분류 → JSON `{parts: [{description, agent}]}`
2. Opus 인라인 분해 → 서브태스크 배열 `[{cli, subtask, role}]`
3. Codex 분류 실패 시 → Opus가 직접 분류+분해

**수동 모드:** Codex 분류 건너뜀 → Opus가 직접 N개 서브태스크 분해.

### Phase 2.5–2.6 + 3.5–3.7: 파이프라인 (기본)

> `--thorough`(기본) 모드에서 실행된다. `--quick` 플래그 시 건너뛴다.
> 상세는 → [`references/thorough-pipeline.md`](references/thorough-pipeline.md) 참조.

### Phase 3: Lead-Direct Headless 실행 (v6.0.0, 기본)

> **MANDATORY: CLI 워커는 headless 엔진으로 실행**
> CLI 워커(Codex/Gemini)는 반드시 아래 `Bash()` 명령으로 headless 엔진을 통해 실행한다.
> `Bash(tfx-route.sh)` 개별 호출이나 `Agent()` CLI 래핑은 PreToolUse 훅이 자동 차단/변환한다.
> headless 엔진이 psmux 세션 생성 → WT 자동 팝업 → CLI dispatch → 결과 수집을 전부 처리한다.

**실행 명령 (Lead가 호출하는 유일한 명령):**

```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:{프롬프트1}:{역할1}' --assign 'gemini:{프롬프트2}:{역할2}' --timeout 600")
```

**예시:**

```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:코드 리뷰하고 개선 사항 제안:reviewer' --assign 'gemini:API 문서 작성:writer' --assign 'codex:보안 취약점 분석:security' --timeout 600")
```

**Claude 워커가 Read/Edit 필요한 경우 (하이브리드):**

Claude 워커는 headless에서 실행 불가 (Read/Edit 도구 필요). CLI 워커만 headless로 보내고 Claude 워커는 Agent로 병렬 실행.

```
# 1. CLI 워커를 headless로 dispatch
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:{프롬프트}:{역할}' --assign 'gemini:{프롬프트}:{역할}' --timeout 600")

# 2. Claude 워커를 Agent로 병렬 실행 (headless Bash와 동시에 spawn)
Agent(subagent_type="...", prompt="...", run_in_background=true)
```

**결정 로직:**
```
if 모든 워커가 CLI (codex/gemini):
  → Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign ...")
elif CLI + Claude 혼합:
  → CLI 워커: Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign ...")
  → Claude 워커: Agent(subagent_type, run_in_background=true)
elif psmux 미설치:
  → Phase 3-fallback (아래)
```

**headless 엔진이 자동으로 수행하는 것:**
- psmux 세션 생성 + progressive split-window
- Windows Terminal 자동 팝업 (autoAttach)
- `--dashboard` TUI 대시보드 자동 표시 (headless-guard가 기본 주입)
- triflux 테마 적용 (Catppuccin Mocha status bar)
- 워커 요약 dashboard 스플릿
- CLI 명령 dispatch + 완료 토큰 폴링
- 결과 수집 + JSON stdout 출력
- 세션 정리

**출력 파싱:** headless 완료 후 stdout에 JSON 결과가 출력된다. 성공/실패 워커 수, 각 워커 출력을 파싱.
**크래시 복구:** 세션 사망 시 `{sessionDead: true}` 반환 (throw 대신).
**실수로 닫아도:** psmux 세션은 독립적. `psmux attach -t 세션이름`으로 재연결.

### Phase 4: 결과 수집 + 정리

headless stdout 출력에서 성공/실패 워커를 파싱.
실패 워커(`exitCode !== 0`)는 Claude fallback 재시도.

### Phase 3-fallback: Native Teams (psmux 미설치 시)

psmux가 없는 환경에서만 사용. Agent slim wrapper로 CLI를 실행.
`hub/team/native.mjs`의 `buildSlimWrapperPrompt()` 기반.

**팀 이름 생성 (`generateTeamName`):**
`tfx-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
타임스탬프 base36 끝 4자 + 난수 4자 조합. 예: `tfx-p1q2r3s4`.

> 래퍼 규칙 상세 → [`references/agent-wrapper-rules.md`](references/agent-wrapper-rules.md)

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
