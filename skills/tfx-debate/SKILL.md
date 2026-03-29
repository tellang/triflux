---
name: tfx-debate
description: "기술 선택, 아키텍처 비교, 설계 결정에서 3-CLI 구조화 토론으로 최적 답을 도출한다. 'A vs B', '뭐가 나을까', '비교해줘', '어떤 걸 쓸까', '장단점', 'tradeoff' 같은 비교/선택 요청에 반드시 사용한다. 단순 질문이 아닌 여러 옵션 사이의 결정이 필요할 때 적극 활용."
triggers:
  - debate
  - 토론
  - 3자 토론
  - tri-debate
  - 멀티모델 토론
argument-hint: "<토론 주제 또는 질문>"
---

# tfx-debate — Tri-CLI Structured Debate

> 3개 CLI가 독립 분석 → 교차검증 → 합의 도출. Anti-herding으로 편향 없는 결론.

## 용도

- 설계 결정에서 최적 방향을 찾을 때
- 코드 아키텍처 선택지 비교
- 기술 선택 (프레임워크, 라이브러리, 접근법)
- 요구사항 해석이 모호할 때
- 어떤 주제든 다관점 분석이 필요할 때

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

## MODEL ROLES

| CLI | 역할 |
|-----|------|
| Claude | 소프트웨어 아키텍트 — 시스템 설계 관점 |
| Codex | 시니어 백엔드 엔지니어 — 구현/기술적 트레이드오프 관점 |
| Gemini | DevOps/인프라 엔지니어 + DX 전문가 — 운영/개발자경험 관점 |

## EXECUTION STEPS

### Step 1: 주제 파싱 및 명확화

사용자 입력에서 토론 주제를 추출하라. 주제가 모호하거나 비교 대상이 불명확하면 AskUserQuestion으로 명확화하라:

```
AskUserQuestion:
  "토론 주제를 더 구체적으로 선택해주세요:"
  1. {옵션A} vs {옵션B} 기술 비교
  2. {주제} 아키텍처 접근법 비교
  3. 직접 입력
```

주제가 명확한 경우 (예: "REST vs GraphQL") 이 단계를 건너뛰어라.

파싱 결과를 내부적으로 보유하라:
- topic: 토론 주제
- context: 프로젝트 컨텍스트 (자동 추출)
- options: 비교 대상 목록
- criteria: 평가 기준 목록

### Step 2: 독립 분석 (Anti-Herding)

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

Claude Agent를 백그라운드로 실행하라:

```
Agent(
  subagent_type="claude",
  model="opus",
  run_in_background=true,
  prompt="당신은 소프트웨어 아키텍트입니다. {topic}에 대해 분석하세요.
  프로젝트 컨텍스트: {context}
  각 옵션의 장점, 단점, 리스크를 구조화하세요.
  최종 추천과 근거를 제시하세요.
  JSON 형식으로 출력하세요: { recommendation, reasoning, pros, cons, risks, confidence }"
)
```

Codex와 Gemini를 headless dispatch로 동시에 실행하라:

```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:당신은 시니어 백엔드 엔지니어입니다. {topic}에 대해 구현 관점에서 분석하세요. 프로젝트 컨텍스트: {context}. 각 옵션의 기술적 트레이드오프를 평가하고 구현 난이도, 성능, 확장성을 중심으로 분석하세요. JSON 형식으로 출력하세요: { recommendation, reasoning, pros, cons, risks, confidence }:analyst' \
  --assign 'gemini:당신은 DevOps/인프라 엔지니어이자 DX 전문가입니다. {topic}에 대해 운영+개발자경험 관점에서 분석하세요. 프로젝트 컨텍스트: {context}. 배포 복잡도, 모니터링, 온보딩 난이도, 개발자 생산성을 중심으로 분석하세요. JSON 형식으로 출력하세요: { recommendation, reasoning, pros, cons, risks, confidence }:analyst' \
  --timeout 600")
```

### Step 3: 결과 수집 및 교차검증

3개 결과가 모두 수집되면 다음 기준으로 교차검증하라:

합의 수준을 판정하라:
- 3/3 동일 추천 → "만장일치" (Strong Consensus) → Step 5로 바로 진행
- 2/3 동일 추천 → "다수 합의" (Majority Consensus) → Step 5로 진행
- 3개 모두 다름 → "불일치" (Disputed) → Step 4 토론 라운드 실행

항목별 교차검증을 수행하라:
- 2개 이상 CLI가 동일 장점/단점 지적 → 확정
- 1개 CLI만 지적 → "미검증" 표시

### Step 4: 토론 라운드 (불일치 시에만 실행)

불일치 항목이 있으면 각 CLI에게 다음 프롬프트로 2차 라운드를 실행하라.

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

Claude Agent를 백그라운드로 실행하라:

```
Agent(
  subagent_type="claude",
  model="opus",
  run_in_background=true,
  prompt="다음은 다른 두 분석가의 결론입니다.
  분석가 A (백엔드 엔지니어): {codex_recommendation} — 근거: {codex_reasoning}
  분석가 B (DevOps/DX): {gemini_recommendation} — 근거: {gemini_reasoning}

  당신의 원래 입장: {claude_recommendation}

  다른 분석가의 논거를 검토한 후:
  1. 수용할 점이 있으면 입장을 수정하세요
  2. 반박할 점이 있으면 근거를 제시하세요
  3. 최종 추천을 JSON으로 다시 제출하세요: { recommendation, reasoning, confidence, changed }"
)
```

Codex와 Gemini 2차 라운드를 headless dispatch로 동시에 실행하라:

```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:다음은 다른 두 분석가의 결론입니다. 분석가 A (아키텍트): {claude_recommendation} — 근거: {claude_reasoning}. 분석가 B (DevOps/DX): {gemini_recommendation} — 근거: {gemini_reasoning}. 당신의 원래 입장: {codex_recommendation}. 다른 분석가의 논거를 검토한 후 수용할 점은 반영하고 반박할 점은 근거를 제시하세요. JSON으로 최종 추천을 제출하세요: { recommendation, reasoning, confidence, changed }:analyst' \
  --assign 'gemini:다음은 다른 두 분석가의 결론입니다. 분석가 A (아키텍트): {claude_recommendation} — 근거: {claude_reasoning}. 분석가 B (백엔드 엔지니어): {codex_recommendation} — 근거: {codex_reasoning}. 당신의 원래 입장: {gemini_recommendation}. 다른 분석가의 논거를 검토한 후 수용할 점은 반영하고 반박할 점은 근거를 제시하세요. JSON으로 최종 추천을 제출하세요: { recommendation, reasoning, confidence, changed }:analyst' \
  --timeout 600")
```

### Step 5: 최종 종합

Claude Opus가 전체 토론을 종합하여 다음 구조로 최종 보고서를 작성하라:

```markdown
## 토론 결과: {topic}

### 합의 사항 (Consensus Score: {score}%)
- [항목 1] — 3/3 합의
- [항목 2] — 2/3 합의 (반대: {dissenter} — 근거: {reason})

### 최종 추천
{recommendation}

### 근거 (3자 종합)
{synthesized_reasoning}

### 리스크 및 완화 방안
{risks_and_mitigations}

### 불일치 (해소되지 않은 항목)
{unresolved_disputes — if any}
```

## ERROR RECOVERY

- Codex 또는 Gemini 결과가 없으면: 2개 소스로 교차검증을 진행하고 보고서에 누락 CLI를 명시하라
- tfx multi 명령이 실패하면: 오류 메시지를 출력하고 재시도 1회 후 실패를 사용자에게 보고하라
- Agent 결과가 없으면: Claude 관점 없이 나머지 2개 소스로 진행하라
- Round 2 후에도 불일치가 지속되면: 해소되지 않은 항목으로 보고서에 명시하고 최종 추천은 다수결로 결정하라

## TOKEN BUDGET

| 단계 | 토큰 |
|------|------|
| Step 2 (3x 독립) | ~15K |
| Step 3 (교차검증) | ~2K |
| Step 4 (토론, 불일치 시) | ~8K |
| Step 5 (종합) | ~3K |
| **총합** | **20-28K** |

## 사용 예

```
/tfx-debate "우리 서비스에 Redis vs PostgreSQL LISTEN/NOTIFY for real-time events"
/tfx-debate "모노레포 vs 멀티레포 for our 3-service architecture"
/tfx-debate "이 함수를 리팩터링할 때 Strategy 패턴 vs 단순 switch-case"
```
