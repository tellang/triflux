---
name: tfx-doctor
description: >
  triflux 진단 및 수리 도구. CLI 미발견, HUD 미표시, 캐시 오류,
  스킬 미설치 등 문제를 진단하고 자동 수정합니다.
  Use when: not working, broken, error, 안 돼, 이상해, 에러, 캐시, reset
triggers:
  - tfx-doctor
argument-hint: "[--fix|--reset]"
---

# tfx-doctor — triflux 진단 및 수리

> 뭔가 안 될 때, HUD가 이상할 때, CLI가 안 보일 때 실행하세요.

## 사용법

```
/tfx-doctor            ← 진단만 (읽기 전용)
/tfx-doctor --fix      ← 진단 + 자동 수정
/tfx-doctor --reset    ← 캐시 전체 초기화
```

## 동작

### 기본 모드 (`/tfx-doctor`)

`triflux doctor`를 실행하여 다음을 진단합니다:

- tfx-route.sh 설치 상태
- HUD 설치 및 설정 상태
- Codex/Gemini/Claude CLI 경로 (크로스 셸)
- 스킬 설치 상태
- 플러그인 등록 상태
- MCP 인벤토리 캐시
- CLI 이슈 트래커
- 잔존 팀(orphan teams) 감지 (`~/.claude/teams/`)

### 수정 모드 (`/tfx-doctor --fix`)

진단 전에 자동 수정을 시도합니다:

1. tfx-route.sh, HUD, 스킬 파일 재동기화
2. 에러/손상된 캐시 파일 정리
3. 수정 완료 후 전체 진단 실행 → 결과 보고

### 초기화 모드 (`/tfx-doctor --reset`)

HUD 캐시 및 모든 triflux 관련 캐시를 전체 삭제합니다:

| 삭제 대상 | 설명 |
|-----------|------|
| claude-usage-cache.json | Claude 사용량 캐시 |
| codex-rate-limits-cache.json | Codex 레이트 리밋 캐시 |
| gemini-quota/session/rpm cache | Gemini 할당량/세션/RPM 캐시 |
| sv-accumulator.json | 절약량 누적 캐시 |
| mcp-inventory.json | MCP 서버 인벤토리 |
| cli-issues.jsonl | CLI 이슈 로그 |
| triflux-update-check.json | 업데이트 확인 캐시 |
| .claude-refresh-lock | 리프레시 락 파일 |

초기화 후 다음 세션에서 캐시가 새로 생성됩니다.

## 실행 방법

```bash
# 진단만
Bash("triflux doctor")

# 진단 + 자동 수정
Bash("triflux doctor --fix")

# 캐시 전체 초기화
Bash("triflux doctor --reset")
```

결과를 사용자에게 보고합니다.

## 자동 제안 트리거

사용자가 다음과 같이 말하면 이 스킬 실행을 고려하세요:

- "HUD가 안 보여" / "HUD 이상해" / "상태줄이 안 나와"
- "codex/gemini가 안 돼" / "CLI 안 됨"
- "캐시 초기화" / "리셋" / "reset"
- "triflux 안 돼" / "뭔가 안 돼" / "에러"

## 에러 처리

| 상황 | 처리 |
|------|------|
| 캐시 디렉토리 없음 | 정상 — 삭제할 파일 없음 보고 |
| 파일 삭제 권한 없음 | 수동 삭제 안내 |
| --fix 후에도 이슈 남음 | Codex/Gemini 설치는 수동 필요 안내 |
