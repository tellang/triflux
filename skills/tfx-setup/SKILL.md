---
name: tfx-setup
description: >
  triflux 설치 파일, 스킬, HUD, CLI 프로필을 설정하고 상태를 확인합니다.
  Use when: setup, 설정, 설치, install, 초기화, 처음, 시작
argument-hint: "[doctor]"
---

# tfx-setup

`doctor` 인자가 있으면 `tfx doctor`로 상태를 확인한다. 그 외에는 `tfx setup`을 실행하고 출력된 경고를 그대로 보고한다. 변경 계획만 필요하면 `tfx setup --dry-run`을 사용한다.

## 설정 범위

`tfx setup`은 관리 대상 스크립트와 HUD, 스킬 및 references를 동기화하고, 지원하지 않는 플랫폼의 스킬과 소유권이 확인된 오래된 사본을 정리한다. 사용자 상태인 `hosts.json`은 보존한다. 저장소의 `CLAUDE.md`에는 라우팅 표를 쓰지 않는다.

HUD의 `statusLine`이 비어 있으면 triflux HUD를 등록한다. 이미 triflux HUD이면 유지하고, 다른 명령이면 보존한 뒤 안내한다. `settings.json`이 깨졌으면 수정을 시도하지 않고 오류를 보고한다.

Codex 프로필은 `~/.codex/<이름>.config.toml`로 관리한다. 기본 설정 키는 `approval_policy`, `sandbox_mode`이며 CLI에는 `--profile`만 전달한다. 프로젝트 지침은 [CLAUDE.md](../../CLAUDE.md)의 `<codex-config>`를 따른다.

Antigravity 프로필은 `~/.gemini/triflux-profiles.json`에서 Gemini 3.8 Flash Low, Medium, High를 사용한다. `agy`와 `codex`가 설치되지 않았으면 선택적 CLI 누락으로 보고한다.

기존 MCP 직접 연결 이주는 설치 과정에서 실행된다. 이주할 수 없는 항목과 누락된 API 키는 경고로 남긴다. 검색 MCP 키를 프로젝트 `.mcp.json`에 직접 쓰지 않는다.

Hub MCP 등록과 선택적 Windows Hub 자동 시작은 허브 제거 전까지 유지한다. Windows의 로컬 세션은 psmux와 Windows Terminal을 사용한다. macOS/Linux는 tmux가 기본이며 macOS에서 tmux가 없으면 Terminal.app 대체 경로를 사용한다.

## 확인

설정 후 `tfx doctor --json`으로 CLI, 프로필, HUD, 스킬, 캐시 및 MCP 상태를 확인한다. 진단만 할 때는 `tfx setup`을 실행하지 않는다.
