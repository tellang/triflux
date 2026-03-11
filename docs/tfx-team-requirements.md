# tfx-team 요구사항 명세서

작성일: 2026-03-09
대상: `tfx team` + `/tfx-team` 스킬

## 1. 배경

본 문서는 Claude Code Agent Team 경험을 기준으로, `triflux`의 `tfx-team`을 멀티-CLI(Claude/Codex/Gemini) 팀 오케스트레이션으로 확장하기 위한 요구사항과 구현 매핑을 정의한다.

핵심 목표는 다음과 같다.

- Claude를 리드로 두고 Codex/Gemini를 워커로 직접 구성
- 팀메이트 전환/제어 UX를 Claude teammate 조작과 최대한 동일하게 제공
- wrapper payload 방식이 아닌 실제 CLI 프로세스 직접 실행
- mailbox 기반 에이전트 간 제어 메시지 전달

## 2. 요구사항

### R1. 다국적 팀 구성
- Claude Code Agent Team 유사 구조로 리드 + 다중 워커 구성
- 워커 CLI는 `codex`, `gemini`, `claude`를 혼합 가능

### R2. 실행 모드 2종
- `tmux` 모드 지원
- `in-process(native)` 모드 지원

### R3. 팀메이트 조작 키 호환
- Claude teammate 조작과 동일한 전환/제어 키 사용
- `Shift+Down`, `Shift+Up`, `Escape`, `Ctrl+T`

### R4. 워커 직접 실행
- Codex/Gemini 워커는 payload wrapper(`codex exec ...`)가 아닌 직접 CLI 실행

### R5. 토큰 효율
- `tfx-auto` 대비 팀모드 오버헤드 최소화
- 초기 리드/워커 프롬프트는 압축된 규약 중심으로 구성

### R6. 리드 제어 수신
- 리드가 워커에게 `interrupt/stop/pause/resume`를 지시 가능
- direct 지시 + mailbox 지시 모두 지원

### R7. Claude Code 스킬 경로 보장
- 사용자는 Claude Code 내부에서 `/tfx-team ...`로 동일 기능을 호출 가능해야 함

## 3. 구현 매핑

| 요구사항 | 구현 상태 | 구현 위치 |
|---|---|---|
| R1 | 구현됨 | `hub/team/cli.mjs` (`--lead`, `--agents`), `hub/team/orchestrator.mjs` |
| R2 | 구현됨 | `tmux`: `hub/team/session.mjs` / `in-process`: `hub/team/native-supervisor.mjs` |
| R3 | 구현됨(tmux) | `hub/team/session.mjs` (`configureTeammateKeybindings`) |
| R4 | 구현됨 | `hub/team/pane.mjs` (`buildCliCommand`), `hub/team/cli.mjs` (`buildNativeCliCommand`) |
| R5 | 구현됨 | `hub/team/orchestrator.mjs` (리드/워커 프롬프트 압축) |
| R6 | 구현됨 | direct: `tfx team control`, mailbox: `POST /bridge/control` (`hub/server.mjs`) |
| R7 | 구현됨 | `skills/tfx-team/SKILL.md` |

## 4. 제어 프로토콜

### 4.1 Direct Control

```bash
tfx team control <대상> <interrupt|stop|pause|resume> [사유]
```

- 즉시 대상 워커에 제어문을 주입
- `interrupt`는 즉시 인터럽트 신호 병행

### 4.2 Mailbox Control

- 엔드포인트: `POST /bridge/control`
- 필드: `from_agent`, `to_agent`, `command`, `reason`, `payload`
- 라우팅 토픽: `lead.control`

## 5. 운영 시나리오

### 5.1 Claude Code 스킬 사용

```text
/tfx-team --lead claude --agents codex,gemini --teammate-mode in-process "작업 A + 작업 B"
```

### 5.2 tmux 모드

```text
/tfx-team --teammate-mode tmux "작업 A + 작업 B"
```

- 키 조작: `Shift+Down`, `Shift+Up`, `Escape`, `Ctrl+T`

## 6. 알려진 제약

- 비-TTY 환경에서 일부 interactive CLI(특히 Codex)가 실행을 거부할 수 있음
- 이 경우 tmux 모드 사용을 우선 권장

## 7. 검증 체크리스트

- `node --check hub/team/cli.mjs`
- `node --check hub/team/orchestrator.mjs`
- `node --check hub/team/session.mjs`
- `node --check hub/team/native-supervisor.mjs`
- `node --check hub/server.mjs`
- `tfx team --teammate-mode in-process ...`
- `tfx team --teammate-mode tmux ...`
- `tfx team control ...`
