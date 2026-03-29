---
name: tfx-deep-review
description: "철저한 코드 리뷰가 필요할 때 사용한다. '꼼꼼히 리뷰', 'deep review', '심층 리뷰', '보안까지 리뷰', '다각도 리뷰', '중요한 변경이라 제대로 봐줘' 같은 요청에 사용. 보안/성능/가독성 3관점 독립 검증이 필요한 중요 코드 변경에 적극 활용."
triggers:
  - deep review
  - 심층 리뷰
  - multi review
  - deep-review
  - 철저한 리뷰
argument-hint: "[파일 경로 또는 변경 설명]"
---

# tfx-deep-review — Tri-CLI Deep Code Review

> 3-CLI 독립 리뷰 → 교차검증 → 2+ 합의 항목만 보고. Diffray + Calimero 영감.

## 핵심 원리

**Anti-Herding**: Round 1에서 3개 CLI가 서로의 결과를 보지 않고 독립 리뷰.
**Consensus Only**: 2개 이상 CLI가 동일 이슈를 지적한 항목만 최종 보고 → false-positive 87% 감소.

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

## MODEL ROLES

| CLI | 역할 | 관점 |
|-----|------|------|
| Claude Opus | 로직+아키텍처 | 로직 결함, 아키텍처 위반, 설계 패턴 |
| Codex | 보안+성능 | OWASP Top 10, O(n²) 패턴, 누락된 에러 핸들링 |
| Gemini | 가독성+DX | 네이밍 컨벤션, 가독성, 주석 필요성, 타입 안전성 |

## EXECUTION STEPS

### Step 1: 리뷰 대상 수집

`git diff` (staged + unstaged) 또는 사용자 지정 파일을 수집한다.

### Step 2: 3-CLI 독립 리뷰 — 아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.

**Claude Agent (로직+아키텍처):**
```
Agent(
  subagent_type="oh-my-claudecode:code-reviewer",
  model="opus",
  run_in_background=true,
  name="review-logic",
  description="로직 결함 및 아키텍처 위반 독립 리뷰",
  prompt="코드 리뷰어로서 로직/아키텍처 관점에서 이 코드를 분석하라. 로직 결함, 아키텍처 위반, 설계 패턴 문제를 찾아라. JSON으로 응답하라: { findings: [{ id, file, line, severity, category, description, suggestion }] }"
)
```

**Codex + Gemini headless dispatch (보안+성능+가독성):**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:보안/성능 전문가로서 이 코드를 분석하라. OWASP Top 10 취약점을 확인하라. O(n²) 이상의 성능 병목을 찾아라. 누락된 에러 핸들링을 지적하라. JSON으로 응답하라: { findings: [{ id, file, line, severity, category, description, suggestion }] }:reviewer' --assign 'gemini:코드 품질 전문가로서 이 코드를 분석하라. 가독성과 네이밍 컨벤션을 평가하라. 주석이 필요한 복잡한 로직을 식별하라. 타입 안전성 문제를 찾아라. 개발자 경험(DX)을 저해하는 패턴을 지적하라. JSON으로 응답하라: { findings: [{ id, file, line, severity, category, description, suggestion }] }:reviewer' --timeout 600")
```

### Step 3: Consensus Scoring

모든 findings를 수집하여 유사도를 비교한다:
- 동일 파일+라인±5 + 유사 카테고리 → 동일 이슈로 간주
- 3/3 합의 → severity 유지
- 2/3 합의 → severity 유지, 반대 의견 첨부
- 1/3만 지적 → UNVERIFIED 표시 (참고용, 별도 섹션)

`consensus_score = consensus_items / total_unique_items × 100`

### Step 4: 종합 보고서 작성

아래 형식으로 보고서를 출력한다:

```markdown
## Deep Code Review: {target}
**Consensus Score**: {score}% | **Reviewers**: Claude/Codex/Gemini

### Critical (3/3 합의)
- [C1] `{file}:{line}` — {description}
  - Claude: {detail} | Codex: {detail} | Gemini: {detail}
  - **Fix**: {suggestion}

### High (2/3 합의)
- [H1] `{file}:{line}` — {description}
  - 합의: {agreers} | 반대: {dissenter}: "{reason}"

### Verified Medium
- ...

### Unverified (1/3만 지적, 참고용)
- [U1] `{file}:{line}` — {description} (by {single_cli})

### 통계
| CLI | 발견 수 | 합의 기여율 |
|-----|---------|------------|
| Claude | {n} | {%} |
| Codex | {n} | {%} |
| Gemini | {n} | {%} |
```

## ERROR RECOVERY

| 오류 | 조치 |
|------|------|
| headless dispatch 타임아웃 | `--timeout` 값을 900으로 올려 재시도 |
| Agent 결과 미수신 | Step 2를 Agent만 단독 재실행 |
| consensus 0% | 대상 범위가 너무 넓음 — 파일 단위로 분할 후 재실행 |
| tfx multi 명령 실패 | `tfx status`로 teammate 연결 상태 확인 |

## 토큰 예산

| 단계 | 토큰 |
|------|------|
| Step 1 (수집) | ~1K |
| Step 2 (3x 독립 리뷰) | ~15K |
| Step 3 (Consensus) | ~3K |
| Step 4 (보고) | ~3K |
| **총합** | **~22K** |
