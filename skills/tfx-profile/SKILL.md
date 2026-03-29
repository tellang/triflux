---
name: tfx-profile
description: >
  Codex CLI 프로파일/모델 관리 인터랙티브 UI. tfx-route가 사용하는
  프로파일 목록 조회, 모델 변경, effort 조정, 추가/삭제를 AskUserQuestion 기반
  인터랙티브 선택지로 수행합니다.
  Use when: codex profile, codex model, 프로파일 변경, 모델 변경, effort 변경,
  codex 설정, profile manager, 프로파일 관리, 어떤 모델, tfx profile
triggers:
  - tfx-profile
argument-hint: "[--list]"
---

# codex-profile — Codex 프로파일 매니저

> Codex CLI 프로파일의 모델/effort를 AskUserQuestion 선택지로 관리합니다.

## 워크플로우

### Step 1: config.toml 읽기 + 현재 상태 표시

`~/.codex/config.toml`을 Read 도구로 읽고 프로파일 테이블을 마크다운으로 출력한다:

```
| 프로파일 | 모델 | Effort |
|----------|------|--------|
| fast | gpt-5.3-codex | low |
| ...  | ...           | ...  |
```

기본 모델(top-level `model`)과 기본 effort도 함께 표시.

### Step 2: 작업 선택 (AskUserQuestion)

AskUserQuestion으로 메인 메뉴를 제시한다:

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

1. AskUserQuestion으로 프로파일 선택 (현재 프로파일 목록에서 2-4개씩 나눠서, 또는 "Other"로 직접 입력)
2. AskUserQuestion으로 모델 선택:
   ```
   question: "모델을 선택하세요"
   header: "Model"
   options:
     - label: "gpt-5.4"
       description: "최신 플래그십"
     - label: "gpt-5.3-codex"
       description: "코딩 특화 (Recommended)"
     - label: "gpt-5.1-codex-mini"
       description: "경량 Spark"
     - label: "o3"
       description: "추론 특화"
   ```
3. AskUserQuestion으로 effort 선택:
   ```
   question: "Reasoning Effort 레벨을 선택하세요"
   header: "Effort"
   options:
     - label: "low"
       description: "빠른 응답, 최소 추론"
     - label: "medium"
       description: "균형 잡힌 추론"
     - label: "high"
       description: "깊은 추론"
     - label: "xhigh"
       description: "최대 추론 (느림)"
   ```
4. 변경 diff를 preview로 보여주고 Edit 도구로 config.toml 수정

#### 기본 모델 변경

위와 동일한 모델/effort 선택 후 top-level `model`, `model_reasoning_effort` 수정.

#### 프로파일 추가

1. AskUserQuestion(Other)으로 프로파일 이름 입력
2. 모델 선택 → effort 선택
3. config.toml 끝에 새 `[profiles.name]` 섹션 추가

#### 프로파일 삭제

1. 프로파일 선택
2. AskUserQuestion 확인: "정말 삭제하시겠습니까?"
3. 해당 섹션 제거

### Step 4: 결과 확인

변경된 config.toml을 다시 읽어 업데이트된 테이블 표시.
"계속하시겠습니까?" AskUserQuestion → 반복 또는 종료.

## config.toml 수정 규칙

- **백업 필수**: 수정 전 원본 내용을 기억해둘 것 (rollback 가능하도록)
- **프로파일 섹션 형식**: `[profiles.name]\nmodel = "..."\nmodel_reasoning_effort = "..."`
- **다른 섹션 건드리지 않기**: `[notice]`, `[features]`, `[mcp_servers.*]`, `[projects.*]` 등은 절대 수정 금지
- **Edit 도구 사용**: old_string → new_string으로 정확한 섹션만 치환

## 참조

### 알려진 모델

| 모델 | 용도 |
|------|------|
| gpt-5.4 | 최신 플래그십 |
| gpt-5.3-codex | 코딩 특화 |
| gpt-5.1-codex-mini | 경량 Spark |
| o3 | 추론 특화 |
| o4-mini | 추론 경량 |

### Effort 레벨

| 레벨 | 설명 |
|------|------|
| low | 빠른 응답, 최소 추론 |
| medium | 균형 잡힌 추론 |
| high | 깊은 추론 |
| xhigh | 최대 추론 (느림) |

### config.toml 경로

`~/.codex/config.toml` (`$HOME/.codex/config.toml`)

## 에러 처리

| 상황 | 처리 |
|------|------|
| config.toml 미존재 | `/tfx-setup` 안내 |
| 파싱 실패 | 백업 후 수동 수정 안내 |
| 중복 프로파일명 | 이미 존재함 알림, 기존 편집으로 전환 |

## standalone TUI

터미널에서 직접 실행도 가능: `node tui/codex-profile.mjs` (arrow key 방식)
