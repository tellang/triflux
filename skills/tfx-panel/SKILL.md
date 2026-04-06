---
internal: true
name: tfx-panel
description: "여러 전문가의 의견이 필요한 복잡한 결정에 사용한다. 'panel', '패널', '전문가 의견', 'expert panel', '다양한 관점', '전문가한테 물어봐' 같은 요청에 반드시 사용. 아키텍처, 보안, 비즈니스 전략 등 전문가 시뮬레이션이 필요할 때 적극 활용."
triggers:
  - panel
  - 패널
  - 전문가 토론
  - expert panel
  - 전문가 패널
argument-hint: "<토론 주제>"
---

# tfx-panel — Virtual Expert Panel Simulation

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> SuperClaude spec-panel + business-panel 오마주. 실제 전문가 5-10명의 관점을 시뮬레이션하여 다각적 분석.
> "한 사람의 시야는 좁다. 패널의 시야는 넓다."

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

## MODEL ROLES

| CLI | 역할 | 담당 전문가 유형 |
|-----|------|----------------|
| Claude (Opus) | 패널 모더레이터 + 인문/전략 전문가 | 리팩터링, 점진적 설계, 요구사항 |
| Codex | 기술 구현 전문가 | 아키텍처, 마이크로서비스, 클라우드 |
| Gemini | 통합/비즈니스 전문가 | 통합 패턴, 경쟁 전략, 프로덕트 |

## 전문가 풀

주제에 따라 5-10명을 자동 선정한다. 고정 풀이 아니라 주제 맥락에서 최적 전문가를 결정한다.

### 기술 전문가 (예시)

| 전문가 | 전문 분야 | 관점 |
|--------|----------|------|
| Martin Fowler | 리팩터링, 패턴 | 코드 설계 품질, 기술 부채 |
| Sam Newman | 마이크로서비스 | 서비스 경계, 분산 시스템 |
| Kent Beck | TDD, XP | 테스트, 점진적 설계 |
| Gregor Hohpe | 통합 패턴 | 메시징, 이벤트 아키텍처 |
| Brendan Burns | 클라우드 네이티브 | 컨테이너, 오케스트레이션 |

### 비즈니스/전략 전문가 (예시)

| 전문가 | 전문 분야 | 관점 |
|--------|----------|------|
| Michael Porter | 경쟁 전략 | 시장 포지셔닝, 가치 사슬 |
| Karl Wiegers | 요구사항 공학 | 요구사항 완전성, 우선순위 |
| Eric Ries | 린 스타트업 | MVP, 검증된 학습 |
| Marty Cagan | 프로덕트 | 가치, 실현 가능성, 비즈니스 |

## EXECUTION STEPS

### Step 0: 패널 도메인 선택

주제 인자가 없으면 사용자에게 도메인을 선택받는다:

```
1. 소프트웨어 아키텍처 (Fowler, Newman, Vernon, Evans)
2. 보안 (OWASP, Trail of Bits, Schneier)
3. 비즈니스 전략 (Porter, Christensen, Drucker)
4. DevOps/SRE (Humble, Kim, Forsgren)
5. 프론트엔드/UX (Nielsen, Cooper, Krug)
6. 직접 구성
```

"직접 구성" 선택 시 사용자가 전문가 이름/역할을 직접 지정한다.

### Step 1: 주제 분석 및 전문가 선정

사용자 입력에서 주제를 파싱하고 관련 도메인을 식별한다. 5-10명의 전문가를 선정하여 3개 CLI에 분배한다.

분배 예시 (`"우리 모놀리스를 마이크로서비스로 전환해야 할까?"`):
- Claude 담당: Martin Fowler (리팩터링), Kent Beck (점진적 설계)
- Codex 담당: Sam Newman (마이크로서비스), Michael Porter (전략)
- Gemini 담당: Gregor Hohpe (통합 패턴), Karl Wiegers (요구사항)

주제가 모호하면 AskUserQuestion으로 명확화한다.

### Step 2: 독립 분석 (Anti-Herding)

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

Claude (Agent, background):
```
Agent(
  subagent_type="claude-sonnet-4-5",
  model="opus",
  run_in_background=true,
  prompt="당신은 {claude_expert_1}({role_1})과 {claude_expert_2}({role_2})입니다.
주제: {topic}
각 전문가의 고유 관점에서 독립적으로 분석하세요. 상대 전문가의 입장을 참조하지 마세요.
JSON 형식으로 응답:
{ 'experts': [{ 'name': string, 'position': string, 'reasoning': string, 'concerns': string[], 'recommendation': string, 'confidence': number }] }"
)
```

Codex + Gemini (Bash, background):
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:당신은 {codex_expert_1}({role_3})과 {codex_expert_2}({role_4})입니다. 주제: {topic}. 각 전문가의 고유 관점에서 독립 분석. 상호 참조 금지. JSON: {experts:[{name,position,reasoning,concerns,recommendation,confidence}]}:analyst' \
  --assign 'gemini:당신은 {gemini_expert_1}({role_5})과 {gemini_expert_2}({role_6})입니다. 주제: {topic}. 각 전문가의 고유 관점에서 독립 분석. 상호 참조 금지. JSON: {experts:[{name,position,reasoning,concerns,recommendation,confidence}]}:analyst' \
  --timeout 600")
```

### Step 3: 패널 토론 시뮬레이션

3개 CLI 결과 수집 후 Claude Opus가 패널 모더레이터로 교차 토론을 시뮬레이션한다:

1. 각 전문가 의견 정리 — 합의점 / 분쟁점 식별
2. 분쟁점에 대해 가상 반론 생성:
   - "{expert_A}은 {position_A}를 주장하지만, {expert_B}는 {position_B}를 권고합니다. {expert_A}의 반론은? {expert_B}의 재반론은?"
3. 2차 라운드: 반론을 반영한 수정 의견 도출

### Step 4: 합의 종합

tfx-consensus 프로토콜 적용:

- 과반(50%+) 합의 → "패널 합의" (근거 포함)
- 소수 의견 → "소수 견해" (근거 포함)
- 대립 → "미해결 쟁점" (양측 근거 병기)

### Step 5: 최종 패널 보고서 출력

```markdown
## 전문가 패널 보고서: {topic}

### 패널 구성
| # | 전문가 | 역할 | 핵심 입장 |
|---|--------|------|----------|
| 1 | {name} | {role} | {position} |

### 패널 합의 (Consensus Score: {score}%)
- [합의 1] — {N}/{total} 합의
- [합의 2] — {N}/{total} 합의

### 소수 견해
- {expert}: {dissenting_view} — 근거: {reason}

### 핵심 추천
{패널 종합 추천}

### 리스크 및 완화 방안
{전문가들이 식별한 리스크와 대응책}

### 미해결 쟁점
{패널 내 해소되지 않은 논쟁}

### 다음 단계 (Action Items)
1. {action_1}
2. {action_2}
```

## ERROR RECOVERY

- Codex/Gemini 타임아웃(600s 초과) → Claude Agent로 해당 전문가 재분석
- 결과 파싱 실패 → 원문 그대로 Step 3에 투입하여 모더레이터가 정리
- 전문가 선정 불확실 → AskUserQuestion으로 사용자 확인 후 진행

## TOKEN BUDGET

| 단계 | 토큰 |
|------|------|
| Step 1 (주제 분석 + 선정) | ~2K |
| Step 2 (3x 독립 분석) | ~15K |
| Step 3 (패널 토론) | ~8K |
| Step 4 (합의 종합) | ~2K |
| Step 5 (보고서) | ~3K |
| **총합** | **~30K** |

## 사용 예

```
/tfx-panel "우리 모놀리스를 마이크로서비스로 전환해야 할까?"
/tfx-panel "React vs Svelte vs Solid for our next frontend"
/tfx-panel "이 레거시 시스템의 리팩터링 전략"
/tfx-panel "B2B SaaS 가격 모델: 사용량 기반 vs 티어 기반"
```
