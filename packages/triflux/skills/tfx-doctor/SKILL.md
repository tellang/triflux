---
name: tfx-doctor
description: >
  triflux 설치, CLI, HUD, 스킬, 캐시와 MCP 연결을 진단하고 관리 대상만 복구합니다.
  Use when: not working, broken, error, 안 돼, 이상해, 에러, 캐시, reset, doctor
argument-hint: "[--fix|--reset]"
---

# tfx-doctor

인자가 없으면 `tfx doctor --json`을 실행해 결과를 요약한다. 점검 모드는 설정을 쓰거나 삭제하지 않는다. 누락되거나 깨진 MCP registry도 상태만 보고한다.

| 요청 | 명령 | 범위 |
|------|------|------|
| 진단 | `tfx doctor --json` | 읽기 전용 점검 |
| 복구 | `tfx doctor --fix` | 관리 파일과 스킬 동기화, 오류 캐시 복구, 기존 직접 연결 이주 |
| 캐시 초기화 | `tfx doctor --reset` | 지정된 캐시 삭제 후 재생성 |

`--fix`는 triflux가 소유하지 않은 OMC 팀과 Claude 네이티브 팀을 삭제하지 않는다. `--reset`은 캐시를 삭제하므로 요청이 분명할 때만 실행한다. 결과의 실패와 건너뜀을 성공으로 바꾸어 보고하지 않는다.

## 주요 점검

설치된 `tfx-route.sh`, HUD, Claude·Codex·Antigravity CLI, Codex 프로필, 스킬, psmux/tmux, MCP 설정과 인벤토리, route script 동기화 상태를 확인한다. 발견한 문제마다 출력된 복구 명령을 따른다. 사용자 소유 설정이나 깨진 파일은 원인을 먼저 보고한다.

## 제거된 허브 흔적

허브는 제거됐다. 현재 디렉터리의 `.mcp.json`과 `.claude/mcp.json`에 허브가 만든 `tfx-hub` 항목이 남아 있으면 `tfx doctor`가 경로를 알린다. 사용자 파일과 구분할 수 없어 자동으로 지우지 않으므로 직접 지운다. 전역 설정의 항목, 실행 중이던 프로세스, 예약 작업은 `tfx setup`이 한 번 정리한다.
