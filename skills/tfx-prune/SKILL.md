---
name: tfx-prune
description: "AI가 생성한 불필요한 코드(슬롭)를 제거할 때 사용한다. 'deslop', '슬롭 제거', 'anti-slop', '코드 정리', '불필요한 코드 제거', '과잉 추상화 정리' 같은 요청에 반드시 사용. AI 생성 코드의 중복, 불필요 추상화, 과잉 에러 핸들링을 정리할 때 적극 활용."
triggers:
  - deslop
  - 슬롭 제거
  - anti-slop
  - 정리
  - slop
argument-hint: "[파일 경로 또는 git diff 범위]"
---

# tfx-prune — Tri-Verified AI Slop Remover

> OMC ai-slop-cleaner 오마주. 핵심 차별점: 단일 판단이 아닌 **3자 독립 감지 + 합의** 기반 제거.
> "AI가 만든 슬롭은 AI 3명이 합의해야 슬롭이다."

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

## MODEL ROLES

| CLI | 역할 | 감지 관점 |
|-----|------|----------|
| Claude (Opus) | 코드 품질 분석 + 합의 중재 | 설계 원칙, 코드 구조, 불필요 추상화 |
| Codex | AI 슬롭 탐지 | 구현 효율, 중복 패턴, 과잉 에러 핸들링 |
| Gemini | 가독성 평가 | 가독성/DX, 과잉 주석, 과잉 타입 |

## 슬롭 카테고리

| 카테고리 | 설명 | 예시 |
|----------|------|------|
| 불필요 추상화 | 단일 용도인데 인터페이스/팩토리/전략 패턴 적용 | `UserFactory` for 1 user type |
| 중복 코드 | 같은 로직의 반복 | 동일 validation을 3곳에 복붙 |
| 과잉 에러 핸들링 | 발생 불가능한 에러를 처리 | `catch (e) { /* impossible */ }` |
| 과잉 주석 | 코드가 이미 명확한데 주석 | `// increment i by 1` `i++` |
| 과잉 타입 | 불필요하게 복잡한 타입 정의 | 5단계 중첩 제네릭 |
| 사용되지 않는 코드 | import 했지만 사용 안 함 | dead imports, unused variables |
| 과잉 로깅 | 불필요한 console.log/debug | `console.log("here")` |

## EXECUTION STEPS

### Step 0: 슬롭 제거 범위 선택

인자 없이 호출된 경우 사용자에게 범위를 선택받는다:

```
1. 최근 변경 파일만 (git diff)
2. 전체 프로젝트
3. 특정 디렉토리 지정
```

- 1번 → `git diff HEAD`로 최근 변경 파일 대상
- 2번 → 프로젝트 전체 소스 파일 대상 (대규모 주의 경고 표시)
- 3번 → 추가 AskUserQuestion으로 대상 디렉토리 경로 입력받음

파일 경로나 git diff 범위가 인자로 이미 제공된 경우 이 단계를 건너뛴다.

### Step 1: 대상 파일 수집

대상 결정 우선순위:
1. 파일 경로 지정 → 해당 파일만
2. git diff 범위 지정 → diff에 포함된 파일
3. 입력 없음 → `git diff --name-only HEAD~1`로 최근 변경 파일
4. "all" → 프로젝트 전체 소스 파일 (주의: 대규모)

소스 파일만 필터: `.ts`, `.js`, `.mjs`, `.tsx`, `.py` 등. `node_modules`, `dist`, `build` 제외.

### Step 2: 3자 독립 슬롭 감지 (Anti-Herding)

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

Claude (Agent, background):
```
Agent(
  subagent_type="claude-sonnet-4-5",
  model="opus",
  run_in_background=true,
  prompt="다음 파일에서 AI 슬롭을 감지하세요. 코드 품질 관점으로 분석합니다.
슬롭 정의: 불필요 추상화, 중복, 과잉 에러핸들링, 과잉 주석, 과잉 타입, 미사용 코드, 과잉 로깅.
파일: {file_content}
각 발견에 대해 JSON: [{ id, category, line_start, line_end, description, severity, suggested_fix }]
severity: critical(기능에 영향) | high(가독성 심각) | medium(개선) | low(취향)
슬롭이 아닌 것은 보고하지 마세요. 과탐(false positive)보다 미탐이 낫습니다."
)
```

Codex + Gemini (Bash, background):
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:다음 파일에서 AI 슬롭을 감지하세요. 구현 효율 관점(중복 패턴, 과잉 에러핸들링, 미사용 코드)으로 분석. 파일: {file_content}. JSON: [{id,category,line_start,line_end,description,severity,suggested_fix}]. severity: critical|high|medium|low. 과탐보다 미탐이 낫습니다.:slop-detector' \
  --assign 'gemini:다음 파일에서 AI 슬롭을 감지하세요. 가독성/DX 관점(과잉 주석, 과잉 타입, 불필요 추상화)으로 분석. 파일: {file_content}. JSON: [{id,category,line_start,line_end,description,severity,suggested_fix}]. severity: critical|high|medium|low. 과탐보다 미탐이 낫습니다.:readability-reviewer' \
  --timeout 600")
```

### Step 3: 합의 필터링

3개 CLI 결과를 교차검증한다:

```
for each finding in ALL results:
  agreement = count(CLIs that found same or similar slop at same location)

  if agreement >= 2:
    → "CONFIRMED SLOP" — 제거 대상
  elif agreement == 1:
    → "UNCONFIRMED" — 제거하지 않음 (과탐 방지)
```

원칙: 2+ 합의된 항목만 제거한다. 1개 CLI만 지적한 항목은 무시한다.

### Step 4: 슬롭 제거

확정된 슬롭을 안전 순서대로 제거한다:

1. 과잉 주석 제거 (가장 안전)
2. 미사용 코드/import 제거
3. 과잉 로깅 제거
4. 과잉 에러핸들링 간소화
5. 중복 코드 통합
6. 불필요 추상화 제거 (가장 위험 — 인터페이스 변경 가능)

각 제거 후 변경 내용을 기록한다. 제거 이유를 주석으로 남기지 않는다 (그것 자체가 슬롭).

### Step 5: 회귀 테스트

제거 후 안전성을 검증한다:

1. 기존 테스트 실행: `Bash("npm test")` (또는 프로젝트 테스트 명령)
2. 테스트 실패 시 → 해당 제거를 롤백 → 롤백된 항목을 "위험 — 수동 검토 필요"로 표시
3. 테스트 통과 시 → 제거 확정

### Step 6: 보고서 출력

```markdown
## Deslop 보고서

### 요약
| 항목 | 수 |
|------|-----|
| 대상 파일 | {count} |
| 감지 (전체) | {total_findings} |
| 합의 확정 | {confirmed} |
| 미확정 (무시) | {unconfirmed} |
| 제거 완료 | {removed} |
| 롤백 (테스트 실패) | {rolled_back} |

### 제거된 슬롭
| # | 파일 | 라인 | 카테고리 | 합의 | 설명 |
|---|------|------|----------|------|------|
| 1 | auth.ts | 42-48 | 과잉 주석 | 3/3 | 자명한 코드에 장문 주석 |
| 2 | utils.ts | 15-20 | 미사용 import | 2/3 | lodash 미사용 |

### 미확정 (수동 검토 권장)
| # | 파일 | 라인 | 카테고리 | 지적 CLI | 설명 |
|---|------|------|----------|---------|------|
| 1 | api.ts | 80-95 | 불필요 추상화 | Codex만 | Factory 패턴 필요성 논쟁 |

### 테스트 결과
통과: {pass}/{total} | 실패: {fail} | 롤백: {rollback}
```

## ERROR RECOVERY

- Codex/Gemini 타임아웃(600s 초과) → Claude Agent 단독으로 2자 합의 기준(단독 감지도 제거 대상) 적용
- 테스트 명령 없음 → Step 5 건너뜀, 보고서에 "테스트 미실행 — 수동 검증 필요" 표시
- 파일 파싱 오류 → 해당 파일 스킵 후 보고서에 "파싱 실패" 기록

## TOKEN BUDGET

| 단계 | 토큰 |
|------|------|
| Step 1 (파일 수집) | ~0.5K |
| Step 2 (3x 독립 감지) | ~6K |
| Step 3 (합의 필터링) | ~1K |
| Step 4 (제거) | ~1.5K |
| Step 5 (회귀 테스트) | ~0.5K |
| Step 6 (보고서) | ~0.5K |
| **총합** | **~10K** |

## 사용 예

```
/tfx-prune
/tfx-prune src/auth/middleware.ts
/tfx-prune HEAD~5..HEAD
/정리 src/
/anti-slop "과잉 에러 핸들링 제거"
```
