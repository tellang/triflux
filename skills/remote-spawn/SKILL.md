---
name: remote-spawn
description: 로컬/원격 머신에 Claude 세션을 WT 탭으로 spawn합니다. 핸드오프 전달 지원.
triggers:
  - remote-spawn
argument-hint: "[--host <ssh-host>] [--dir <path>] <prompt>"
---

# remote-spawn — 원격/로컬 Claude 세션 Spawn

> 새 WT 탭에서 Claude 세션을 시작하고, 선택적으로 핸드오프 컨텍스트를 전달합니다.

## 사용법

```
/remote-spawn 리팩터링 작업 이어서 해줘
/remote-spawn --host ultra4 보안 리뷰 진행해
/remote-spawn --host ultra4 --dir ~/Desktop/Projects/gamma API 점검
```

## 동작

1. **인자 파싱**: `--host`, `--dir`, 나머지는 prompt
2. **핸드오프 생성** (선택): 현재 세션 컨텍스트에서 최소 핸드오프 생성
3. **세션 Spawn**: `scripts/remote-spawn.mjs` 호출

## 실행 규칙

### 로컬 (--host 미지정)

```bash
node scripts/remote-spawn.mjs --local --dir "${DIR}" --prompt "${PROMPT}"
```
- 새 WT 탭에서 Claude 실행
- `--dir` 미지정 시 현재 디렉토리

### 원격 (--host 지정)

```bash
node scripts/remote-spawn.mjs --host "${HOST}" --dir "${DIR}" --prompt "${PROMPT}"
```
- WT 탭에서 SSH 세션 열고 원격 Claude 실행
- `--dir` 미지정 시 `~`
- 원격 Claude는 자기 환경(CLAUDE.md, 훅, MCP)을 이미 알고 있으므로 태스크만 전달

### 핸드오프 모드

현재 세션에서 핸드오프를 생성한 뒤 전달하려면:

1. `/mp`로 핸드오프 파일 생성
2. `/remote-spawn --host ultra4 --handoff .omc/handoff-xxx.md`

또는 Claude가 직접 핸드오프를 인라인으로 구성:

```bash
node scripts/remote-spawn.mjs --host ultra4 --prompt "이전 세션에서 JWT 미들웨어 구현 완료. 남은 작업: 테스트 커버리지 80% 달성"
```

## 전제 조건

- `remoteControlAtStartup: true` 가 settings.json에 설정됨 (`triflux setup`으로 자동)
- 원격 호스트: SSH config에 등록 + Claude Code 설치
- 로컬: Windows Terminal 설치
