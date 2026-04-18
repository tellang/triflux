---
internal: true
name: tfx-qa
description: "테스트/검증이 필요할 때 사용한다. 'qa', '검증해', '테스트 돌려', 'test-fix', '심층 검증', '철저히 테스트', '보안까지 확인', '전방위 검증' 같은 요청에 반드시 사용. 기본값은 3-CLI 합의 딥 QA (기능+보안+UX). 빠른 테스트-수정 루프는 --quick."
triggers:
  - qa
  - 검증
  - 테스트 검증
  - test-fix
  - deep qa
  - 심층 검증
  - thorough test
  - deep-qa
argument-hint: "[테스트 대상] [--quick]"
---

# tfx-qa — Test & Verification (Deep by Default)

> **ARGUMENTS 처리**: ARGUMENTS 에 `--quick` 포함 → Quick 모드. 그 외 → Deep 모드 (기본).

> AI makes completeness near-free. 기본은 Claude(기능/엣지) + Codex(보안/성능) + Gemini(UX/접근성) 3-CLI 독립 검증 + 교차검증 + 자동 수정.
> 빠른 테스트-수정 루프는 `--quick`.

---

## 모드 분기

`--quick` → Quick 모드 (Codex test-fix 루프).
그 외 → Deep 모드 (기본, 3-CLI consensus + fix).

---

## Deep 모드 (기본)

### 전제조건 프로브 및 Tier Degradation

> **진입 즉시 실행**. 빈 stdout + exit 0 **금지**.

```bash
psmux --version 2>/dev/null && \
  curl -sf http://127.0.0.1:27888/status >/dev/null && \
  codex --version 2>/dev/null && \
  gemini --version 2>/dev/null
```

| Tier | 조건 | 실행 방식 |
|------|------|----------|
| **Tier 1** | 전부 정상 | headless multi 3-CLI |
| **Tier 2** | 일부 CLI | 가용 CLI + Claude Agent |
| **Tier 3** | headless 불가 | Claude Agent only |

Tier 3 시:
```
⚠ [Tier 3] headless multi 환경 미충족 (consensus 미적용)
  누락: {missing} | 권장: 설치 후 재실행 또는 /tfx-qa --quick
```

### HARD RULES

1. `codex exec` / `gemini -p` 직접 호출 금지
2. Codex/Gemini → `Bash("tfx multi --teammate-mode headless --assign ...")` 만
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent 동시 호출

### 모델 역할

| CLI | 역할 | 관점 |
|-----|------|------|
| Claude Opus | 기능검증 | 정확성, 엣지케이스, 누락 테스트 |
| Codex | 보안+성능 | OWASP, O(n²), 메모리, 입력 검증 |
| Gemini | UX+접근성 | 응답 일관성, 에러 메시지, WCAG |

### EXECUTION

#### Step 1: 검증 대상 수집
1. 지정 경로 → 해당 범위
2. `git diff` → 변경 파일
3. 지정 없음 → 프로젝트 전체

#### Step 2: 3-CLI 독립 검증 (Anti-Herding) — Bash + Agent 동시 호출

**Agent (Claude 기능검증):**
```
Agent(
  subagent_type="oh-my-claudecode:verifier",
  model="opus",
  run_in_background=true,
  name="qa-functional",
  prompt="QA 엔지니어로서 기능 정확성 검증. 테스트 실행 + 엣지 케이스(null, 빈, 경계값, 동시성) + 누락 테스트 제안. JSON: { test_result: {pass,fail,skip}, findings: [...], edge_case_tests: [...], overall_verdict: 'pass'|'fail' }"
)
```

**Codex + Gemini headless:**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:보안/성능 전문가. OWASP Top 10, O(n²), 메모리 누수, 입력 검증 누락. JSON: { findings: [...], overall_verdict: \"pass\"|\"fail\" }:verifier' --assign 'gemini:UX/접근성 전문가. API 응답 일관성, 에러 메시지, WCAG 2.1 AA, 문서-동작 일치. JSON: { findings: [...], overall_verdict: \"pass\"|\"fail\" }:verifier' --timeout 600")
```

#### Step 3: Consensus Scoring
- 동일 파일+라인±5 + 유사 카테고리 → 동일 이슈
- 3/3 → CONFIRMED, 2/3 → LIKELY, 1/3 → UNVERIFIED

#### Step 4: 합의된 Critical/High 수정

```
Bash("tfx multi --teammate-mode headless --assign 'codex:합의된 이슈 수정. 최소 변경으로 수정 + 테스트 재실행: {consensus_findings}:fixer' --timeout 300")
```

#### Step 5: 종합 보고서

```markdown
## Deep QA Report: {target}
**Consensus**: {score}% | **Verdict**: PASS / CONDITIONAL / FAIL

### Critical (3/3)
### High (2/3)
### Verified Medium
### 엣지 케이스 테스트 제안
### Unverified
### 수정 요약
### 통계
```

### Token (Deep): ~25K

---

## Quick 모드 (`--quick`)

### Step 1: 테스트 대상 식별
1. 테스트 명령 지정 → 그대로
2. 파일 지정 → 관련 테스트 탐색
3. 지정 없음 → package.json test / pytest / make test 자동 감지

### Step 2: 실행 (Round 1)

```bash
bash ~/.claude/scripts/tfx-route.sh codex \
  "테스트 실행 + 실패 분석: {test_command}" implement
```

### Step 3: 실패 수정 루프 (최대 3회)

```
WHILE (failures > 0 AND retry < 3):
  Codex 실패 수정 → 재실행
```

### Step 4: 결과 보고

```markdown
## QA 결과: {target}
| 라운드 | 통과 | 실패 | 수정 |
### 최종: {pass}/{total}
### 수정된 파일
### 미해결 실패 (있으면)
```

### Token (Quick): ~5K

## 사용 예

```
/tfx-qa                                    # Deep
/tfx-qa "src/auth/ 변경사항"               # Deep
/tfx-qa --quick                            # Quick
/tfx-qa --quick "npm test -- --grep auth"  # Quick
```
