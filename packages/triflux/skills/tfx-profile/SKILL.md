---
name: tfx-profile
description: >
  Codex/Antigravity CLI 프로파일·모델 관리 인터랙티브 UI. tfx-route가 사용하는
  프로파일 목록 조회, 모델 변경, effort 조정, 추가/삭제를 AskUserQuestion 기반
  인터랙티브 선택지로 수행합니다.
  Use when: codex profile, codex model, gemini profile, gemini model,
  프로파일 변경, 모델 변경, effort 변경, codex 설정, gemini 설정,
  profile manager, 프로파일 관리, 어떤 모델, tfx profile
triggers:
  - tfx-profile
argument-hint: "[--list] [--codex | --gemini]"
---

# tfx-profile — Codex/Antigravity 프로파일 매니저

> CLI 프로파일의 모델/effort를 AskUserQuestion 선택지로 관리합니다.
> Codex(`~/.codex/config.toml`)와 Antigravity(`~/.gemini/triflux-profiles.json`) 모두 지원.

## 워크플로우

### Step 0: CLI 선택

인자에 `--codex` 또는 `--gemini`가 있으면 해당 CLI로 직행.
없으면 AskUserQuestion으로 선택:

```
question: "어느 CLI의 프로파일을 관리하시겠습니까?"
header: "CLI"
options:
  - label: "Codex"
    description: "~/.codex/config.toml (TOML)"
  - label: "Antigravity"
    description: "~/.gemini/triflux-profiles.json (JSON)"
```

---

## Codex 워크플로우

### Step 1: config.toml 읽기 + 현재 상태 표시

`~/.codex/config.toml`을 Read 도구로 읽고 프로파일 테이블을 마크다운으로 출력한다:

```
| 프로파일 | 모델 | Effort |
|----------|------|--------|
| gpt55_high | config.toml의 현재 프로필 값 | high |
| ...  | ...           | ...  |
```

기본 모델(top-level `model`)과 기본 effort도 함께 표시.

### Step 2: 작업 선택 (AskUserQuestion)

```
question: "어떤 작업을 하시겠습니까?"
header: "작업"
options:
  - label: "프로파일 모델 변경"
    description: "기존 프로파일의 모델/effort를 수정"
  - label: "기본 모델 변경"
    description: "top-level default 모델/effort 수정"
  - label: "프로파일 추가"
    description: "새 프로파일 생성"
  - label: "프로파일 삭제"
    description: "기존 프로파일 제거"
```

### Step 3: 선택에 따른 세부 플로우

#### 프로파일 모델 변경

1. AskUserQuestion으로 프로파일 선택
2. AskUserQuestion으로 프로필/alias 선택:
   ```
   options:
     - label: "gpt55_high"  → 기본 고품질 (Recommended)
     - label: "gpt55_med"   → 균형형
     - label: "gpt55_low"   → 빠른 경량
     - label: "gpt55_xhigh" → 최대 추론
     - label: "custom"      → 사용자가 관리하는 프로필
   ```
3. AskUserQuestion으로 effort 선택: `low | medium | high | xhigh`
4. Edit 도구로 config.toml 수정

#### 기본 모델 변경

위와 동일한 모델/effort 선택 후 top-level `model`, `model_reasoning_effort` 수정.

#### 프로파일 추가/삭제

추가: 이름 → 모델 → effort → `[profiles.name]` 섹션 추가
삭제: 선택 → 확인 → 섹션 제거

### Step 4: 결과 확인

변경된 config.toml을 다시 읽어 업데이트된 테이블 표시.

---

## Antigravity 워크플로우

### Step 1: triflux-profiles.json 읽기 + 현재 상태 표시

`~/.gemini/triflux-profiles.json`을 Read 도구로 읽고 프로필 테이블을 마크다운으로 출력한다:

```
| 프로필 | 모델 | 설명 |
|--------|------|------|
| pro31  | profiles.json의 현재 프로필 값 | 플래그십 프로필 |
| flash3 | profiles.json의 현재 프로필 값 | 빠른 응답 프로필 |
| ...    | ...                    | ...                 |
```

기본 모델(top-level `model`)도 함께 표시.

### Step 2: 작업 선택 (AskUserQuestion)

```
question: "어떤 작업을 하시겠습니까?"
header: "작업"
options:
  - label: "프로필 모델 변경"
    description: "기존 프로필의 모델을 수정"
  - label: "기본 모델 변경"
    description: "top-level default 모델 수정"
  - label: "프로필 추가"
    description: "새 프로필 생성"
  - label: "프로필 삭제"
    description: "기존 프로필 제거"
```

### Step 3: 선택에 따른 세부 플로우

#### 프로필 모델 변경

1. AskUserQuestion으로 프로필 선택
2. AskUserQuestion으로 프로필 선택:
   ```
   options:
     - label: "pro31"   → 플래그십 프로필
     - label: "flash3"  → 빠른 응답 프로필
     - label: "pro25"   → 안정 예비 프로필
     - label: "flash25" → 대량 배치 프로필
     - label: "lite25"  → 최경량 프로필
   ```
3. Edit 도구로 triflux-profiles.json 수정

#### 기본 모델 변경

모델 선택 후 top-level `model` 수정.

#### 프로필 추가/삭제

추가: 이름 → 모델 → 설명 → profiles에 추가
삭제: 선택 → 확인 → profiles에서 제거

### Step 4: 결과 확인

변경된 JSON을 다시 읽어 업데이트된 테이블 표시.

---

## 수정 규칙

### Codex (config.toml)

- **백업 필수**: 수정 전 원본 기억
- **프로파일 섹션 형식**: `[profiles.name]\nmodel = "..."\nmodel_reasoning_effort = "..."`
- **다른 섹션 건드리지 않기**: `[notice]`, `[features]`, `[mcp_servers.*]` 등 절대 수정 금지
- **Edit 도구 사용**: old_string → new_string으로 정확한 섹션만 치환

### Antigravity (triflux-profiles.json)

- **백업 필수**: `.bak` 자동 생성
- **JSON 형식 유지**: `profiles.{name}.model`, `profiles.{name}.hint`
- **Edit 도구 사용**: old_string → new_string으로 해당 프로필만 치환

## 참조

### Codex 프로필

| 프로필 | 용도 |
|------|------|
| gpt55_high | 기본 고품질 |
| gpt55_xhigh | 최대 추론 |
| gpt55_med | 균형형 |
| gpt55_low | 빠른 경량 |
| custom | 사용자가 관리하는 프로필 |

### Codex Effort 레벨

| 레벨 | 설명 |
|------|------|
| low | 빠른 응답, 최소 추론 |
| medium | 균형 잡힌 추론 |
| high | 깊은 추론 |
| xhigh | 최대 추론 (느림) |

### Antigravity 프로필

| 프로필 | 용도 |
|------|------|
| pro31 | 플래그십 프로필 |
| flash3 | 빠른 응답, 비용 효율 프로필 |
| pro25 | 안정 예비 프로필 |
| flash25 | 대량 배치 프로필 |
| lite25 | 최경량 프로필 |

### Antigravity → 에이전트 배치 (벤치마크 기반)

| 프로필 | 용도 | 에이전트 |
|--------|------|----------|
| pro31 | 플래그십 | executor, debugger, deep-executor, architect, planner, critic, analyst, code-reviewer, security-reviewer, quality-reviewer, scientist-deep, designer |
| flash3 | 빠른 응답 | writer, build-fixer, spark, 기본 폴백 |
| pro25 | 안정 예비 | 불안정 시 폴백 |
| flash25 | 대량 배치 | 예비 |
| lite25 | 최경량 | 예비 |

### 설정 파일 경로

- Codex: `~/.codex/config.toml`
- Antigravity: `~/.gemini/triflux-profiles.json`

## 에러 처리

| 상황 | 처리 |
|------|------|
| config.toml 미존재 | `/tfx-setup` 안내 |
| triflux-profiles.json 미존재 | 기본값으로 자동 생성 |
| 파싱 실패 | 백업 후 수동 수정 안내 |
| 중복 프로파일명 | 이미 존재함 알림, 기존 편집으로 전환 |

## standalone TUI

터미널에서 직접 실행:
- Codex: `node tui/codex-profile.mjs`
- Antigravity: `node tui/gemini-profile.mjs`
