---
name: tfx-consensus
description: 3자 합의 엔진 — 모든 Deep 스킬의 핵심 인프라. Claude/Codex/Gemini 독립 분석 결과를 교차검증하여 편향 없는 합의를 도출한다.
triggers: []
argument-hint: "(내부 전용 — Deep 스킬이 자동 호출)"
---

# tfx-consensus — Tri-CLI Consensus Engine

> **인프라**: 다른 스킬이 내부적으로 사용. 직접 호출할 필요 없음.
> 모든 Deep 스킬의 공통 기반. 3개 CLI의 독립 결과를 교차검증하여 합의 도출.

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

이 스킬은 직접 호출하지 않는다. `tfx-deep-*` 스킬이 내부적으로 사용한다.

## MODEL ROLES

| Model | Profile | 역할 | 강점 |
|-------|---------|------|------|
| Claude Opus | architect | 합의 통합 및 교차검증 조율 | 논리 분석, 불일치 해소 |
| Codex | analyst | 구현/보안 관점 독립 분석 | 코드 품질, 취약점 탐지 |
| Gemini | analyst | UX/문서화 관점 독립 분석 | DX, 접근성, 가독성 |

## EXECUTION STEPS

### Step 1: 독립 분석 dispatch (Anti-Herding)

3개 CLI가 **동시에, 상호 결과를 보지 않고** 독립 분석한다. 한 CLI의 결과가 다른 CLI에 영향을 주면 편향이 발생한다.

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

**도구 1 — Claude (Opus/Sonnet) 독립 분석:**
```
Agent(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  run_in_background=true,
  name="consensus-claude",
  description="독립 분석 — Claude 관점",
  prompt="{analysis_prompt} 출력 형식을 JSON으로 강제: { findings: [{ id: 'F1', category: '...', severity: 'critical|high|medium|low', description: '...', evidence: '...' }], summary: '...', confidence: 0.0-1.0 }"
)
```

**도구 2 — Codex+Gemini 독립 분석 headless dispatch:**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:{analysis_prompt} 출력 형식을 JSON으로 강제: { findings: [{ id: string, category: string, severity: critical|high|medium|low, description: string, evidence: string }], summary: string, confidence: 0.0-1.0 }:analyst' --assign 'gemini:{analysis_prompt} 출력 형식을 JSON으로 강제: { findings: [{ id: string, category: string, severity: critical|high|medium|low, description: string, evidence: string }], summary: string, confidence: 0.0-1.0 }:analyst' --timeout 600")
```

### Step 2: 교차검증 (Cross-Validation)

3개 결과(`result_claude`, `result_codex`, `result_gemini`)를 수집한 후 Claude가 통합 교차검증을 수행한다.

합의 분류 알고리즘:
- 각 finding에 대해 동의한 CLI 수를 집계
- `agreement_count >= 2` → **CONSENSUS** (합의됨)
- `agreement_count == 1` → **DISPUTED** (미합의 — 추가 검증 필요)
- `consensus_score = len(CONSENSUS) / len(ALL_UNIQUE) * 100`

`consensus_score >= 70`이면 Step 4로 직행. 미만이면 Step 3 진행.

### Step 3: Resolution (consensus_score < 70일 때만)

미합의 항목에 대해 2차 라운드를 진행한다.

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

**도구 1 — Claude 재검토:**
```
Agent(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  run_in_background=true,
  name="consensus-resolve-claude",
  description="미합의 항목 2차 검토",
  prompt="미합의 항목 목록: {disputed_items}. 다른 두 CLI의 반대 논거: Codex — {codex_rebuttal}, Gemini — {gemini_rebuttal}. 각 항목에 대해 수용(accept) 또는 반박(rebut)으로 응답하라. 수용 시 근거 필수."
)
```

**도구 2 — Codex+Gemini 재검토:**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:미합의 항목 목록: {disputed_items}. 다른 두 CLI의 반대 논거: Claude — {claude_rebuttal}, Gemini — {gemini_rebuttal}. 각 항목에 대해 수용(accept) 또는 반박(rebut)으로 응답하라. 수용 시 근거 필수.:analyst' --assign 'gemini:미합의 항목 목록: {disputed_items}. 다른 두 CLI의 반대 논거: Claude — {claude_rebuttal}, Codex — {codex_rebuttal}. 각 항목에 대해 수용(accept) 또는 반박(rebut)으로 응답하라. 수용 시 근거 필수.:analyst' --timeout 600")
```

Resolution 결과 처리:
- 수용 2개 이상 → CONSENSUS로 승격
- 여전히 미합의 → 사용자에게 판단 요청 (AskUserQuestion)

### Step 4: 최종 합의 결과 반환

Learned Weights를 `.omc/state/consensus-weights.json`에서 읽어 가중 투표에 적용한다:

```json
{
  "claude": { "accuracy": 0.85, "total": 100, "correct": 85 },
  "codex":  { "accuracy": 0.82, "total": 100, "correct": 82 },
  "gemini": { "accuracy": 0.78, "total": 100, "correct": 78 }
}
```

가중 투표:
`weighted_score = (claude_vote * 0.85 + codex_vote * 0.82 + gemini_vote * 0.78) / (0.85 + 0.82 + 0.78)`

최종 결과를 호출 스킬에 반환한다:

```json
{
  "consensus_score": 85,
  "consensus_items": [...],
  "disputed_items": [...],
  "resolved_items": [...],
  "user_decision_needed": [...],
  "cli_weights": { "claude": 0.85, "codex": 0.82, "gemini": 0.78 }
}
```

## ERROR RECOVERY

| 상황 | 대응 |
|------|------|
| headless timeout (600s) | Claude Agent로 해당 역할 대체 실행 |
| Codex 워커 실패 | Agent(oh-my-claudecode:architect, model="opus") 대체 |
| Gemini 워커 실패 | Agent(oh-my-claudecode:critic, model="sonnet") 대체 |

## 토큰 예산

| Phase | 토큰 |
|-------|------|
| Phase 1 (3x 독립분석) | ~15K (각 5K) |
| Phase 2 (교차검증) | ~3K |
| Phase 3 (Resolution, 필요 시) | ~8K |
| **총합** | **18-26K** |
