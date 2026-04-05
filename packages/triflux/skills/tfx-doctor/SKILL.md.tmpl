---
name: tfx-doctor
description: >
  triflux 진단 및 수리 도구. AskUserQuestion 기반 인터랙티브 선택지로
  CLI 미발견, HUD 미표시, 캐시 오류, 스킬 미설치 등을 진단하고 자동 수정합니다.
  Use when: not working, broken, error, 안 돼, 이상해, 에러, 캐시, reset, doctor
triggers:
  - tfx-doctor
argument-hint: "[--fix|--reset]"
---

# tfx-doctor — triflux 진단 및 수리

> 뭔가 안 될 때, HUD가 이상할 때, CLI가 안 보일 때 실행하세요.

## 워크플로우

### Step 1: 모드 선택 (AskUserQuestion)

인자 없이 호출된 경우 모드를 선택한다:

```
question: "어떤 진단 모드를 실행하시겠습니까?"
header: "모드"
options:
  - label: "진단 (Diagnose)"
    description: "읽기 전용 전체 검사 — 아무것도 수정하지 않음"
  - label: "수정 (Fix)"
    description: "파일 동기화 + 캐시 정리 후 진단 실행"
  - label: "캐시 관리 (Cache)"
    description: "캐시 파일별 상태 조회, 선택적 삭제"
  - label: "전체 초기화 (Reset)"
    description: "모든 캐시 삭제 + 재생성 (위험)"
```

`--fix`, `--reset` 인자가 있으면 바로 해당 모드로 실행.

### Step 2: 모드별 실행

#### 진단 모드

```bash
Bash("triflux doctor --json")
```

JSON 결과를 파싱하여 마크다운 테이블로 표시:

```
| 항목 | 상태 | 비고 |
|------|------|------|
| tfx-route.sh | ✅ | v2.0 |
| HUD | ✅ | 설치됨 |
| Codex CLI | ✅ | found |
| Gemini CLI | ⚠ | 미설치 (선택) |
| ...  | ... | ... |
```

이슈가 발견되면 AskUserQuestion:
```
question: "N개 이슈가 발견되었습니다. 자동 수정을 시도하시겠습니까?"
header: "수정"
options:
  - label: "자동 수정 실행 (Recommended)"
    description: "triflux doctor --fix 실행"
  - label: "건너뛰기"
    description: "수정 없이 결과만 확인"
```

#### 수정 모드

```bash
Bash("triflux doctor --fix")
```

결과를 보고한다.

#### 캐시 관리

`~/.claude/cache/` 디렉토리의 캐시 파일들을 Read/Glob으로 조회:

| 캐시 파일 | 설명 |
|-----------|------|
| claude-usage-cache.json | Claude 사용량 |
| codex-rate-limits-cache.json | Codex 레이트 리밋 |
| gemini-quota-cache.json | Gemini 쿼터 |
| sv-accumulator.json | 절약량 누적 |
| mcp-inventory.json | MCP 서버 인벤토리 |
| cli-issues.jsonl | CLI 이슈 로그 |
| triflux-update-check.json | 업데이트 체크 |
| .omc/cache/codex-skills.json | Codex 스킬 인덱스 |
| .omc/state/tier-environment.json | Tier 환경 스냅샷 |
| .omc/cache/project-meta.json | 프로젝트 메타 |
| .omc/state/search-engines.json | 검색 엔진 상태 |

존재하는 캐시 파일 목록과 크기를 테이블로 표시 후 AskUserQuestion:

```
question: "어떻게 삭제하시겠습니까?"
header: "삭제"
options:
  - label: "전체 삭제"
    description: "모든 캐시 파일 삭제"
  - label: "에러 캐시만 삭제"
    description: "파싱 에러가 있는 파일만 삭제"
  - label: "선택 삭제"
    description: "파일 하나씩 선택하여 삭제"
  - label: "취소"
    description: "삭제하지 않음"
```

"선택 삭제" 시 각 파일에 대해 AskUserQuestion으로 삭제 여부 확인.

#### 전체 초기화

위험 확인:
```
question: "전체 캐시를 초기화하시겠습니까? 다음 세션에서 재생성됩니다."
header: "확인"
options:
  - label: "초기화 실행"
    description: "모든 캐시 삭제 + MCP/사용량 캐시 재생성"
  - label: "취소"
    description: "아무것도 하지 않음"
```

확인 시:
```bash
Bash("triflux doctor --reset")
```

### Step 3: 후속 조치

실행 완료 후 AskUserQuestion:
```
question: "다른 작업을 하시겠습니까?"
header: "계속"
options:
  - label: "다른 모드 실행"
    description: "진단/수정/캐시/초기화 메뉴로 돌아감"
  - label: "종료"
    description: "doctor 종료"
```

## 진단 항목

- tfx-route.sh 설치 상태
- HUD 설치 및 설정 상태
- Codex/Gemini/Claude CLI 경로 (크로스 셸)
- **psmux 버전 / capability preflight**
  - `new-session`, `attach-session`, `kill-session`, `capture-pane`, `detach-client`
  - 권장 버전 이상인지 여부
- Codex Profiles (필수 프로파일 존재 여부)
- 스킬 설치 상태
- 플러그인 등록 상태
- MCP 인벤토리 캐시
- Phase 1 웜업 캐시 무결성 (`node scripts/cache-doctor.mjs`)
- 잔존 팀(orphan teams) 감지
- **Docs 동기화** — `docs/design/`, `docs/research/` → `~/.claude/docs/` 레퍼런스 문서 동기화 상태
- **Gemini MCP 안전성** — `~/.gemini/settings.json`의 stdio MCP 감지 (spawn EPERM 방지)
- **Route Script 정합성** — 프로젝트 소스 `scripts/tfx-route.sh`와 `~/.claude/scripts/tfx-route.sh` 일치 여부

## 에러 처리

| 상황 | 처리 |
|------|------|
| 캐시 디렉토리 없음 | 정상 — 삭제할 파일 없음 보고 |
| 파일 삭제 권한 없음 | 수동 삭제 안내 |
| --fix 후에도 이슈 남음 | Codex/Gemini 설치는 수동 필요 안내 |

## standalone TUI

터미널에서 직접 실행도 가능: `node tui/doctor.mjs` (arrow key 방식)
