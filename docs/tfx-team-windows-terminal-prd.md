# tfx-team Windows Terminal 백엔드 PRD (v1)

작성일: 2026-03-10  
문서 상태: Draft (구현 착수 기준선)  
대상 범위: `tfx team` + `/tfx-team` 스킬의 `Windows Terminal` 분할 실행 지원

## 1) 배경 및 문제 정의

현재 `tfx team`은 다음 두 가지 런타임을 제공한다.

- `tmux` 기반 split-pane 모드
- `in-process(native)` 모드

코드 기준으로 `team` 핵심은 `tmux` 제어에 강하게 결합되어 있다.

- 세션/분할/키바인딩: `hub/team/session.mjs`
- pane 입력 주입: `hub/team/pane.mjs` (`send-keys`, `load-buffer`, `paste-buffer`)
- CLI 진입/상태/제어: `hub/team/cli.mjs`

문제는 Windows Terminal + PowerShell 7 환경에서 `tmux` 없이 split-pane UX를 원할 때다.

- Claude Agent Teams 공식 제한: split-pane는 `tmux`/iTerm2 필요, Windows Terminal 미지원
- 사용자 환경은 `wt.exe`(Windows Terminal) 사용 가능, `tmux`는 호스트에 없음

즉, 현재 구조로는 Windows Terminal 네이티브 분할 UX를 직접 제공할 수 없다.

## 2) 팩트체크 (실측 + 외부 문서)

### 2.1 로컬 환경 실측 (2026-03-10)

실행 명령은 이 저장소 루트에서 수행했다.

| 항목 | 명령 | 결과 |
|---|---|---|
| 호스트 tmux | `Get-Command tmux` | `MISSING` |
| WSL | `Get-Command wsl` | `FOUND` |
| WSL tmux | `wsl which tmux` / `wsl tmux -V` | `/usr/bin/tmux`, `tmux 3.4` |
| Windows Terminal | `Get-Command wt` | `FOUND` (`...WindowsApps\\wt.exe`) |
| zellij(호스트) | `Get-Command zellij` | `MISSING` |
| zellij(WSL) | `wsl zellij --version` | `command not found` |
| CLI 준비 | `codex --version`, `claude --version`, `gemini --version` | 모두 사용 가능 |
| 세션 변수 | `TMUX`, `WT_SESSION` | 현재 셸 기준 둘 다 비어 있음 |

추가 관찰:

- `tfx team`의 `auto` 모드 선택 로직은 현재 `TMUX`만 보고 `tmux` 여부를 결정한다.
- 따라서 Windows Terminal 안에서 실행하더라도 `TMUX`가 없으면 기본적으로 `in-process`로 간다.

### 2.2 외부 문서 근거

- Claude Agent Teams 문서: split-pane는 `tmux` 또는 iTerm2 필요, Windows Terminal 미지원.
- Windows Terminal CLI 문서:
  - `split-pane`, `move-focus`, `focus-tab`, `--window` 제공
  - WSL에서 `wt` alias 직접 사용 불가, `cmd.exe /c "wt.exe"` 우회 필요
- Zellij FAQ: Windows는 네이티브가 아니라 WSL 경유 지원.

결론:

- 현재 요구(Windows Terminal 위에서 분할 teammate UX)에는 `zellij`보다 `wt` 직접 백엔드가 우선이다.
- `zellij`는 WSL 내 대체 멀티플렉서로는 의미가 있으나, "Windows Terminal 네이티브 분할" 문제를 직접 해결하지 못한다.

## 3) 제품 목표

### 3.1 목표 (Goals)

- G1. `tfx team --teammate-mode wt`로 Windows Terminal 분할 팀 세션 시작
- G2. 기존 `tmux`, `in-process` 동작/인터페이스를 깨지 않음
- G3. `status/tasks/send/control/stop` 명령을 `wt` 모드에서도 의미 있게 제공
- G4. Windows Terminal + pwsh7 + (내부 bash 사용 가능) 환경에서 재현 가능
- G5. 기능 불일치 지점은 명확히 문서화하고 CLI에서 안내

### 3.2 비목표 (Non-Goals)

- N1. Claude Code Agent Teams와 100% 동형 복제
- N2. iTerm2 백엔드 신규 구현
- N3. zellij 백엔드 동시 개발
- N4. 리눅스/macOS에서 `wt` 모드 지원

## 4) 사용자 시나리오

### 시나리오 A: Windows Terminal에서 바로 분할 팀 시작

```bash
tfx team --teammate-mode wt "인증 리팩터링 + 테스트 보강"
```

기대:

- 새 Windows Terminal 창(또는 지정 창)에서 lead+worker 분할 실행
- 리드는 Claude, 워커는 Codex/Gemini 기본 조합

### 시나리오 B: 실행 중 제어

```bash
tfx team send worker-1 "우선 로그인 경로부터 처리"
tfx team control worker-1 interrupt "우선순위 변경"
tfx team status
tfx team tasks
```

기대:

- `send/control`이 유실 없이 워커 stdin에 전달
- 상태/태스크 조회는 기존과 동일 인터페이스 유지

## 5) 요구사항 (Functional / Non-Functional)

## 5.1 기능 요구사항 (FR)

- FR-01 모드 확장
  - `teammateMode`: `auto | in-process | tmux | wt`
- FR-02 auto 결정 규칙 (Windows)
  - `TMUX` 존재 시 `tmux`
  - `WT_SESSION` 존재 + `wt` 실행 가능 시 `wt`
  - 그 외 `in-process`
- FR-03 `wt` 세션 생성
  - `2x2`, `1xN` 레이아웃 지원
  - lead + N worker 실행
- FR-04 제어 채널 보장
  - `send`, `control(interrupt|stop|pause|resume)` 지원
  - `tmux send-keys` 의존 없이 동작해야 함
- FR-05 상태 파일 확장
  - `team-state.json`에 `teammateMode: "wt"`와 `wt` 런타임 메타 기록
- FR-06 하위 호환
  - 기존 `tmux`, `in-process` 코드 경로 무변경 혹은 최소 변경

## 5.2 비기능 요구사항 (NFR)

- NFR-01 안정성: Hub 불가용 시 오류 메시지 + 재시도 가이드 제공
- NFR-02 성능: 팀 시작 후 5초 이내 첫 프롬프트 주입 시도
- NFR-03 관측성: 멤버별 로그 경로/마지막 출력 미리보기 제공
- NFR-04 이식성: Windows 11 + PowerShell 7 + Windows Terminal 기준 검증

## 6) 기술 설계

### 6.1 설계 원칙

- `tmux` 의존 API(`send-keys`)를 백엔드 추상화로 분리
- `wt`는 "화면 분할"만 담당하고, stdin 제어는 별도 런타임 채널로 해결
- 워커 제어 신뢰성을 LLM 프롬프트 준수 여부에 의존하지 않음

### 6.2 제안 아키텍처

### A) 백엔드 인터페이스 도입

신규 인터페이스(예: `hub/team/backend.mjs`):

- `createLayout(sessionName, {layout, paneCount})`
- `launchMember(target, command, opts)`
- `focus(target)`
- `interrupt(target)`
- `capture(target, lines)`
- `shutdown(sessionName)`

구현체:

- `tmux-backend` (기존 `session/pane` 래핑)
- `wt` 런타임 모듈 (`hub/team/wt.mjs`)

### B) `wt` 모드용 멤버 러너(`member-runner`) 도입

핵심 이유:

- Windows Terminal CLI는 pane에 텍스트 입력 주입(send-keys 등) API를 제공하지 않음.
- 따라서 `tfx team send/control`을 신뢰성 있게 처리하려면, 각 pane 내 프로세스가 제어 메시지를 직접 수신해야 한다.

동작:

1. pane에서 `node hub/team/member-runner.mjs ...` 실행
2. `member-runner`가 실제 CLI(`codex|claude|gemini`)를 child process로 기동
3. `member-runner`가 Hub 메시지(`lead.control`)를 폴링/수신
4. 수신된 명령을 child stdin 또는 signal로 전달

지원 명령 매핑:

- `input` -> `stdin.write(text + "\\n")`
- `interrupt` -> `SIGINT` 또는 `^C`
- `stop` -> `exit` 후 `SIGTERM`
- `pause/resume` -> 우선 소프트 제어(메시지 우선), 후속으로 프로세스 제어 확장

### C) `tfx team send` 동작 변경 (`wt` 모드 한정)

- 기존: pane 주입
- 변경: Hub `lead.control` direct publish (`command: "input", text: ...`)

### D) auto 모드 개선

현재 `TMUX`만 보는 로직에 `WT_SESSION` + `wt` 가용성 체크 추가.

## 7) CLI/상태 계약

### 7.1 CLI

- 시작:
  - `tfx team --teammate-mode wt "작업"`
- 기존 명령 재사용:
  - `status`, `tasks`, `task`, `send`, `control`, `stop`, `kill`, `list`
- `attach/focus`는 `wt` 모드에서 의미가 제한될 수 있어 가이드 메시지 제공
  - 예: "wt 모드는 Windows Terminal 창을 직접 포커스/클릭해 조작"

### 7.2 team-state.json 확장안

```json
{
  "sessionName": "tfx-team-xxxx",
  "teammateMode": "wt",
  "wt": {
    "windowRef": "0|new",
    "layout": "2x2",
    "startedAt": 0
  },
  "members": [
    { "name": "lead", "role": "lead", "agentId": "claude-lead", "pane": "wt:lead" },
    { "name": "codex-1", "role": "worker", "agentId": "codex-w1", "pane": "wt:w1" }
  ]
}
```

## 8) 구현 단계 (Milestone)

- M0. PRD 확정 + 환경 진단 체크리스트 합의
- M1. 백엔드 추상화 레이어 도입 (`tmux` 기존 동작 유지)
- M2. `wt` 세션/레이아웃 생성 모듈 구현 (`hub/team/wt.mjs`)
- M3. `member-runner` 구현 + `send/control` 제어 경로 연결
- M4. `status/tasks/stop` 통합 검증
- M5. 문서/도움말/스킬 업데이트

## 9) 검증 계획

### 9.1 기능 검증

- `node --check`:
  - `hub/team/cli.mjs`
  - `hub/team/orchestrator.mjs`
  - `hub/team/session.mjs`
  - `hub/team/native-supervisor.mjs`
  - `hub/team/member-runner.mjs` (신규)
  - `hub/team/wt.mjs` (신규)

- 시나리오:
  - `tfx team --teammate-mode wt "..."`
  - `tfx team send worker-1 "..."`
  - `tfx team control worker-1 interrupt "..."`
  - `tfx team status`
  - `tfx team stop`

### 9.2 환경 검증 매트릭스

- E1: Windows Terminal + pwsh7
- E2: Windows Terminal + Git Bash
- E3: WSL 내부 실행(`cmd.exe /c wt.exe` 경유 필요 케이스)
- E4: Hub 비기동/의존성 누락/CLI 미설치 예외 처리

## 10) 리스크 및 완화

- R1. `wt`는 pane stdin 직접 주입 API 부재
  - 완화: `member-runner`로 stdin/signal 제어를 터미널 바깥 채널로 분리
- R2. WSL에서 `wt` alias 사용 불가
  - 완화: 공식 권장대로 `cmd.exe /c "wt.exe"` 경유
- R3. `focus/attach` 기능 동형성 부족
  - 완화: `wt` 모드는 명시적으로 Partial Support 표기 + 안내 UX 제공
- R4. 제어 메시지 누락
  - 완화: Hub direct publish + ack/retry + 상태 표시

## 11) zellij 채택 판단

현재 결론: **이번 사이클에서는 zellij 채택 보류**

- 이유 1: Windows 네이티브가 아니라 WSL 경유가 전제
- 이유 2: 목표는 "Windows Terminal 네이티브 분할 teammate UX"
- 이유 3: zellij로 전환해도 `send/control` 신뢰성 문제는 별도 해결 필요

재검토 조건:

- `wt` 백엔드 안정화 후 Linux/WSL 전용 옵션으로 zellij 추가 검토

## 12) 수용 기준 (Acceptance Criteria)

- AC-01 `--teammate-mode wt`로 팀 시작 가능
- AC-02 `send/control`이 `wt` 모드에서도 실제 워커 입력/신호로 적용
- AC-03 `status/tasks/stop`이 기존 인터페이스와 동일하게 동작
- AC-04 `tmux`/`in-process` 회귀 없음
- AC-05 README/Skill/Help에 모드 제약과 사용법 반영

## 13) 참고 링크

- Claude Agent Teams: https://code.claude.com/docs/en/agent-teams.md
- Claude Docs Index (`llms.txt`): https://code.claude.com/docs/llms.txt
- Windows Terminal CLI: https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments
- Windows Terminal Pane 가이드: https://learn.microsoft.com/windows/terminal/panes
- Zellij FAQ: https://zellij.dev/faq/
