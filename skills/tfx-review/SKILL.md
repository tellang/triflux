---
internal: true
name: tfx-review
description: "코드 리뷰가 필요할 때 사용한다. 'review', '리뷰해줘', '코드 봐줘', '이거 괜찮아?', 'PR 리뷰', '변경사항 확인', '꼼꼼히 리뷰', 'deep review', '심층 리뷰', '보안까지 리뷰', '다각도 리뷰', '코드 검증', '전방위 검증' 같은 요청에 반드시 사용."
argument-hint: "[파일 경로 또는 변경 설명] [--quick]"
---

# tfx-review 코드 리뷰

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. `--quick` 플래그 감지 시 quick 경로로 분기.

## QA·검증 요청의 경계

테스트·검증 요청은 성격에 따라 나눈다.

| 요청 | 처리 |
|------|------|
| 변경분의 정확성·엣지 케이스·보안·성능 판정 | 이 스킬 Deep 모드. 테스트를 돌렸다면 그 결과를 리뷰 입력에 넣는다 |
| 테스트 실행 → 실패 수정 반복 | `tfx-auto` (기본 `--retry 1`의 bounded verify→fix 3회) |
| 브라우저·사용자 흐름 검증 | gstack `/qa` |

---

## 기본값: Deep (3-CLI Consensus)

> 기본은 Deep 모드다. 빠른 피드백은 `--quick`을 지정한다.

**Anti-Herding**: Round 1에서 3개 CLI가 서로의 결과를 보지 않고 독립 리뷰.
**Consensus Only**: 2개 이상 CLI가 동일 이슈를 지적한 항목을 합의 결과로 보고한다. 단독 지적은 별도 섹션에 둔다.

---

## 모드 분기 (첫 단계)

ARGUMENTS 에 `--quick` 포함 → **Quick 모드** (아래 Quick 섹션).
그 외 → **Deep 모드** (기본).

---

## Deep 모드 (기본)

### 전제조건 프로브

> **진입 즉시 실행**: 10초 내 가시적 출력 보장. 빈 stdout + exit 0 **금지**.

```bash
if codex --version >/dev/null 2>&1; then
  printf 'Codex: available\n'
else
  printf 'Codex: unavailable\n'
fi
if agy --version >/dev/null 2>&1; then
  printf 'Antigravity: available\n'
else
  printf 'Antigravity: unavailable\n'
fi
```

### Tier 판정

| Tier | 조건 | 실행 방식 |
|------|------|----------|
| **Tier 1** | Codex + Antigravity 전부 정상 | auto multi 3-CLI (tmux/psmux 리드면 interactive) |
| **Tier 2** | Codex 또는 Antigravity 중 하나만 가용 | 가용 CLI + Claude Agent 조합 |
| **Tier 3** | Codex와 Antigravity 모두 불가 | Claude Agent only (consensus 미적용) |

```
IF Codex 없음 AND Antigravity 없음:
  → Tier 3

IF Codex 없음 OR Antigravity 없음:
  → Tier 2

ELSE:
  → Tier 1
```

### Tier 3 진입 시 필수 출력

```
⚠ [Tier 3] multi 실행 환경 미충족: single-model 모드로 실행합니다 (consensus 미적용)
  누락: {missing_components}
  권장: Codex CLI, Antigravity CLI 설치 후 재실행
  또는 /tfx-review --quick 으로 명시적 quick 경로 사용
```

### HARD RULES (Tier 1/2)

> 자동 차단 훅은 없다. 아래 규칙은 호출자가 지킨다.

1. **`codex exec` 직접 호출 및 deprecated Gemini CLI 직접 호출 절대 금지**
2. Codex·Antigravity → `Bash("tfx multi --assign 'cli:프롬프트:역할' --timeout 1800", run_in_background=true)` **만** 사용. teammate mode는 생략해 `auto` 기본값을 쓰며, foreground Bash는 하니스가 600s에 강제 종료. 결과는 task-notification 후 회수
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

### 모델 역할 분담

| CLI | 역할 | 관점 |
|-----|------|------|
| Claude Opus | 로직+아키텍처 | 로직 결함, 아키텍처 위반, 설계 패턴 |
| Codex | 보안+성능 | OWASP Top 10, O(n²) 패턴, 누락된 에러 핸들링 |
| Antigravity | 가독성+DX | 네이밍 컨벤션, 가독성, 주석 필요성, 타입 안전성 |

### 실행 단계

#### Step 1: 리뷰 대상 수집
`git diff` (staged + unstaged) 또는 사용자 지정 파일.

#### Step 2: 3-CLI 독립 리뷰: Bash + Agent 동시 호출

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

**Codex + Antigravity multi dispatch (auto):**
```
Bash("tfx multi --assign 'codex:보안/성능 전문가로서 이 코드를 분석하라. OWASP Top 10 취약점 확인. O(n²) 이상의 성능 병목 식별. 누락된 에러 핸들링 지적. JSON: { findings: [{ id, file, line, severity, category, description, suggestion }] }:code-reviewer' --assign 'antigravity:코드 품질 전문가로서 이 코드를 분석하라. 가독성과 네이밍 컨벤션 평가. 주석이 필요한 복잡한 로직 식별. 타입 안전성 문제 지적. JSON: { findings: [{ id, file, line, severity, category, description, suggestion }] }:code-reviewer' --timeout 1800", run_in_background=true)
```

> 배리어: 위 dispatch는 background로 실행한다. task-notification 완료 후 team runtime 결과에서 Codex/Antigravity findings를 회수하고, Agent 결과도 TaskOutput으로 수집한 다음에만 Step 3을 진행한다.

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
**Consensus Score**: {score}% | **Reviewers**: Claude/Codex/Antigravity

### Critical (3/3 합의)
- [C1] `{file}:{line}`: {description}
  - Claude: {detail} | Codex: {detail} | Antigravity: {detail}
  - **Fix**: {suggestion}

### High (2/3 합의)
- [H1] `{file}:{line}`: {description}
  - 합의: {agreers} | 반대: {dissenter}: "{reason}"

### Verified Medium
- ...

### Unverified (1/3만 지적, 참고용)
- [U1] `{file}:{line}`: {description} (by {single_cli})

### 통계
| CLI | 발견 수 | 합의 기여율 |
|-----|---------|------------|
| Claude | {n} | {%} |
| Codex | {n} | {%} |
| Antigravity | {n} | {%} |
```

### Error Recovery

| 오류 | 조치 |
|------|------|
| multi dispatch 타임아웃 | 부분 출력(PARTIAL OUTPUT/.partial) 먼저 회수, 미완료분만 `--timeout 3600` + run_in_background 로 재시도 |
| Agent 결과 미수신 | Step 2를 Agent만 단독 재실행 |
| consensus 0% | 대상 범위가 너무 넓음: 파일 단위 분할 후 재실행 |
| `tfx multi` 명령 실패 | 명령의 stderr와 CLI 가용성을 확인 |
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

변경사항 원문이나 경로를 셸 인자에 끼우지 않는다. diff 안의 `$(...)` 와 백틱이 실행된다.
리뷰 대상을 파일로 쓰고 리뷰어가 그 파일 전체를 직접 읽게 한다. context_file(다섯 번째 인자)은
32KB 에서 잘리므로 쓰지 않는다.

```bash
ctx=$(mktemp "${TMPDIR:-/tmp}/tfx-review.XXXXXX")
git diff HEAD > "$ctx"                    # Step 1 의 2번
[ -s "$ctx" ] || git diff HEAD~1 > "$ctx" # Step 1 의 3번
bash ~/.claude/scripts/tfx-route.sh code-reviewer \
  "리뷰 대상은 $ctx 파일이다. 파일 전체를 끝까지 읽고 리뷰하라. 경로 목록이면 그 파일들을 읽는다.
   심각도별 분류(critical/high/medium/low).
   체크: 로직 결함, 보안 취약점, 성능 문제, SOLID 위반, 에러 핸들링."
rm -f "$ctx"
```

Step 1 의 1번(사용자 지정 파일)이면 `git diff` 두 줄 대신 Write 도구로 경로 목록을 `$ctx` 에 쓴다.

### Step 3: 결과 포맷
```markdown
## Code Review: {target} (Quick, single CLI)

### Critical (즉시 수정)
- [C1] {파일:라인}: {설명}

### High (수정 권장)
- [H1] {파일:라인}: {설명}

### Medium (개선 제안)
- [M1] {파일:라인}: {설명}

### Summary
{전체 코드 품질 평가 1-2줄}
```

### 토큰: ~8K
