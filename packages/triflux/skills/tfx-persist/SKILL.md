---
internal: true
name: tfx-persist
description: "작업이 완전히 끝날 때까지 멈추지 않고 반복 실행해야 할 때 사용한다. 'ralph', '끝까지 해', '멈추지 마', 'don't stop', '완료될 때까지', '다 될 때까지 계속' 같은 요청에 반드시 사용. 여러 기준을 모두 충족해야 하는 복잡한 구현 작업에 적극 활용."
triggers:
  - ralph
  - don't stop
  - 끝까지
  - until done
  - 멈추지 마
argument-hint: "<완료할 작업 설명>"
---

# tfx-persist — Tri-Verified Persistence Loop

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> OMC ralph 오마주. 핵심 차별점: 검증자가 단일 agent가 아니라 **3-CLI consensus**.
> The boulder never stops — but it stops being wrong.

## 전제조건 프로브 및 Tier Degradation

> **진입 즉시 실행** — 10초 내 가시적 출력을 보장한다. 빈 stdout + exit 0 **금지**.

### 환경 프로브

워크플로우 진입 전, 아래 프로브를 실행하여 가용 환경을 감지한다:

```bash
psmux --version 2>/dev/null && \
  curl -sf http://127.0.0.1:27888/status >/dev/null && \
  codex --version 2>/dev/null && \
  gemini --version 2>/dev/null
```

### Tier 판정

| Tier | 조건 | 실행 방식 |
|------|------|----------|
| **Tier 1** | psmux + Hub + Codex + Gemini 전부 정상 | 기존 headless multi (변경 없음) |
| **Tier 2** | 일부 CLI만 가용 (Codex 또는 Gemini 중 하나) | 가용 CLI + Claude Agent 조합 |
| **Tier 3** | headless 불가 또는 `claude -p` one-shot | Claude Agent only |

```
IF claude -p (one-shot 모드):
  → Tier 3 즉시 fallback

IF psmux 없음 OR Hub 미응답:
  → Tier 3

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
```

Tier 3에서는 모든 headless dispatch(`tfx multi ...`)를 **Claude Agent**(subagent)로 대체한다.
Tier 2에서는 누락된 CLI만 Claude Agent로 대체한다.

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini 검증자 → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude 검증자 → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행
5. 루프 종료 조건: 모든 criteria 3자 검증 통과 + 통합 검증 Consensus >= 70

## MODEL ROLES

| 단계 | 역할 | 담당 |
|------|------|------|
| Goal Definition | 완료 기준 추출 및 사용자 확인 | Claude (직접 실행) |
| 구현 (단순) | 코드 작성, 파일 수정, 테스트 | Codex (tfx headless) |
| 구현 (복잡) | 태스크 분해 후 병렬 실행 | Codex + Gemini (tfx headless) |
| 기준별 검증 — Claude | 코드 읽기 + 논리 검증 | Claude (Agent, background) |
| 기준별 검증 — Codex | 코드 실행 + 테스트 검증 | Codex (tfx headless) |
| 기준별 검증 — Gemini | 코드 리뷰 + 품질 검증 | Gemini (tfx headless) |
| 통합 검증 | 전체 criteria 최종 합의 | Claude + Codex + Gemini (동시) |
| Deslop Pass | 슬롭 감지 및 제거 | Codex + Gemini (tfx headless) |

## EXECUTION STEPS

### Step 1: Goal Definition

Claude가 직접 실행한다.

1. 사용자 요청에서 완료 기준(acceptance criteria)을 추출한다.
2. AskUserQuestion으로 추출된 기준을 사용자에게 확인받는다:
   - "맞습니다 — 진행" → Step 2로 이동
   - "수정 필요" → 해당 기준 번호와 내용 입력 받아 반영 후 재확인
   - "추가 필요" → 추가 기준 입력 받아 반영 후 재확인
3. 확정된 `{criteria_list}`를 루프 전체에서 사용한다.

### Step 2: Execution Loop

**모든 criteria가 검증 통과할 때까지 반복한다.**

#### 2a. 현재 상태 평가

미완료 criteria를 식별하고 다음 구현 작업을 결정한다.

#### 2b. 구현 실행

단순 작업 (파일 수정, 단일 모듈):
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:{미완료_criterion}을 충족하도록 구현하라. 구체적 작업: {task_description}. TDD 필요 시 테스트 먼저 작성(RED) → 구현(GREEN) 순서로 진행하라.:implementer' \
  --timeout 600")
```

복잡 작업 (여러 파일, 연동 모듈):
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:{서브태스크_A} 구현하라. 세부사항: {spec_A}:implementer' \
  --assign 'codex:{서브태스크_B} 구현하라. 세부사항: {spec_B}:implementer' \
  --assign 'gemini:{문서/UI_항목} 작성하라. 세부사항: {spec_C}:writer' \
  --timeout 600")
```

#### 2c. 3자 독립 검증

**구현 완료 후, 아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

**Claude 검증 (Agent):**
```
Agent(
  subagent_type="oh-my-claudecode:verifier",
  model="sonnet",
  run_in_background=true,
  prompt="다음 기준이 충족되었는지 코드를 직접 읽고 판단하라.
기준: {current_criterion}
코드를 읽고 논리적으로 충족 여부를 판단하라.
결과: PASS 또는 FAIL + 근거 1문장"
)
```

**Codex + Gemini 검증 (Bash — 동시에 위 Agent와 같은 응답에서 호출):**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:다음 기준 충족 여부를 코드 실행/테스트로 검증하라. 기준: {current_criterion}. 실제 테스트를 실행하여 결과를 확인하라. 결과: PASS 또는 FAIL + 근거 1문장:verifier' \
  --assign 'gemini:다음 기준 충족 여부를 코드 리뷰로 판단하라. 기준: {current_criterion}. 코드 품질, 엣지 케이스, 완전성을 확인하라. 결과: PASS 또는 FAIL + 근거 1문장:verifier' \
  --timeout 600")
```

**검증 판정:**
- 2/3 이상 PASS → 해당 기준 확정, 다음 기준으로 이동
- 1/3만 PASS → 재작업 필요, 실패 근거를 구현 프롬프트에 포함하여 2b 재실행
- 0/3 PASS → 즉시 재작업, 실패 근거 전달

#### 2d. 진행 보고

각 기준 검증 후 보고한다:
```
[tfx-persist] {완료수}/{전체수} 기준 충족.
완료: {완료된_criteria_목록}
현재: {작업_중인_criterion}
다음: {예정_criterion}
```

### Step 3: Final Verification

모든 기준이 개별 검증을 통과한 후, 전체 통합 검증을 실행한다.

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

**Claude 통합 검증 (Agent):**
```
Agent(
  subagent_type="oh-my-claudecode:verifier",
  model="opus",
  run_in_background=true,
  prompt="모든 acceptance criteria가 충족되었는지 전체적으로 검증하라.
기준 목록: {criteria_list}
코드를 직접 읽고, 회귀 여부를 확인하고, 기준 간 상호 의존성을 검증하라.
JSON 형식: { criteria_results: [{criterion, pass, reason}], regression_check, overall_pass }"
)
```

**Codex + Gemini 통합 검증 (Bash — 동시에 위 Agent와 같은 응답에서 호출):**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:모든 acceptance criteria 충족 여부를 테스트 실행으로 통합 검증하라. 기준 목록: {criteria_list}. 전체 테스트 스위트를 실행하고 회귀 여부를 확인하라. JSON 형식: { criteria_results, test_results, overall_pass }:verifier' \
  --assign 'gemini:모든 acceptance criteria 충족 여부를 코드 리뷰로 통합 검증하라. 기준 목록: {criteria_list}. 전체 변경사항을 검토하고 누락, 불완전한 구현, 엣지 케이스를 확인하라. JSON 형식: { criteria_results, edge_cases, overall_pass }:verifier' \
  --timeout 600")
```

**통합 판정:**
- Consensus Score >= 70 → Step 4(Deslop) 또는 Step 5(완료) 진행
- Consensus Score < 70 → 미달 항목을 추출하여 Step 2 루프 재진입

### Step 4: Deslop Pass (선택적)

검증 통과 후 변경된 파일에 슬롭이 있으면 제거한다.

```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:다음 파일에서 AI가 생성한 불필요 코드(슬롭)를 감지하라. 파일: {changed_files}. 중복 코드, 불필요 추상화, 과잉 에러 핸들링, 사용되지 않는 임포트를 보고하라. 수정하지 말고 목록만 반환하라.:critic' \
  --assign 'gemini:다음 파일에서 AI가 생성한 불필요 코드(슬롭)를 감지하라. 파일: {changed_files}. 중복 코드, 불필요 추상화, 과잉 에러 핸들링, 사용되지 않는 임포트를 보고하라. 수정하지 말고 목록만 반환하라.:critic' \
  --timeout 600")
```

2/3 이상 동의한 슬롭만 Codex로 제거하고, 제거 후 회귀 검증을 실행한다.

### Step 5: 완료

모든 기준 3자 검증 통과 + 통합 검증 통과 시 완료를 보고한다.

```
[tfx-persist 완료] {전체}/{전체} 기준 충족
Consensus Score: {score}%
변경 파일: {count}개
테스트: {pass}/{total} 통과
검증: Claude PASS | Codex PASS | Gemini PASS
```

## ANTI-STUCK 메커니즘

같은 기준에서 3회 연속 검증 실패 시 즉시 실행한다:

1. 접근법을 변경하여 재시도한다 (다른 구현 전략 선택).
2. 변경 후에도 실패하면 AskUserQuestion으로 사용자 도움을 요청한다:
   - 실패한 기준, 3회 시도 내역, 각 실패 이유를 제시한다.
3. 사용자 지시를 받은 후 재시도한다.

같은 전체 루프가 5회 반복 시:
- 강제로 진행 상황을 보고하고 AskUserQuestion으로 사용자 판단을 요청한다.

## ERROR RECOVERY

| 상황 | 대응 |
|------|------|
| tfx headless 타임아웃 | `--timeout` 900으로 올려 재시도 |
| 검증 결과 불일치 (2자 PASS, 1자 FAIL) | FAIL 근거를 구현 프롬프트에 포함하여 재작업 |
| 빌드 실패 | Codex에 빌드 로그 전달하여 수정 지시 |
| 무한 루프 감지 (5회 이상) | 강제 보고 + AskUserQuestion |

## TOKEN BUDGET

| 항목 | 토큰 |
|------|------|
| 기준당 구현 | ~3K |
| 기준당 3자 검증 | ~5K |
| 기준당 합계 | ~8K |
| 통합 검증 (Step 3) | ~15K |
| Deslop Pass (선택) | ~5K |
| **예시: 5개 기준** | **~55K** |

## 사용 예

```
/tfx-persist "JWT 인증 미들웨어 구현. 로그인, 토큰 발급/검증, 리프레시, 테스트 80%+"
/tfx-persist "이 버그 수정해. PR #42의 모든 코멘트 해결될 때까지"
/tfx-persist "데이터베이스 마이그레이션 완료. 기존 데이터 무손실, 롤백 가능"
```
