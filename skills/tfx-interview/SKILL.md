---
internal: true
name: tfx-interview
description: "요구사항이 모호하거나 구현 전 명확화가 필요할 때 사용한다. 'interview', 'deep-interview', '딥인터뷰', '소크라테스', '깊이 탐색', '요구사항 분석', '인터뷰', '요구사항 정리', '뭘 만들어야 하는지 모르겠어', '명확하게 해줘' 같은 요청에 반드시 사용. 구현 시작 전 스펙을 확정하고 싶을 때 적극 활용."
triggers:
  - interview
  - deep-interview
  - 딥인터뷰
  - 소크라테스
  - 깊이 탐색
  - 요구사항 분석
  - 인터뷰
  - 요구사항 탐색
  - tfx-interview
  - 모호성 분석
argument-hint: "<구현할 주제 또는 요구사항>"
---

# tfx-interview — Quantified Socratic Requirements Exploration

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> OMC deep-interview + ouroboros 오마주. 모호성을 숫자로 측정하고 20% 미만까지 질문한다.
> "측정할 수 없으면 개선할 수 없다."
>
> **Gemini 위임**: 분석·점수 계산·산출물 초안은 Gemini CLI에 위임하여 Claude 토큰을 절약한다.
> 위임 패턴: `Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec '{prompt}'")`

## 위임 패턴

Claude와 Gemini의 역할을 분리하여 토큰을 최적화한다.

| 담당 | 작업 |
|------|------|
| **Claude** | AskUserQuestion (사용자 상호작용), 최종 파일 저장 |
| **Gemini** | 모호성 점수 계산, 질문 생성, 응답 분석, 산출물 초안 |

```bash
# 위임 호출 형태
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec '{prompt}'")
```

Gemini 실패 시 Fallback: Claude Opus가 분석을 직접 처리한다.

## 용도

- 구현 전 요구사항 명확화
- 모호한 요청을 정량적으로 분석하여 실행 가능한 수준으로 구체화
- 빠진 제약 조건, 성공 기준, 경계 조건을 체계적으로 발견
- 과잉 구현/과소 구현 방지

## 핵심: 모호성 점수 (Ambiguity Score)

요구사항의 모호성을 수학적으로 측정한다:

```
ambiguity = 1 - (goal × 0.40 + constraints × 0.30 + criteria × 0.30)

각 요소 (0.0 ~ 1.0):
  goal       — 목표 명확도. "무엇을 달성하려는가?"가 명확한가?
  constraints — 제약 조건 명확도. 범위, 기술 스택, 시간, 호환성 등
  criteria   — 성공 기준 명확도. "어떻게 되면 완료인가?"

예시:
  입력: "인증 기능 추가해"
  goal = 0.5 (인증이 무슨 인증? OAuth? JWT? 세션?)
  constraints = 0.2 (기술 스택? 기존 시스템 연동?)
  criteria = 0.1 (테스트? 성능? 보안 수준?)
  ambiguity = 1 - (0.5×0.40 + 0.2×0.30 + 0.1×0.30) = 1 - 0.29 = 0.71 (71%)

목표: ambiguity < 0.20 (20% 미만)이 될 때까지 질문 반복.
```

## 워크플로우

### Step 1: 초기 모호성 평가

사용자 입력을 Gemini에 전달하여 초기 ambiguity score를 계산한다:

```bash
# Claude → Gemini 위임
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec 'Analyze the following requirement and calculate ambiguity score. Return JSON: {goal, constraints, criteria, ambiguity, suggested_questions}: {user_input}'")
```

Gemini가 반환한 JSON에서 점수를 읽어 사용자에게 표시한다:

```
출력 예시:
  "📊 현재 모호성: 71%
   - 목표: 50% 명확 (어떤 인증 방식?)
   - 제약: 20% 명확 (기술 스택 미정)
   - 기준: 10% 명확 (완료 조건 없음)
   → Stage 1: Clarify부터 시작합니다."
```

### Step 2: 5단계 인터뷰 (모호성 < 20%까지)

각 단계에서 Claude가 AskUserQuestion으로 질문하고, 사용자 응답을 Gemini에 전달하여 분석 및 다음 질문을 생성한다.

흐름: `Claude(질문) → 사용자(응답) → Gemini(분석+재계산) → Claude(다음 질문 제시)`

#### Stage 1: Clarify (명확화) — goal 개선

```
질문 방향:
  - "정확히 무엇을 달성하려는가?"
  - "이 작업의 범위는 어디까지인가?"
  - "완료 후 어떤 상태가 되어야 하는가?"
```

```bash
# 응답 수집 후 Gemini에 분석 위임
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec 'Stage 1 response analysis. Previous context: {context}. User answer: {answer}. Calculate updated ambiguity score and generate next stage questions. Return JSON.'")
```

```
응답 후: Gemini JSON에서 goal 점수 읽기 → ambiguity 재계산 결과 사용자에게 표시
```

**질문 템플릿 (Gemini 실패 시 Fallback):**

1. "이 작업의 핵심 목표를 한 문장으로 설명해주세요."
2. "완료 후 어떤 상태가 되어야 성공인가요?"
3. "현재 상태에서 가장 큰 문제점은 무엇인가요?"

#### Stage 2: Decompose (분해) — constraints 개선

```
질문 방향:
  - "이것을 어떤 하위 문제로 나눌 수 있는가?"
  - "기술적 제약 조건은? (스택, 호환성, 성능)"
  - "의존하는 외부 시스템이나 API는?"
```

```bash
# 응답 수집 후 Gemini에 분석 위임
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec 'Stage 2 response analysis. Previous context: {context}. User answer: {answer}. Calculate updated ambiguity score and generate next stage questions. Return JSON.'")
```

```
응답 후: Gemini JSON에서 constraints 점수 읽기 → ambiguity 재계산 결과 사용자에게 표시
```

**질문 템플릿 (Gemini 실패 시 Fallback):**

1. "이 작업을 3-5개의 독립된 단계로 나눈다면?"
2. "각 단계 사이에 의존성이 있나요?"
3. "가장 먼저 해결해야 할 핵심 문제는 무엇인가요?"

#### Stage 3: Challenge (반론) — 숨은 제약 발견

```
질문 방향:
  - "이 접근의 약점은?"
  - "실패할 수 있는 시나리오는?"
  - "6개월 후 유지보수 관점에서 문제될 부분은?"
```

```bash
# 응답 수집 후 Gemini에 분석 위임
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec 'Stage 3 response analysis. Previous context: {context}. User answer: {answer}. Calculate updated ambiguity score and generate next stage questions. Return JSON.'")
```

```
응답 후: Gemini JSON에서 constraints + criteria 점수 읽기 → ambiguity 재계산 결과 사용자에게 표시
```

**질문 템플릿 (Gemini 실패 시 Fallback):**

1. "이 방식이 실패할 수 있는 시나리오는 무엇인가요?"
2. "6개월 후 유지보수할 때 문제가 될 부분은 무엇인가요?"
3. "이 접근이 다른 시스템에 미치는 영향은 무엇인가요?"

#### Stage 4: Alternatives (대안) — criteria 정밀화

```
질문 방향:
  - "다른 방법은 없는가?"
  - "시간이 절반이라면 어떤 방식을 택하겠는가?"
  - "각 대안의 trade-off는?"
```

```bash
# 응답 수집 후 Gemini에 분석 위임
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec 'Stage 4 response analysis. Previous context: {context}. User answer: {answer}. Calculate updated ambiguity score and generate next stage questions. Return JSON.'")
```

```
응답 후: Gemini JSON에서 criteria 점수 읽기 → ambiguity 재계산 결과 사용자에게 표시
```

**질문 템플릿 (Gemini 실패 시 Fallback):**

1. "같은 목표를 달성할 수 있는 완전히 다른 접근은 무엇인가요?"
2. "시간이 절반밖에 없다면 어떤 방식을 택하겠습니까?"
3. "이 기술 대신 다른 것을 사용하면 어떤 trade-off가 있나요?"

#### Stage 5: Synthesize (종합) — 최종 확인

```
질문 방향:
  - "지금까지의 논의를 종합하면 최적 경로는?"
  - "첫 번째로 실행할 단계는?"
  - "이 결정에 대한 확신도는? (1-10)"
```

```bash
# 응답 수집 후 Gemini에 최종 분석 위임
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec 'Stage 5 response analysis. Previous context: {context}. User answer: {answer}. Calculate updated ambiguity score and generate next stage questions. Return JSON.'")
```

```
응답 후: Gemini JSON에서 전체 점수 읽기 → 최종 ambiguity score 사용자에게 표시
```

**질문 템플릿 (Gemini 실패 시 Fallback):**

1. "지금까지의 논의를 종합하면, 최적의 접근 방식은 무엇인가요?"
2. "첫 번째 단계로 무엇을 실행하시겠습니까?"
3. "이 결정에 대해 확신하는 정도는 어느 정도인가요? (1-10)"

### Step 3: 조기 종료 판단

매 질문 후 ambiguity를 재계산하고, < 20%이면 남은 단계를 건너뛰고 종합 단계로 이동한다:

```
질문 후 재계산:
  if ambiguity < 0.20:
    → "📊 모호성 {score}% — 충분히 명확합니다. 종합 단계로 이동합니다."
    → Step 4로 직행
  elif ambiguity < 0.40:
    → "📊 모호성 {score}% — 거의 명확합니다. 핵심 질문 1-2개만 더."
  else:
    → 다음 단계 진행
```

### Step 4: 산출물 생성

Gemini가 인터뷰 전체 컨텍스트를 바탕으로 구조화된 문서 초안을 생성하고, Claude가 파일로 저장한다:

```bash
# Gemini에 산출물 초안 생성 위임
Bash("bash ~/.claude/scripts/tfx-route.sh gemini exec 'Generate a structured interview output document based on the following interview context: {full_context}. Return the complete markdown document.'")
```

Claude는 Gemini가 반환한 마크다운을 Write 도구로 저장한다.

저장 위치: `.tfx/plans/interview-{timestamp}.md`

산출물 형식:

```markdown
# Interview: {topic}
Date: {date} | Final Ambiguity: {score}%

## Ambiguity Breakdown
| 요소 | 초기 | 최종 | 개선 |
|------|------|------|------|
| Goal | {init}% | {final}% | +{delta}% |
| Constraints | {init}% | {final}% | +{delta}% |
| Criteria | {init}% | {final}% | +{delta}% |

## Goal
{1문장 목표}

## Constraints
{제약 조건 목록}

## Success Criteria
{성공 기준 목록}

## Risks & Challenges
{식별된 위험}

## Alternatives Considered
| 대안 | 장점 | 단점 | 채택 |
|------|------|------|------|
| ... | ... | ... | Y/N |

## Decision
{최종 결정 + 근거}

## Action Plan
1. {단계 1} → 검증: {check}
2. {단계 2} → 검증: {check}
3. ...
```

## 동작 규칙

1. 각 단계에서 반드시 사용자 응답을 수집한 후 다음으로 이동한다.
2. 매 응답 후 ambiguity score를 재계산하여 진행률을 표시한다.
3. ambiguity < 20%이면 남은 단계를 건너뛰어도 된다.
4. 5단계를 모두 거쳐도 ambiguity >= 20%이면 추가 질문 라운드를 진행한다 (최대 2회).
5. 인터뷰 시작 시 코드베이스를 탐색하여 관련 컨텍스트를 확보한다.
6. 이전 단계 답변을 다음 단계 질문에 반영한다 (대화형 연결).

## 토큰 예산

| 단계 | Claude | Gemini |
|------|--------|--------|
| 초기 평가 (모호성 분석) | ~0.2K | ~1K |
| 5단계 인터뷰 (질문 제시) | ~1K | ~10K |
| 산출물 초안 생성 | — | ~2K |
| 최종 파일 저장 | ~0.5K | — |
| 코드베이스 탐색 | ~0.3K | — |
| **총합** | **~2K** | **~13K** |

Fallback: Gemini 호출 실패 시 Claude Opus가 분석을 직접 처리한다 (총합 ~15K).

## 사용 예

```
/tfx-interview "인증 시스템 리팩터링"
/tfx-interview "실시간 알림 기능 추가"
/요구사항 분석 "데이터 파이프라인 설계"
/인터뷰 "레거시 API를 REST에서 GraphQL로 마이그레이션"
```
