---
internal: true
name: tfx-analysis
description: "코드나 아키텍처를 분석해야 할 때 사용한다. '코드 분석', 'code analysis', '아키텍처 분석', '이 코드 어떻게 돌아가?', '구조 파악', '심층 분석', '제대로 분석', '3관점 분석', '편향 없이 분석' 같은 요청에 반드시 사용. 기본값은 3-CLI 합의 딥 분석. 빠른 단일 CLI 분석은 --quick 파라미터."
triggers:
  - 코드 분석
  - code analysis
  - 아키텍처 분석
  - analysis
  - deep analyze
  - 심층 분석
  - deep-analysis
argument-hint: "<분석 대상> [--quick]"
---

# tfx-analysis — Code/Architecture Analysis (Deep by Default)

> **ARGUMENTS 처리**: ARGUMENTS 에 `--quick` 포함 → Quick 모드. 그 외 → Deep 모드 (기본).

> AI makes completeness near-free. 기본은 Claude(아키텍처) + Codex(보안/성능) + Gemini(UX/문서화) Tri-Debate 합의.
> 빠른 단일 CLI 분석은 `--quick` opt-out.

---

## 모드 분기 (첫 단계)

ARGUMENTS 에 `--quick` 포함 → **Quick 모드** (Codex 단일).
그 외 → **Deep 모드** (기본, 3-CLI Tri-Debate).

---

## Deep 모드 (기본)

### 전제조건 프로브 및 Tier Degradation

> **진입 즉시 실행** — 10초 내 가시적 출력 보장. 빈 stdout + exit 0 **금지**.

```bash
psmux --version 2>/dev/null && \
  curl -sf http://127.0.0.1:27888/status >/dev/null && \
  codex --version 2>/dev/null && \
  gemini --version 2>/dev/null
```

| Tier | 조건 | 실행 방식 |
|------|------|----------|
| **Tier 1** | psmux + Hub + Codex + Gemini 전부 | headless multi 3-CLI |
| **Tier 2** | Codex 또는 Gemini 중 하나만 | 가용 CLI + Claude Agent |
| **Tier 3** | headless 불가 | Claude Agent only (consensus 미적용) |

Tier 3 시:
```
⚠ [Tier 3] headless multi 환경 미충족 — single-model 모드 (consensus 미적용)
  누락: {missing}  |  권장: psmux + Hub + Codex + Gemini 설치
  또는 /tfx-analysis --quick 사용
```

### HARD RULES

1. `codex exec` / `gemini -p` 직접 호출 금지
2. Codex/Gemini → `Bash("tfx multi --teammate-mode headless ...")` 만
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent 동시 호출

### 모델 역할

| Model | 역할 | 강점 |
|-------|------|------|
| Claude Opus (architect) | 아키텍처/설계 | 레이어, SOLID, 확장성 |
| Codex (security-engineer) | 구현/보안 | 복잡도, OWASP, 기술 부채 |
| Gemini (ux-engineer) | UX/문서화 | DX, 접근성, 네이밍 |

### EXECUTION

#### Step 1: 범위 파싱
- target: 파일/디렉토리/주제
- scope: 전체 + 하위
- focus_areas: 아키텍처, 보안, 성능, DX

#### Step 2: 3-CLI 독립 분석 (Anti-Herding) — Bash + Agent 동시 호출

**Agent (Claude 아키텍처):**
```
Agent(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  run_in_background=true,
  name="arch-analyst",
  prompt="소프트웨어 아키텍트로서 분석하라. 대상: {target}. 렌즈: 아키텍처, SOLID, 응집도/결합도, 확장성, 테스트 용이성. JSON: { findings: [...], architecture_diagram: '...', health_score: 0-100 }"
)
```

**Codex + Gemini headless:**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:시니어+보안 엔지니어로서 분석하라. 대상: {target}. 렌즈: 구현 품질, 성능, OWASP, 안정성, 기술 부채. JSON: { findings: [...], metrics: {...}, health_score: 0-100 }:security-engineer' --assign 'gemini:UX 엔지니어+테크니컬 라이터로서 분석하라. 대상: {target}. 렌즈: DX, 문서화, 접근성, 국제화, 네이밍. JSON: { findings: [...], documentation_score: 0-100, health_score: 0-100 }:ux-engineer' --timeout 600")
```

#### Step 3: Tri-Debate (교차검증) — Bash + Agent 동시 호출

각 모델에게 다른 두 모델의 결과를 제시하여 ACCEPT/MODIFY/REJECT.

**Agent:**
```
Agent(subagent_type="oh-my-claudecode:architect", model="opus", run_in_background=true, name="arch-debate", prompt="다른 두 분석가 결과: A(Codex)={codex}, B(Gemini)={gemini}. 동의에 +1, 반대에 근거 반박, 놓친 사항 추가, health_score 재조정")
```

**Bash:** (위와 동일 패턴, Codex/Gemini 각각 교차검증)

합의 분류: 3/3 → CONFIRMED, 2/3 → LIKELY, 1/3 → UNVERIFIED.

#### Step 4: 합의 종합 보고서

```markdown
# Deep Analysis Report: {target}
**Consensus**: {score}% | **Health**: {weighted}/100 | **Analysts**: Claude/Codex/Gemini

## Executive Summary
{3-5줄 합의 기반 요약}

## Architecture
{구조도 + 강점/약점}

## 발견사항 (Critical/High/Medium, 합의 기반)
- [C1] `{file}:{line}` — {description} — 3/3
  - 아키텍처: {Claude} | 구현: {Codex} | DX: {Gemini}
  - 권장: {rec}

## 메트릭
| 항목 | 값 | 평가 |
| 아키텍처 건강도 | {n}/100 | ... |
| 구현 품질 | {n}/100 | ... |
| DX/문서화 | {n}/100 | ... |
| 종합 가중평균 | {n}/100 | ... |
| 기술 부채 | {h}h | ... |

## 개선 로드맵
| P | 항목 | 공수 | 합의 |
| P0 | ... | ...h | 3/3 |

## Unverified (참고용)
- [U1] {desc} (by {single_cli})
```

### Token (Deep): ~30K

---

## Quick 모드 (`--quick`)

### Step 1: 분석 대상 식별

```
우선순위:
  1. 파일/디렉토리 지정 → 해당 범위
  2. 주제 지정 → 관련 파일 탐색
  3. 지정 없음 → 프로젝트 전체 고수준

자동 감지:
  파일 1개 → 코드 품질 + 로직
  디렉토리 → 구조 + 의존성
  프로젝트 → 아키텍처 + 기술 부채
```

### Step 2: Codex 분석

```bash
bash ~/.claude/scripts/tfx-route.sh codex \
  "시니어 엔지니어로서 분석하라: 대상 {target}, 유형 {type}.
   분석: 구조, 복잡도, 품질(SOLID), 성능, 기술 부채, 테스트.
   구조화된 보고서." analyze
```

### Step 3: 결과 포맷

```markdown
## 분석 결과: {target}

### 구조 개요
{요약 또는 의존성 다이어그램}

### 주요 발견
| # | 카테고리 | 심각도 | 설명 | 위치 |

### 메트릭
- 파일/라인: {n}/{n} | 평균 복잡도: {n} | 최대: {n}

### 개선 권장
1. {P0} — ...
```

### Token (Quick): ~8K

## 사용 예

```
/tfx-analysis "src/auth/"                  # Deep (기본)
/tfx-analysis "src/utils/parser.ts"        # Deep
/tfx-analysis --quick "src/auth/"          # Quick (Codex 단일)
/tfx-analysis "프로젝트 전체 아키텍처"      # Deep
```
