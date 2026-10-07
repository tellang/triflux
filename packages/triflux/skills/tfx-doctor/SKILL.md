---
name: tfx-doctor
description: >
  triflux 설치, CLI, HUD, 스킬, 캐시와 MCP 연결을 진단하고 관리 대상만 복구합니다.
  허브 시작·중지·상태 확인도 안내합니다.
  Use when: not working, broken, error, 안 돼, 이상해, 에러, 캐시, reset, doctor, hub 상태, 허브 시작
argument-hint: "[--fix|--reset|hub <start|stop|status|ensure>]"
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

설치된 `tfx-route.sh`, HUD, Claude·Codex·Antigravity CLI, Codex 프로필, 스킬, psmux/tmux, MCP 설정과 인벤토리, 웜업 캐시, route script 동기화 상태를 확인한다. 발견한 문제마다 출력된 복구 명령을 따른다. 사용자 소유 설정이나 깨진 파일은 원인을 먼저 보고한다.

## 허브 관리

허브 제거 전에는 `tfx hub status --json`, `tfx hub start`, `tfx hub ensure --json`, `tfx hub stop`으로 상태를 관리한다. 기본 MCP URL은 `http://127.0.0.1:27888/mcp`이고 포트는 `TFX_HUB_PORT`로 바꿀 수 있다. 중지나 재시작 뒤에는 `status`로 실제 결과를 확인한다.
