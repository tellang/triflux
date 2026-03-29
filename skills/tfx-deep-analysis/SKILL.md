---
name: tfx-deep-analysis
description: "다각도 심층 분석이 필요할 때 사용한다. 'deep analyze', '심층 분석', '제대로 분석', '3관점 분석', '편향 없이 분석' 같은 요청에 사용. 아키텍처 결정, 기술 부채 평가, 대규모 리팩터링 전 분석에 적극 활용."
triggers:
  - deep analyze
  - 심층 분석
  - deep-analysis
argument-hint: "<분석 대상 — 파일, 디렉토리, 또는 주제>"
---

# tfx-deep-analysis — Tri-CLI Deep Analysis

> Claude(아키텍처) + Codex(구현/보안) + Gemini(UX/문서화) → Tri-Debate → 합의.
> 3자 전문 관점의 편향 없는 분석.

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

## 용도

- 아키텍처 결정 전 종합 분석
- 레거시 코드베이스 상태 진단
- 보안 + 성능 + UX 교차 분석
- 기술 부채 종합 평가
- 리팩터링 범위 결정
- 마이그레이션 전 영향도 분석

## MODEL ROLES

| Model | Profile | 역할 | 강점 |
|-------|---------|------|------|
| Claude Opus | architect | 아키텍처/설계 분석 | 레이어 분리, SOLID, 확장성 |
| Codex | security-engineer | 구현/보안 분석 | 복잡도, OWASP, 기술 부채 |
| Gemini | ux-engineer | UX/문서화 분석 | DX, 접근성, 네이밍, 국제화 |

## EXECUTION STEPS

### Step 1: 범위 파싱

분석 대상(`{target}`)을 파싱하고 분석 범위를 확정한다:
- target: 사용자가 지정한 파일/디렉토리/주제
- scope: 디렉토리 전체 + 하위 모듈
- analysis_depth: 파일 구조 + 코드 본문 + 의존성
- focus_areas: 아키텍처, 보안, 성능, DX

### Step 2: 3-CLI 독립 분석 (Anti-Herding)

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

**도구 1 — Claude Opus (아키텍처):**
```
Agent(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  run_in_background=true,
  name="arch-analyst",
  description="아키텍처 심층 분석",
  prompt="소프트웨어 아키텍트로서 분석하라. 대상: {target}. 분석 렌즈: 1. 아키텍처 — 레이어 분리, 의존성 방향, 순환 참조. 2. 설계 패턴 — SOLID 준수, 적절한 추상화 수준. 3. 모듈 응집도/결합도 — cohesion/coupling 평가. 4. 확장성 — 새 요구사항 추가 시 변경 범위. 5. 테스트 용이성 — DI, 인터페이스, mock 가능성. JSON으로 반환: { findings: [{id, category, severity, description, location, recommendation}], architecture_diagram: '텍스트 기반 구조도', health_score: 0-100 }"
)
```

**도구 2 — Codex+Gemini headless dispatch:**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:시니어 엔지니어+보안 전문가로서 분석하라. 대상: {target}. 분석 렌즈: 1. 구현 품질 — 복잡도, 중복, 에러 핸들링. 2. 성능 — 알고리즘 효율, 메모리 패턴, I/O 병목. 3. 보안 — OWASP Top 10, 입력 검증, 인증/인가. 4. 안정성 — 에러 전파, 장애 격리, 리소스 관리. 5. 기술 부채 — deprecated API, TODO, 하드코딩. JSON: { findings: [...], metrics: {complexity, loc, tech_debt_hours}, health_score: 0-100 }:security-engineer' --assign 'gemini:UX 엔지니어+테크니컬 라이터로서 분석하라. 대상: {target}. 분석 렌즈: 1. DX(개발자 경험) — API 직관성, 에러 메시지, 사용 용이성. 2. 문서화 — JSDoc/주석 품질, README, 예제 코드. 3. 접근성 — UI가 있으면 WCAG 2.1 AA, 키보드/스크린리더. 4. 국제화 — 하드코딩 문자열, 로케일 처리. 5. 네이밍 — 일관성, 도메인 언어, 가독성. JSON: { findings: [...], documentation_score: 0-100, health_score: 0-100 }:ux-engineer' --timeout 600")
```

### Step 3: Tri-Debate (교차검증)

3개 결과를 수집한 후, **아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

**도구 1 — Claude 교차검증:**
```
Agent(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  run_in_background=true,
  name="arch-debate",
  description="교차검증 — 아키텍처 관점",
  prompt="다른 두 분석가의 결과입니다. 분석가 A(Codex): {codex_findings_summary}. 분석가 B(Gemini): {gemini_findings_summary}. 1. 동의하는 발견에 '+1' 표시. 2. 반대하는 발견에 근거를 제시하여 반박. 3. 다른 분석가가 놓친 중요 사항 추가. 4. health_score를 재조정하라."
)
```

**도구 2 — Codex+Gemini 교차검증:**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:다른 두 분석가의 결과입니다. 분석가 A(Claude): {claude_findings_summary}. 분석가 B(Gemini): {gemini_findings_summary}. 1. 동의하는 발견에 +1 표시. 2. 반대하는 발견에 근거를 제시하여 반박. 3. 다른 분석가가 놓친 중요 사항 추가. 4. health_score를 재조정하라.:security-engineer' --assign 'gemini:다른 두 분석가의 결과입니다. 분석가 A(Claude): {claude_findings_summary}. 분석가 B(Codex): {codex_findings_summary}. 1. 동의하는 발견에 +1 표시. 2. 반대하는 발견에 근거를 제시하여 반박. 3. 다른 분석가가 놓친 중요 사항 추가. 4. health_score를 재조정하라.:ux-engineer' --timeout 600")
```

교차검증 후 합의 분류:
- 3/3 동의 → CONFIRMED
- 2/3 동의 → LIKELY (반대 의견 첨부)
- 1/3만 지적 → UNVERIFIED

### Step 4: 합의 종합 보고서 출력

아래 형식으로 최종 보고서를 출력한다:

```markdown
# Deep Analysis Report: {target}
**Consensus Score**: {score}% | **Analysts**: Claude/Codex/Gemini
**Health Score**: {weighted_avg}/100

## Executive Summary
{3-5줄 핵심 요약 — 3자 합의 기반}

## Architecture
{Claude 주도 분석 + Codex/Gemini 교차검증}
### 구조도
{텍스트 기반 아키텍처 다이어그램}
### 강점
- {3/3 합의된 아키텍처 강점}
### 약점
- {2+ 합의된 아키텍처 약점}

## 발견사항 (합의된 항목)

### Critical
- [C1] `{file}:{line}` — {description} — {3/3}
  - 아키텍처: {Claude} | 구현: {Codex} | DX: {Gemini}
  - **권장**: {recommendation}

### High
- [H1] ...

### Medium
- [M1] ...

## 메트릭
| 항목 | 값 | 평가 |
|------|-----|------|
| 아키텍처 건강도 | {Claude score}/100 | {평가} |
| 구현 품질 | {Codex score}/100 | {평가} |
| DX/문서화 | {Gemini score}/100 | {평가} |
| 종합 (가중평균) | {avg}/100 | {평가} |
| 기술 부채 추정 | {hours}h | {심각도} |

## 개선 로드맵 (합의 순)
| 우선순위 | 항목 | 예상 공수 | 합의도 |
|---------|------|----------|--------|
| P0 | {item} | {hours}h | 3/3 |
| P1 | {item} | {hours}h | 2/3 |

## Unverified (참고용)
- [U1] {description} (by {single_cli})

## 불일치 사항
- {항목}: Claude는 {X}, Codex는 {Y}, Gemini는 {Z}
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
| Phase 1 (수집) | ~1K |
| Phase 2 (3x 독립분석) | ~15K |
| Phase 3 (Tri-Debate) | ~9K |
| Phase 4 (보고서) | ~5K |
| **총합** | **~30K** |
