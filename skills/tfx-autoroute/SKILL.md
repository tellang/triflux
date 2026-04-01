---
name: tfx-autoroute
description: "작업 유형에 따라 최적 모델을 자동 선택하여 실행해야 할 때 사용한다. 'sisyphus', '시지프스', 'auto-route', '알아서 라우팅', '최적 모델로' 같은 요청에 사용. 어떤 CLI를 쓸지 모르겠을 때, 또는 실패 시 자동 모델 승격이 필요할 때 적극 활용."
triggers:
  - sisyphus
  - 끝없이
  - never stop
  - 시지프스
  - auto-route
argument-hint: "<작업 설명>"
---

# tfx-autoroute — Auto-Routing Autonomous Executor

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> oh-my-openagent Sisyphus agent 오마주. 바위는 멈추지 않는다 — 그리고 올바른 산을 고른다.
> "실패하면 더 강한 모델로. 성공할 때까지."

## 용도

- 작업 유형을 모르겠을 때 자동으로 최적 CLI 선택
- 실패 허용 없이 끝까지 완수해야 할 때
- Haiku로 충분한 작업에 Opus를 낭비하지 않을 때
- 비용 최적화 + 완수율 극대화

## 핵심 원리

```
1. IntentGate로 작업 유형 분류
2. 유형에 맞는 최적 CLI/모델에 라우팅
3. 실패 시 자동 승격 (Haiku → Sonnet → Opus, Codex normal → xhigh)
4. 최종 실패 시에만 사용자에게 보고
```

## 워크플로우

### Step 0: 라우팅 전략 선택

실행 전에 AskUserQuestion으로 모델 라우팅 전략을 선택받는다:

```
AskUserQuestion:
  "기본 라우팅 전략을 선택하세요:"
  1. 자동 (IntentGate 판단) [기본]
  2. 성능 우선 (Codex 위주)
  3. 비용 절약 (Haiku 위주)
  4. 정확도 우선 (Opus 위주)
```

- 1번 선택 → Step 1의 IntentGate 분류를 정상 수행
- 2번 선택 → primary_cli를 Codex(xhigh)로 고정, 실패 시에만 Opus fallback
- 3번 선택 → primary_cli를 Claude Haiku로 고정, 실패 시 Sonnet → Codex 순 승격
- 4번 선택 → primary_cli를 Claude Opus로 고정, fallback 없음

사용자가 빈 응답을 보내면 기본값 1번(자동)을 적용한다.

### Step 1: IntentGate 분류

사용자 입력을 분석하여 작업 카테고리와 복잡도를 판단한다:

```
분류 결과:
{
  "category": "visual | deep | quick | code | research | review",
  "complexity": "trivial | simple | moderate | complex | extreme",
  "estimated_tokens": N,
  "routing": {
    "primary_cli": "gemini | codex | claude",
    "primary_model": "flash | normal | haiku",
    "fallback_chain": ["sonnet", "opus"]
  }
}
```

### Step 2: 카테고리 라우팅

| 카테고리 | Primary CLI | Primary 모델 | 이유 |
|----------|-------------|-------------|------|
| visual (UI/디자인/멀티모달) | Gemini | flash | 시각적 처리 최적 |
| deep (아키텍처/설계/분석) | Codex | xhigh | 깊은 추론 필요 |
| quick (간단한 수정/질문) | Claude | haiku | 최소 비용 |
| code (구현/디버깅/리팩터링) | Codex | normal | 코드 작성 최적 |
| research (검색/문서/조사) | Codex | normal | MCP 접근 |
| review (리뷰/검증/QA) | Codex | thorough | 꼼꼼한 검토 |

### Step 3: 실행

라우팅 결과에 따라 실행한다:

```
if primary_cli == "codex":
  Bash("bash ~/.claude/scripts/tfx-route.sh codex '{prompt}' implement")

elif primary_cli == "gemini":
  Bash("bash ~/.claude/scripts/tfx-route.sh gemini '{prompt}' implement")

elif primary_cli == "claude":
  if primary_model == "haiku":
    Agent(model="haiku", prompt="{prompt}")
  else:
    Agent(model="sonnet", prompt="{prompt}")
```

### Step 4: 실패 감지 및 자동 승격

실행 결과를 평가하고, 실패 시 fallback chain을 따라 승격한다:

```
실패 판단 기준:
  - exit_code != 0
  - 출력에 "error", "failed", "unable to" 포함
  - 출력이 비어 있음
  - 출력이 프롬프트를 반복하기만 함 (hallucination)

승격 체인:
  Level 0: primary (최소 비용)
    ↓ 실패
  Level 1: 동일 CLI, 모델 한 단계 승격
    예: haiku → sonnet, codex normal → codex xhigh
    ↓ 실패
  Level 2: CLI 전환 + 강한 모델
    예: gemini → codex xhigh, codex → claude opus
    ↓ 실패
  Level 3: Claude Opus 직접 실행 (최후 수단)
    ↓ 실패
  Level 4: 사용자에게 보고 + 도움 요청 (AskUserQuestion)
```

### Step 5: 결과 보고

```markdown
## Sisyphus 완료

**작업**: {task_description}
**분류**: {category} / {complexity}
**라우팅**: {primary_cli} ({primary_model})
**승격 횟수**: {escalation_count}
**최종 실행**: {final_cli} ({final_model})

### 실행 경로
| 시도 | CLI | 모델 | 결과 | 토큰 |
|------|-----|------|------|------|
| 1 | Haiku | haiku | 실패 (불완전) | ~1K |
| 2 | Codex | normal | 성공 | ~3K |

### 결과
{output}

### 비용 절감
Primary Opus였다면: ~{opus_cost}K tokens
실제 사용: ~{actual_cost}K tokens
절감: {savings}%
```

## Anti-Stuck 메커니즘

```
같은 에러로 2회 연속 실패 시:
  → 에러 메시지를 다음 프롬프트에 포함하여 우회 시도

승격 체인 전체 소진 시 (Level 4):
  → AskUserQuestion: "다음 작업이 모든 모델에서 실패했습니다.
     에러: {error}. 접근 방식을 변경하시겠습니까?"
```

## 토큰 예산

가변. 최소 비용 라우팅이 핵심이므로 고정 예산 없음.

| 시나리오 | 예상 토큰 |
|----------|----------|
| 1회 성공 (haiku) | ~2K |
| 1회 성공 (codex) | ~5K |
| 1회 승격 후 성공 | ~8K |
| 2회 승격 후 성공 | ~15K |
| 전체 체인 소진 | ~25K |

## 사용 예

```
/tfx-autoroute "이 함수의 타입 에러 수정해"
/tfx-autoroute "프로젝트 구조 분석해서 아키텍처 다이어그램 만들어"
/tfx-autoroute "README.md 한국어로 번역"
/시지프스 "테스트 커버리지 80%까지 올려"
```
