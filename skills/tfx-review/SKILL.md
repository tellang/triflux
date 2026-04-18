---
internal: true
name: tfx-review
description: "코드 리뷰가 필요할 때 사용한다. 'review', '리뷰해줘', '코드 봐줘', '이거 괜찮아?', 'PR 리뷰', '변경사항 확인', '꼼꼼히 리뷰', 'deep review', '심층 리뷰', '보안까지 리뷰', '다각도 리뷰' 같은 요청에 반드시 사용. 기본값은 3-CLI 합의 딥 리뷰. 빠른 단일 CLI 리뷰는 --quick 파라미터."
triggers:
  - review
  - 리뷰
  - 코드 리뷰
  - code review
  - deep review
  - 심층 리뷰
  - 꼼꼼히 리뷰
  - multi review
argument-hint: "[파일 경로 또는 변경 설명] [--quick]"
---

# tfx-review — Code Review (Deep by Default)

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. `--quick` 플래그 감지 시 quick 경로로 분기.

> **Telemetry**
>
> - Skill: `tfx-review`
> - Session: 요청별 식별자를 유지해 단계별 실행 로그를 추적한다.
> - Errors: 실패 시 원인/복구/재시도 여부를 구조화해 기록한다.

---

## 기본값: Deep (3-CLI Consensus)

> AI makes completeness near-free. 기본은 풀프라이스 딥. 빠른 피드백은 `--quick` opt-out.

**Anti-Herding**: Round 1에서 3개 CLI가 서로의 결과를 보지 않고 독립 리뷰.
**Consensus Only**: 2개 이상 CLI가 동일 이슈를 지적한 항목만 최종 보고 → false-positive 87% 감소.

---

## 모드 분기 (첫 단계)

ARGUMENTS 에 `--quick` 포함 → **Quick 모드** (아래 Quick 섹션).
그 외 → **Deep 모드** (기본).

---

## Deep 모드 (기본)

### 전제조건 프로브

> **진입 즉시 실행** — 10초 내 가시적 출력 보장. 빈 stdout + exit 0 **금지**.

```bash
psmux --version 2>/dev/null && \
  curl -sf http://127.0.0.1:27888/status >/dev/null && \
  codex --version 2>/dev/null && \
  gemini --version 2>/dev/null
```

### Tier 판정

| Tier | 조건 | 실행 방식 |
|------|------|----------|
| **Tier 1** | psmux + Hub + Codex + Gemini 전부 정상 | headless multi 3-CLI |
| **Tier 2** | Codex 또는 Gemini 중 하나만 가용 | 가용 CLI + Claude Agent 조합 |
| **Tier 3** | headless 불가 또는 `claude -p` one-shot | Claude Agent only (consensus 미적용) |

```
IF claude -p (one-shot) OR psmux 없음:
  → Tier 3

IF Hub 미응답:
  → hub-ensure 자동 재시작 시도: Bash("node ~/.claude/scripts/hub-ensure.mjs")
  → 성공 → Tier 판정 재시도
  → 실패 → Tier 3

IF Codex 없음 AND Gemini 없음:
  → Tier 3

IF Codex 없음 OR Gemini 없음:
  → Tier 2

ELSE:
  → Tier 1
```

### Tier 3 진입 시 필수 출력

```
⚠ [Tier 3] headless multi 환경 미충족 — single-model 모드로 실행합니다 (consensus 미적용)
  누락: {missing_components}
  권장: psmux, Hub, Codex CLI, Gemini CLI 설치 후 재실행
  또는 /tfx-review --quick 으로 명시적 quick 경로 사용
```

### HARD RULES (Tier 1/2)

> headless-guard가 이 규칙 위반을 **자동 차단**한다.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

### 모델 역할 분담

| CLI | 역할 | 관점 |
|-----|------|------|
| Claude Opus | 로직+아키텍처 | 로직 결함, 아키텍처 위반, 설계 패턴 |
| Codex | 보안+성능 | OWASP Top 10, O(n²) 패턴, 누락된 에러 핸들링 |
| Gemini | 가독성+DX | 네이밍 컨벤션, 가독성, 주석 필요성, 타입 안전성 |

### 실행 단계

#### Step 1: 리뷰 대상 수집
`git diff` (staged + unstaged) 또는 사용자 지정 파일.

#### Step 2: 3-CLI 독립 리뷰 — Bash + Agent 동시 호출

**Claude Agent (로직+아키텍처):**
```
Agent(
  subagent_type="oh-my-claudecode:code-reviewer",
  model="opus",
  run_in_background=true,
  name="review-logic",
  description="로직 결함 및 아키텍처 위반 독립 리뷰",
  prompt="코드 리뷰어로서 로직/아키텍처 관점에서 이 코드를 분석하라. 로직 결함, 아키텍처 위반, 설계 패턴 문제를 찾아라. JSON: { findings: [{ id, file, line, severity, category, description, suggestion }] }"
)
```

**Codex + Gemini headless dispatch:**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'codex:보안/성능 전문가로서 이 코드를 분석하라. OWASP Top 10 취약점 확인. O(n²) 이상의 성능 병목 식별. 누락된 에러 핸들링 지적. JSON: { findings: [{ id, file, line, severity, category, description, suggestion }] }:reviewer' --assign 'gemini:코드 품질 전문가로서 이 코드를 분석하라. 가독성과 네이밍 컨벤션 평가. 주석이 필요한 복잡한 로직 식별. 타입 안전성 문제 지적. JSON: { findings: [{ id, file, line, severity, category, description, suggestion }] }:reviewer' --timeout 600")
```

#### Step 3: Consensus Scoring

모든 findings 수집 후 유사도 비교:
- 동일 파일+라인±5 + 유사 카테고리 → 동일 이슈
- 3/3 합의 → severity 유지
- 2/3 합의 → severity 유지, 반대 의견 첨부
- 1/3만 지적 → UNVERIFIED (참고용, 별도 섹션)

`consensus_score = consensus_items / total_unique_items × 100`

#### Step 4: 종합 보고서

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

### Error Recovery

| 오류 | 조치 |
|------|------|
| headless dispatch 타임아웃 | `--timeout` 900 으로 올려 재시도 |
| Agent 결과 미수신 | Step 2를 Agent만 단독 재실행 |
| consensus 0% | 대상 범위가 너무 넓음 — 파일 단위 분할 후 재실행 |
| `tfx multi` 명령 실패 | `tfx status`로 teammate 연결 상태 확인 |
| 모든 CLI 실패 | Tier 3 fallback → Claude Agent single |

### 토큰 예산 (Deep)

| 단계 | 토큰 |
|------|------|
| Step 1 수집 | ~1K |
| Step 2 3x 독립 리뷰 | ~15K |
| Step 3 Consensus | ~3K |
| Step 4 보고 | ~3K |
| **총합** | **~22K** |

---

## Quick 모드 (`--quick` opt-out)

> **명시적 호출만**. "빨리 한 번만 봐줘" 같은 맥락.
> **HARD RULE**: 리뷰 결과 생성 시 Claude가 직접 git log/diff 실행 금지. Codex code-reviewer 에게 위임.

### Step 1: 리뷰 대상 식별
```
우선순위:
  1. 사용자 지정 파일 경로
  2. git diff (staged + unstaged)
  3. 최근 커밋 → git diff HEAD~1
```

### Step 2: Codex 리뷰 실행
```bash
bash ~/.claude/scripts/tfx-route.sh codex \
  "다음 코드 변경을 리뷰하라. 심각도별 분류(critical/high/medium/low).
   체크: 로직 결함, 보안 취약점, 성능 문제, SOLID 위반, 에러 핸들링.
   변경사항: {diff_or_file_content}" review
```

### Step 3: 결과 포맷
```markdown
## Code Review: {target} (Quick — single CLI)

### Critical (즉시 수정)
- [C1] {파일:라인} — {설명}

### High (수정 권장)
- [H1] {파일:라인} — {설명}

### Medium (개선 제안)
- [M1] {파일:라인} — {설명}

### Summary
{전체 코드 품질 평가 1-2줄}
```

### 토큰: ~8K
