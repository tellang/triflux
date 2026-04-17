---
internal: true
name: tfx-plan
description: "구현 계획이 필요할 때 사용한다. '계획 세워줘', 'plan', '플랜', '어떻게 구현하지', '태스크 분해', '작업 순서' 같은 요청에 반드시 사용. 기능 구현 전 영향 범위 파악과 태스크 분해가 필요할 때 적극 활용. 작업 분해, 순서 정리, '어떤 순서로', '먼저 뭐 해야', 'breakdown', 'decompose', 'task list' 같은 요청에도 적극 활용. 단순 계획은 이 스킬, 3자 합의 계획은 tfx-deep-plan을 사용."
triggers:
  - plan
  - 계획
  - 플랜
  - 설계
argument-hint: "<구현할 기능 설명>"
---

# tfx-plan — Light Implementation Plan

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.

> **Telemetry**
>
> - Skill: `tfx-plan`
> - Description: `구현 계획이 필요할 때 사용한다. '계획 세워줘', 'plan', '플랜', '어떻게 구현하지', '태스크 분해', '작업 순서' 같은 요청에 반드시 사용. 기능 구현 전 영향 범위 파악과 태스크 분해가 필요할 때 적극 활용. 작업 분해, 순서 정리, '어떤 순서로', '먼저 뭐 해야', 'breakdown', 'decompose', 'task list' 같은 요청에도 적극 활용. 단순 계획은 이 스킬, 3자 합의 계획은 tfx-deep-plan을 사용.`
> - Session: 요청별 식별자를 유지해 단계별 실행 로그를 추적한다.
> - Errors: 실패 시 원인/복구/재시도 여부를 구조화해 기록한다.




> **Deep 버전**: tfx-deep-plan. "제대로/꼼꼼히" 수정자로 자동 에스컬레이션.
> Gemini 위임 빠른 계획 — Claude는 컨텍스트 수집·출력 포맷만, 핵심 계획 수립은 Gemini에 위임.

## 워크플로우

### Step 1: 요구사항 파싱
사용자 입력 + 프로젝트 컨텍스트(PROJECT_INDEX.md 있으면 활용)에서 핵심 추출.

### Step 2: Gemini 위임 계획 수립

Claude는 최소 컨텍스트만 수집한다.
- Glob으로 영향 가능 파일 목록 수집
- PROJECT_INDEX.md 존재 시 읽기 (없으면 생략)

수집 후 Gemini에 위임:
```
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec '소프트웨어 아키텍트로서 다음 기능의 구현 계획을 수립하라.\n기능: {feature}\n프로젝트 컨텍스트: {context}\n관련 파일: {file_list}\n\n출력 형식:\n1. 영향 범위 (수정할 파일 목록)\n2. 태스크 분해 (순서대로, 각 태스크에 검증 방법 포함)\n3. 리스크 및 의존성\n4. 예상 복잡도 (low/medium/high)'")
```

Claude는 Gemini 출력을 받아 아래 출력 형식으로 포맷팅만 수행한다.

> **Fallback**: Gemini 호출이 실패(exit non-zero 또는 빈 출력)하면 Claude Opus가 동일 프롬프트로 직접 계획을 수립한다.

### Step 3: 구조화된 계획 출력
```markdown
## 구현 계획: {feature}

### 영향 범위
- `src/auth/middleware.ts` — 신규 생성
- `src/routes/index.ts` — 수정 (라우트 추가)

### 태스크
1. [ ] {태스크1} → 검증: {확인 방법}
2. [ ] {태스크2} → 검증: {확인 방법}
3. [ ] {태스크3} → 검증: {확인 방법}

### 리스크
- {리스크1}: 완화 방안 — {방안}

### 복잡도: {level}
```

## 토큰 절감

| 구분 | 변경 전 | 변경 후 |
|------|---------|---------|
| Claude 입력 | ~6K (컨텍스트 + 계획 프롬프트) | ~1K (컨텍스트 수집 + 포맷 지시) |
| Claude 출력 | ~2K (계획 전문) | ~0.5K (포맷팅만) |
| 합계 | ~8K | ~1.5K (**-81%**) |

Gemini가 계획 생성의 대부분을 담당하므로 Claude 토큰 비용이 대폭 감소한다.
