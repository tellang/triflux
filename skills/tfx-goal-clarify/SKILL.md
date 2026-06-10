---
name: tfx-goal-clarify
description: "자연어 아이디어를 Claude Code `/goal` 명령어 한 블록으로 변환하는 clarifier. 모호한 작업 설명을 받아 공식 3축(End state / Stated check / Constraints) + stop bound로 압축해 복붙 가능한 /goal 문자열을 출력. '/goal로 만들어', 'goal 프롬프트', 'goal 변환', 'clarify goal', 'goal 양식', '자율 작업 시작' 같은 요청에 사용."
argument-hint: "<목표 자연어> [--tier 1|2|3]"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - AskUserQuestion
  - Write
---

# tfx-goal-clarify — 자연어 → `/goal` 블록 변환기

> tfx-interview의 슬림 fork. **인터뷰 산출물을 Action Plan 대신 `/goal` 블록 한 덩어리로만** 출력한다.
> 공식 `/goal` 3축(End state / Stated check / Constraints) + `or stop after N turns`를 강제한다.

## 용도

Claude Code 2.1.139+의 `/goal` 명령어에 넣을 프롬프트를 자연어 아이디어로부터 구조화한다. `/goal`은 평가자(Haiku)가 transcript만 보고 yes/no 판정하므로, **측정 불가능한 조건은 무한 루프 또는 환각 yes**를 유발한다. 이 스킬은 그 함정을 회피한다.

**비교**:
- `tfx-interview`: 일반 요구사항 인터뷰 → 전체 Action Plan 산출
- `tfx-goal-clarify`: **/goal 블록 한 덩어리만** 산출 (5분 내 완료 목표)
- `gstack-office-hours`: 제품 아이디어 단계 (코드 이전)

## 입력 처리

`ARGUMENTS: <자연어 목표>`가 들어오면 첫 입력으로 사용. 없으면 사용자에게 요청.

`--tier N` 플래그:
- `1` = one-liner (3턴 이내 작업)
- `2` = standard 3-part (기본값, 10턴 이내)
- `3` = 9-section (다중 모듈/다일 작업)

## 워크플로우

### Step 1: 분류 + 초기 ambiguity 측정

코드베이스 컨텍스트 살펴보기 (선택적):
```bash
# 사용자가 어떤 repo에서 호출했는지 확인
git rev-parse --show-toplevel 2>/dev/null
```

자연어 입력을 3축으로 분해:
| 축 | 질문 | 점수 (0~1) |
|----|------|-----------|
| End state | 완료를 무엇으로 증명? | goal |
| Check | Claude가 어떤 명령/출력으로 보여줄 수 있나? | constraints |
| Constraints | 절대 건드리면 안 될 것은? | criteria |

`ambiguity = 1 - (end_state×0.4 + check×0.3 + constraints×0.3)`

Gemini 위임 (tfx-interview와 동일):
```bash
Bash("bash ~/.claude/scripts/tfx-route.sh gemini '<analysis prompt>'")
```

Gemini 미사용 환경(m5 등 SSH 원격)에서는 Claude가 직접 채점.

### Step 2: 적응형 인터뷰 (AskUserQuestion 사용, Tier별 질문 수 가변)

**반드시 Claude Code 네이티브 `AskUserQuestion` 도구를 사용**한다. 자유 텍스트 질의 금지 — 사용자가 옵션 중에서 선택하도록 구조화한다.

**Tier별 필수 축**:
| Tier | 핵심 축 (필수) | 보조 축 (조건부) | 질문 수 |
|------|---------------|----------------|---------|
| 1 | End state, Bound | — | 1~2 |
| 2 | End state, Check, Constraints, Bound | Scope | 3~5 |
| 3 | End state, Check, Constraints, Scope, Priority, Plan, Bound | Rollback, Output artifact | 5~8 |

**ambiguity < 20% 도달 시 즉시 종료** (남은 질문 스킵).

#### AskUserQuestion 호출 패턴 (예시)

각 축마다 다음 형태로 호출. **options는 사용자 입력 기반으로 동적 생성** + 사용자가 "Other"로 직접 입력 가능.

**Q1. End state (모든 Tier 필수)**
```json
{
  "questions": [{
    "question": "이 작업이 끝났다는 걸 어떤 단일 측정 가능한 결과로 증명하나요?",
    "header": "End state",
    "multiSelect": false,
    "options": [
      {"label": "테스트 exit code", "description": "예: pnpm test <path> exits 0"},
      {"label": "패턴 카운트 0", "description": "예: rg \"legacy\" src returns 0 hits"},
      {"label": "타입체크 통과", "description": "예: pnpm typecheck exits 0"},
      {"label": "빌드 성공", "description": "예: pnpm build exits 0"}
    ]
  }]
}
```

**Q2. Check 명령 (Tier 2/3)**
사용자 End state 선택 후 그 결과를 어떻게 transcript에 노출시킬지 — 보통 자동 추론(End state가 이미 명령형이면 그대로 사용). 모호하면 명령 후보 3-4개 옵션.

**Q3. Scope (Tier 2/3, 코드베이스 컨텍스트 있을 때만)**
```json
{
  "questions": [{
    "question": "변경 허용 범위는 어디까지인가요?",
    "header": "Scope",
    "multiSelect": true,
    "options": [
      {"label": "src/<module>/만", "description": "단일 모듈 한정"},
      {"label": "src/ 전체", "description": "소스 전체"},
      {"label": "tests/ 포함", "description": "테스트도 수정 가능"},
      {"label": "package.json 가능", "description": "의존성 추가 허용"}
    ]
  }]
}
```

**Q4. Constraints (Tier 2/3 필수)**
```json
{
  "questions": [{
    "question": "절대 변경하면 안 되는 것은 무엇인가요?",
    "header": "Constraints",
    "multiSelect": true,
    "options": [
      {"label": "공개 API 시그니처", "description": "props/exports 유지"},
      {"label": "기존 테스트", "description": "tests/legacy/ 등 보호"},
      {"label": "DB 스키마", "description": "migration 금지"},
      {"label": "없음 (None)", "description": "제약 없이 진행"}
    ]
  }]
}
```

**Q5. Priority (Tier 3만)**
```json
{
  "questions": [{
    "question": "충돌 시 어느 쪽을 우선하나요?",
    "header": "Priority",
    "multiSelect": false,
    "options": [
      {"label": "타입 안전 > 테스트 > 시각", "description": "타입체크 우선"},
      {"label": "테스트 > 타입 > 시각", "description": "기존 동작 보존"},
      {"label": "사용자 정의", "description": "직접 입력"}
    ]
  }]
}
```

**Q6. Bound (모든 Tier 필수, 마지막)**
```json
{
  "questions": [{
    "question": "최대 얼마나 돌릴까요? (Stop 조건)",
    "header": "Stop bound",
    "multiSelect": false,
    "options": [
      {"label": "10 turns", "description": "단순 수정 작업"},
      {"label": "20 turns", "description": "중간 규모 (기본 권장)"},
      {"label": "30 turns", "description": "마이그레이션"},
      {"label": "60 turns", "description": "다중 모듈 (Tier 3)"}
    ]
  }]
}
```

**Q7. Rollback (Tier 3 선택)**
실패 시 어떻게 복구할지 — git revert, checkpoint commit 빈도 등.

**Q8. Output artifact (Tier 3 선택)**
산출물 형태 — PR description, 보고서 파일, 단순 코드 변경 등.

#### 적응형 종료 조건

각 응답 후 ambiguity 재계산:
```
if ambiguity < 0.20:
  → 즉시 Step 3 (남은 질문 스킵)
elif 모든 필수 축 답변 완료:
  → Step 3
elif 질문 수 >= Tier별 상한:
  → Step 3 (남은 ambiguity는 사용자가 직접 편집할 영역으로 표시)
else:
  → 다음 질문
```

#### Fallback: AskUserQuestion 미사용 환경 (Codex/Gemini CLI 등)

자유 텍스트로 한 질문씩 던지되, 위 옵션 리스트를 보기로 제시.

### Step 3: `/goal` 블록 조립

**Tier 1 (one-liner)** — 단순 명령:
```
/goal <end_state> [or stop after N turns]
```

**Tier 2 (standard, 기본)**:
```
/goal
End state: {end_state}
Check: {check_command}
Constraints: {constraints}
Bound: or stop after {N} turns
```

**Tier 3 (9-section)** — 다중 모듈/긴 작업:
```
/goal
GOAL: {goal}
CONTEXT: {context}
CONSTRAINTS: {constraints}
PRIORITY: {priority}
PLAN: {plan_steps}
DONE WHEN: {done_when}
VERIFY: {verify_commands}
OUTPUT: {output_artifacts}
STOP RULES: or stop after {N} turns
```

### Step 4: 사용자 표시 + 검증

출력 형식 (반드시 이 순서):

```
📊 Ambiguity: {initial}% → {final}% (목표 < 20%)
   - End state: {pct}%
   - Check: {pct}%
   - Constraints: {pct}%

📋 4000자 한도: {used}/{4000} chars

📦 /goal 블록 (Tier {N}):

────────── 복붙 영역 ──────────
{the assembled /goal block}
─────────────────────────────────

✅ 검증:
   - 종료 상태가 측정 가능한가? {Y/N}
   - Check 명령이 transcript에 결과를 남기는가? {Y/N}
   - Stop bound가 있는가? {Y/N}
   - 4000자 이내인가? {Y/N}
```

### Step 5: 저장 (선택)

기본은 출력만. 사용자가 원하면 저장:
- 위치: `.tfx/goals/goal-{timestamp}.txt`
- 형식: 원본 자연어 + 인터뷰 응답 + 최종 /goal 블록

## 출력 후 옵션 (AskUserQuestion)

```
질문: 이 /goal 블록을 어떻게 처리할까요?
옵션:
  - 클립보드 복사: 블록을 클립보드로 복사 (입력창에 붙여넣기만 하면 됨)
  - 출력만: 화면 출력만 하고 종료
  - 수정: 특정 축(End state/Check/Constraints) 재질문
  - Tier 변경: 1↔2↔3 재조립
```

> `/goal`은 Claude Code 슬래시 명령어라 **에이전트가 세션 입력창에 대신 전송할 수 없다.**
> 그래서 "바로 실행" 옵션은 두지 않는다. 사용자가 클립보드에서 입력창에 직접 붙여넣어 실행한다.

### 클립보드 복사 실행 방법

"클립보드 복사" 선택 시 `Bash`로 OS별 클립보드 명령에 블록을 파이프한다.
블록에 백틱·따옴표가 섞이므로 **임시 파일을 거쳐** 복사한다 (인용 깨짐 방지).

```bash
# 1) 조립된 /goal 블록을 임시 파일로 기록 (Write 도구 또는 heredoc)
cat > "${TMPDIR:-/tmp}/tfx-goal-block.txt" <<'GOAL_EOF'
<the assembled /goal block>
GOAL_EOF

# 2) OS별 클립보드로 복사 (darwin 우선, fallback chain)
f="${TMPDIR:-/tmp}/tfx-goal-block.txt"
if   command -v pbcopy   >/dev/null 2>&1; then pbcopy < "$f"                      # macOS
elif command -v wl-copy  >/dev/null 2>&1; then wl-copy < "$f"                     # Wayland
elif command -v xclip    >/dev/null 2>&1; then xclip -selection clipboard < "$f"  # X11
elif command -v clip.exe >/dev/null 2>&1; then clip.exe < "$f"                    # Windows/WSL
else echo "클립보드 명령 없음 — 위 출력에서 수동 복사"; fi
```

복사 성공 시 `✅ 클립보드에 복사됨 — 입력창에 붙여넣어 실행하세요.` 를 출력한다.

## 동작 규칙

1. **출력 우선**: 최종 산출물은 항상 `/goal` 블록 한 덩어리. 부수 설명은 위/아래에만.
2. **4000자 강제**: 한도 초과 시 자동으로 PLAN/CONTEXT를 압축.
3. **Stop bound 강제**: 사용자가 명시 안 해도 `or stop after 20 turns`를 기본 삽입 (Tier 2/3).
4. **Check 강제**: 평가자가 transcript만 보므로 Check 없는 블록은 거부.
5. **Constraints 비어있어도 OK**: 'none' 명시.
6. **언어**: 사용자가 한국어로 입력하면 인터뷰는 한국어, /goal 블록은 영어 (Claude Code가 영어 명령에 더 안정적).

## 안티패턴 (자동 거부)

다음 End state는 거부:
- "production-ready", "better", "modern", "clean" — 주관적
- "all tests pass" without 명시된 테스트 위치 — 범위 폭발
- "refactor everything" — 범위 무제한

거부 시 사용자에게:
```
⚠️ End state "{...}"는 평가자가 측정할 수 없습니다.
   다음 중 어느 형태로 바꿀까요?
   1) 명령어 exit code (예: pnpm test exits 0)
   2) 파일/문자열 카운트 (예: rg X returns 0 hits)
   3) 파일 변경 여부 (예: git diff --stat shows ≤3 files changed)
```

## Quick Examples

### Tier 1 입력/출력
```
입력: "auth 테스트 다 통과시켜"
출력: /goal pnpm test test/auth exits 0, or stop after 15 turns
```

### Tier 2 입력/출력
```
입력: "레거시 auth API 호출들을 v2로 마이그레이션"
출력:
/goal
End state: src/legacy/auth/*.ts 의 모든 호출이 src/auth/v2 로 마이그레이션됨
Check: `pnpm test src/auth` exits 0 AND `rg "legacy/auth" src` returns 0 hits
Constraints: tests/legacy/는 수정 금지, package.json 의존성 추가 금지
Bound: or stop after 30 turns
```

### Tier 3 입력/출력
```
입력: "users 모듈 전체를 새 design system으로 갈아엎고 PR 만들어"
출력:
/goal
GOAL: src/users/** 의 모든 React 컴포넌트를 @company/ds-v3로 마이그레이션
CONTEXT: 기존은 @company/ds-v2, 디자인 토큰은 docs/design/v3.md, 18개 컴포넌트
CONSTRAINTS:
  - tests/users/ snapshot 갱신 외 변경 금지
  - props 시그니처 유지 (caller 영향 없음)
  - i18n key 변경 금지
PRIORITY: 시각적 회귀 < 타입 안전성 < 테스트 통과
PLAN:
  1. 컴포넌트 인벤토리 추출
  2. v2→v3 mapping 표 생성
  3. 각 컴포넌트 변환 + snapshot 갱신
  4. PR description 작성
DONE WHEN: 18/18 컴포넌트 마이그레이션 + 모든 snapshot 통과 + PR 본문 생성
VERIFY: `pnpm typecheck` exits 0 AND `pnpm test src/users` exits 0 AND `rg "ds-v2" src/users` returns 0 hits
OUTPUT: PR description in .claude/scratch/pr-users-ds-v3.md
STOP RULES: or stop after 60 turns, or if token spend exceeds 500K
```

## 토큰 예산

| 단계 | Claude | Gemini |
|------|--------|--------|
| 초기 분류 | ~0.5K | ~1K |
| 3축 인터뷰 (Q1~Q3) | ~1K | ~3K |
| /goal 블록 조립 | ~0.5K | ~1K |
| **총합** | **~2K** | **~5K** |

Gemini 없으면 Claude 단독 ~5K.

## 사용 예

```
/tfx-goal-clarify "auth 마이그레이션"
/tfx-goal-clarify "테스트 다 고쳐" --tier 1
/tfx-goal-clarify "users 모듈 design system 갈아엎기" --tier 3
/goal 변환 "스냅샷 갱신해서 CI 그린"
```
