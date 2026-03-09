---
name: tfx-team
description: 멀티-CLI 팀 모드. tfx-auto와 동일한 트리아지/분해, 실행은 tmux + Hub 기반 interactive 세션.
triggers:
  - tfx-team
argument-hint: '"작업 설명" | --agents codex,gemini "작업" | status | stop'
---

# tfx-team — tmux + Hub 기반 멀티-CLI 팀 오케스트레이터

> tfx-auto와 **동일한 트리아지/분해 로직**, 실행 백엔드만 다름.
>
> | | tfx-auto | tfx-team |
> |--|----------|----------|
> | 트리아지 | Codex 분류 → Opus 분해 | **동일** |
> | 실행 | `tfx-route.sh` one-shot | **tmux pane interactive** |
> | 관찰 | stdout 반환 후 종료 | **실시간 네이티브 터미널** |
> | 통신 | 없음 (독립 실행) | **Hub MCP 메시지 버스** |
> | 개입 | 불가 | **`tfx team send N "추가 지시"`** |

## 사용법

```
/tfx-team "인증 리팩터링 + UI 개선 + 보안 리뷰"
/tfx-team --agents codex,gemini "프론트+백엔드"
/tfx-team status
/tfx-team stop
```

## 실행 워크플로우

### Phase 1: 입력 파싱

```
입력: "3:codex 리뷰"         → 수동 모드: N=3, agent=codex
입력: "인증 + UI + 테스트"    → 자동 모드: Codex 분류 → Opus 분해
입력: "status"               → 제어 커맨드 (tfx team status)
입력: "stop"                 → 제어 커맨드 (tfx team stop)
```

**제어 커맨드 감지:**
- `status`, `stop`, `kill`, `attach`, `list`, `send` → `Bash("node bin/triflux.mjs team {cmd}")` 직행
- 그 외 → Phase 2 트리아지

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

  JSON:
  { \"parts\": [{ \"description\": \"...\", \"agent\": \"codex|gemini|claude\" }] }
'")
```

> Codex 분류 실패 시 → Opus(오케스트레이터)가 직접 분류+분해

```
# Step 2b: Opus 인라인 분해
분류 결과 → 에이전트 배정:
  codex → --agents에 codex 추가
  gemini → --agents에 gemini 추가
  claude → --agents에 claude 추가 (또는 codex로 대체 — claude는 최후 수단)

결과: agents 배열 + subtasks 배열
```

#### 수동 모드 (`N:agent_type`)

Codex 분류 건너뜀 → Opus가 직접 N개 서브태스크 분해.

### Phase 3: tmux 팀 실행

트리아지 결과를 `tfx team` CLI로 실행:

```bash
# agents 배열과 작업을 tfx team에 전달
Bash("node {PKG_ROOT}/bin/triflux.mjs team --agents {agents.join(',')} \"{task}\"")
```

**내부 동작 (hub/team/ 모듈):**
1. Hub lazy-start (`hub/server.mjs`)
2. tmux 세션 생성 (2x2 or 1xN 레이아웃)
3. Pane 0: Dashboard (실시간 상태)
4. Pane 1~N: 각 CLI interactive 모드 시작 (codex/gemini/claude)
5. 3초 대기 (CLI 초기화)
6. 각 pane에 서브태스크 프롬프트 주입 (load-buffer + paste-buffer)
7. tmux attach → 사용자에게 제어권

### Phase 4: 실시간 관찰 + 개입

tmux 세션 내에서:
- `Ctrl+B → 방향키`: pane 전환
- `Ctrl+B → D`: 세션 분리 (백그라운드)
- `Ctrl+B → Z`: pane 전체화면

세션 분리 후 제어:
```bash
/tfx-team status            # 팀 상태 확인
/tfx-team send 1 "추가 지시"  # Pane 1에 입력
/tfx-team attach            # 세션 재연결
/tfx-team stop              # graceful 종료
```

### Phase 5: 에이전트 간 통신

Hub MCP 도구가 각 CLI에 등록되어 있으면 자동 통신:
- `register`: 에이전트 등록
- `publish`: 결과 발행 (topic: task.result)
- `poll_messages`: 다른 에이전트 메시지 수신
- `ask`: 다른 에이전트에게 질문

MCP 미등록 시 REST 폴백 (프롬프트에 curl 명령 포함).

## 에이전트 매핑

| 분류 결과 | CLI | 비고 |
|----------|-----|------|
| codex | `codex` (interactive) | MCP: ~/.codex/config.json |
| gemini | `gemini` (interactive) | MCP: ~/.gemini/settings.json |
| claude | `claude` (interactive) | MCP: .mcp.json |

> **중요:** tfx-auto와 달리 세부 에이전트(executor, debugger 등)로 분류하지 않음.
> tmux pane에는 CLI 단위(codex/gemini/claude)로 실행하고,
> 프롬프트에 역할(구현/리뷰/디버깅)을 명시하여 CLI가 알아서 수행.

## tfx-auto와의 차이 요약

| 항목 | tfx-auto | tfx-team |
|------|----------|----------|
| 트리아지 | Codex 분류 → Opus 분해 | **동일** |
| 실행 단위 | 에이전트(executor, reviewer 등) | CLI(codex, gemini, claude) |
| 실행 방식 | `tfx-route.sh` (one-shot, 블랙박스) | tmux pane (interactive, 관찰 가능) |
| 결과 수집 | stdout 파싱 | Hub publish/poll |
| 개입 | 불가 | `tfx team send` |
| 통신 | 없음 | Hub MCP 메시지 버스 |
| Dashboard | 없음 | Pane 0 실시간 상태 |
| tmux 필요 | 아니오 | **예** |
| 종료 | 자동 (실행 완료) | 수동 (`tfx team stop`) |

## 전제 조건

- **tmux** — 필수 (Git Bash: v3.6a, WSL2, macOS, Linux)
- **codex/gemini CLI** — 해당 에이전트 사용 시
- **tfx setup** — Hub MCP 자동 등록 (사전 실행 권장)

## 에러 처리

| 에러 | 처리 |
|------|------|
| tmux 미설치 | 안내 메시지 + WSL2 설치 가이드 |
| Hub 시작 실패 | `tfx hub start` 수동 실행 안내 |
| CLI 미설치 | 해당 pane 건너뜀 + 경고 |
| MCP 미등록 | REST 폴백 (curl) |
| Codex 분류 실패 | Opus 직접 분류+분해 |

## 관련

| 항목 | 설명 |
|------|------|
| `hub/team/` | tmux + Hub 팀 모듈 (session, pane, orchestrator, dashboard, cli) |
| `tfx-auto` | one-shot 실행 오케스트레이터 (기존, 병행 유지) |
| `tfx-hub` | MCP 메시지 버스 관리 (start/stop/status) |
