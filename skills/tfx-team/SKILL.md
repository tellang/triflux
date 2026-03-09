---
name: tfx-team
description: 멀티-CLI 팀 모드. tfx-auto와 동일한 트리아지/분해, 실행은 tmux/wt/in-process + Hub 기반 interactive 세션.
triggers:
  - tfx-team
argument-hint: '"작업 설명" | --agents codex,gemini "작업" | --teammate-mode in-process|tmux|wt "작업" | status | stop'
---

# tfx-team — tmux/wt + Hub 기반 멀티-CLI 팀 오케스트레이터

> tfx-auto와 **동일한 트리아지/분해 로직**, 실행 백엔드만 다름.
>
> | | tfx-auto | tfx-team |
> |--|----------|----------|
> | 트리아지 | Codex 분류 → Opus 분해 | **동일** |
> | 실행 | `tfx-route.sh` one-shot | **tmux/wt pane interactive** |
> | 관찰 | stdout 반환 후 종료 | **실시간 네이티브 터미널** |
> | 통신 | 없음 (독립 실행) | **Hub MCP 메시지 버스** |
> | 개입 | 불가 | **`tfx team send <대상> "추가 지시"`** |
> | 리드 | 없음 | **Claude lead + Codex/Gemini workers** |
> | 모드 | 없음 | **`--teammate-mode tmux|wt|in-process`** (in-process는 tmux 불필요) |

## 사용법

```
/tfx-team "인증 리팩터링 + UI 개선 + 보안 리뷰"
/tfx-team --agents codex,gemini "프론트+백엔드"
/tfx-team --lead claude --teammate-mode in-process "대규모 병렬 작업"
/tfx-team --teammate-mode tmux --layout 2x2 "분할 화면 실행"
/tfx-team --teammate-mode wt --layout 2x2 "Windows Terminal 분할 실행"
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
- `status`, `stop`, `kill`, `attach`, `list`, `send`, `focus`, `tasks`, `task`, `control` → `Bash("node bin/triflux.mjs team {cmd}")` 직행
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

### Phase 3: 팀 세션 실행 (tmux / wt / in-process)

트리아지 결과를 `tfx team` CLI로 실행:

```bash
# agents 배열과 작업을 tfx team에 전달
Bash("node {PKG_ROOT}/bin/triflux.mjs team --agents {agents.join(',')} \"{task}\"")
```

**내부 동작 (hub/team/ 모듈):**
1. Hub lazy-start (`hub/server.mjs`)
2. 모드별 런타임 생성
   - `tmux`: 세션 + pane 생성 (lead + workers)
   - `wt`: Windows Terminal split-pane + `member-runner` 실행
   - `in-process`: native supervisor가 CLI 프로세스를 직접 spawn
3. 리드/워커 프롬프트 주입
4. tmux 모드에서 팀메이트 키 바인딩
   - `Shift+Down/Shift+Up`: 팀메이트 전환
   - `Escape`: 인터럽트(C-c)
   - `Ctrl+T`: 태스크 목록
5. attach/focus는 tmux 모드만 제공 (`wt`/`in-process`는 `send/control/status` 중심)

### Phase 4: 실시간 관찰 + 개입

tmux 세션에서:
- `Shift+Down / Shift+Up`: 팀메이트 전환
- `Escape`: 현재 팀메이트 인터럽트
- `Ctrl+T`: 태스크 목록 표시
- `Ctrl+B → D`: 세션 분리 (백그라운드)

wt/in-process 모드에서:
- `tfx team status`, `tfx team send`, `tfx team control`로 제어

세션 분리 후 제어:
```bash
/tfx-team status
/tfx-team focus lead
/tfx-team send worker-1 "추가 지시"
/tfx-team control worker-1 interrupt "우선순위 변경"
/tfx-team tasks
/tfx-team task done T1
/tfx-team attach
/tfx-team stop
```

### Phase 5: 에이전트 간 통신

Hub MCP 도구가 각 CLI에 등록되어 있으면 자동 통신:
- `register`: 에이전트 등록
- `publish`: 결과 발행 + 리드 제어 발행 (topic: task.result / lead.control)
- `poll_messages`: 다른 에이전트 메시지 수신
- `ask`: 다른 에이전트에게 질문

리드 제어 표준:
- `lead.control` payload: `{ command: "interrupt|stop|pause|resume", reason: "..." }`
- direct mailbox: `POST /bridge/control` (`from_agent`, `to_agent`, `command`, `reason`)

MCP 미등록 시 REST 폴백 (프롬프트에 curl 명령 포함, 제어는 direct send 우선).

## 에이전트 매핑

| 분류 결과 | CLI | 비고 |
|----------|-----|------|
| codex | `codex` (interactive) | 래핑 없이 직접 실행 |
| gemini | `gemini` (interactive) | 래핑 없이 직접 실행 |
| claude | `claude` (interactive) | 기본 리드 |

> **중요:** Codex/Gemini 워커는 payload wrapper(`codex exec "..."`/`gemini -p "..."`)로 감싸지 않고
> CLI 프로세스를 직접 기동한 뒤 프롬프트를 주입한다.

## tfx-auto와의 차이 요약

| 항목 | tfx-auto | tfx-team |
|------|----------|----------|
| 트리아지 | Codex 분류 → Opus 분해 | **동일** |
| 실행 단위 | 에이전트(executor, reviewer 등) | CLI(codex, gemini, claude) |
| 리드 | 없음 | Claude lead (기본) |
| 실행 방식 | `tfx-route.sh` (one-shot, 블랙박스) | 백엔드별 interactive (`tmux`/`wt`/`in-process`) |
| 결과 수집 | stdout 파싱 | Hub publish/poll + 수동 태스크 상태 |
| 개입 | 불가 | `tfx team send`, `tfx team focus` |
| 통신 | 없음 | Hub MCP 메시지 버스 |
| 팀메이트 조작 | 없음 | Shift+Down / Escape / Ctrl+T |
| tmux 필요 | 아니오 | 모드 의존 (`tmux` 모드에서만 필요) |

## 전제 조건

- **tmux** — tmux 모드에서만 필수 (in-process 모드는 불필요)
- **codex/gemini CLI** — 해당 에이전트 사용 시
- **tfx setup** — Hub MCP 자동 등록 (사전 실행 권장)

## 에러 처리

| 에러 | 처리 |
|------|------|
| tmux 미설치 | 안내 메시지 + WSL2 설치 가이드 |
| Windows Terminal 미발견 | `--teammate-mode wt` 사용 불가 안내 |
| Hub 시작 실패 | `tfx hub start` 수동 실행 안내 |
| CLI 미설치 | 해당 pane 건너뜀 + 경고 |
| MCP 미등록 | REST 폴백 (curl) |
| Codex 분류 실패 | Opus 직접 분류+분해 |

## 관련

| 항목 | 설명 |
|------|------|
| `hub/team/` | tmux/wt/native + Hub 팀 모듈 (session, pane, orchestrator, dashboard, cli) |
| `tfx-auto` | one-shot 실행 오케스트레이터 (기존, 병행 유지) |
| `tfx-hub` | MCP 메시지 버스 관리 (start/stop/status) |
