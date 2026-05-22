---
internal: true
name: tfx-plan
description: "구현 계획이 필요할 때 사용한다. '계획 세워줘', 'plan', '플랜', '어떻게 구현하지', '태스크 분해', '작업 순서', '합의 계획', 'ralplan', '철저한 계획' 같은 요청에 반드시 사용. 기본값은 Opus+Codex 합의와 Claude critic 보강. Antigravity는 quick/freeform 보조로만 사용하며 deprecated Gemini CLI는 쓰지 않는다."
triggers:
  - plan
  - 계획
  - 플랜
  - 설계
  - deep plan
  - 합의 계획
  - consensus plan
  - deep-plan
  - ralplan
argument-hint: "<구현할 기능> [--quick]"
---

# tfx-plan — Implementation Plan (Deep by Default)

> **ARGUMENTS 처리**: `--quick` → Quick 모드. 그 외 → Deep 모드 (기본).

> AI makes completeness near-free. 기본은 Opus 4.6(Planner) + Codex(Architect) + Claude Opus(Critic) 합의.
> Antigravity는 `agy --print` stdin 경로가 단순 프롬프트에서만 검증됐으므로, schema-driven critic에는 쓰지 않고 `--quick` freeform 보조로만 사용한다.

---

## 모드 분기

`--quick` → Quick 모드 (Antigravity freeform 위임).
그 외 → Deep 모드 (기본, Opus+Codex+Claude critic 합의 + 교차 검토).

---

## Deep 모드 (기본)

### 전제조건 프로브 및 Tier Degradation

```bash
(tmux -V 2>/dev/null || psmux -V 2>/dev/null) && \
  curl -sf http://127.0.0.1:27888/status >/dev/null && \
  codex --version 2>/dev/null && \
  agy --version 2>/dev/null
```

| Tier | 조건 | 실행 |
|------|------|------|
| **Tier 1** | 전부 정상 | headless multi 3-Model |
| **Tier 2** | 일부 CLI | 가용 + Claude Agent |
| **Tier 3** | headless 불가 | Claude Agent only |

Tier 3:
```
⚠ [Tier 3] 환경 미충족 (consensus 미적용)
  누락: {missing} | 또는 /tfx-plan --quick
```

### HARD RULES
1. `codex exec` 직접 호출 및 deprecated Gemini CLI 직접 호출 금지
2. Codex/Antigravity → `Bash("tfx multi --teammate-mode headless --assign ...")` 만
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent 동시 호출
5. deprecated Gemini CLI 또는 legacy Gemini assign 금지. Antigravity는 `antigravity:`/`agy` 이름만 사용한다.
6. `agy --print`는 stdin prompt만 사용한다. positional prompt 및 strict JSON critic 검증에 실패하면 Claude critic으로 대체한다.

### 모델 역할

| Model | 역할 | 강점 |
|-------|------|------|
| Claude Opus (Planner) | 전략 비전 | 리스크 통합, 아키텍처 결정 |
| Codex (Architect) | 기술 설계 | API, 파일 구조, 구현 세부 |
| Claude Opus (Critic) | 리스크 분석 | 엣지케이스, 보안, 테스트 전략 |
| Antigravity (Quick/Advisory) | freeform 보조 | 빠른 초안, UX/DX 관점, 비-schema 검토 |

### EXECUTION — TASK 는 사용자 입력

#### Step 1: 코드베이스 정찰

```
Agent(
  subagent_type="Explore",
  model="haiku",
  prompt="다음 기능 관련 코드베이스 탐색: [TASK]
  보고: (1) 관련 파일/디렉토리 (2) 기존 아키텍처 패턴 (3) 주요 의존성/인터페이스. bullet."
)
```

결과를 RECON으로 보유.

#### Step 2: Round 1 독립 설계 (Anti-Herding) — Bash + Agent 동시 호출

**Agent (Claude Planner):**
```
Agent(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  run_in_background=true,
  name="planner-r1",
  prompt="소프트웨어 아키텍트로서 구현 계획 수립. 기능: [TASK]. 코드베이스: [RECON]. JSON: { vision, tasks: [{id, title, desc, deps, complexity}], order, risks, files, confidence, reasoning }"
)
```

**Bash (Codex Architect):**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:시니어 엔지니어 기술 설계. 기능: [TASK]. 코드베이스: [RECON]. JSON: { architecture, components, data_models, api, files, impl_notes, confidence }:architect' \
  --timeout 600")
```

**Agent (Claude Critic fallback, schema-valid path):**
```
Agent(
  subagent_type="oh-my-claudecode:critic",
  model="opus",
  run_in_background=true,
  name="critic-r1",
  prompt="QA 보안 전문가 리스크 분석. 기능: [TASK]. 코드베이스: [RECON]. JSON: { edge_cases, security, performance, test_strategy: {unit, integration, edge_case}, missing_reqs, risk_level, confidence }"
)
```

#### Step 3: 결과 수집
- RESULT_PLANNER / RESULT_ARCHITECT / RESULT_CRITIC
- 실패 워커 → Claude Agent 로 대체
- Antigravity 결과가 strict schema를 만족하지 않으면 consensus vote에 포함하지 않는다.

#### Step 4: Round 2 교차 검토 — Bash + Agent 동시 호출

각 모델에게 다른 두 모델 Round 1 결과 제시. ACCEPT/MODIFY/REJECT.

**Agent:**
```
Agent(
  subagent_type="oh-my-claudecode:critic",
  model="opus",
  run_in_background=true,
  name="planner-r2",
  prompt="Round 1 교차 검토. 네 계획: [RESULT_PLANNER]. Architect: [RESULT_ARCHITECT]. Critic: [RESULT_CRITIC]. JSON: { revisions: [...], updated_plan: {...} }"
)
```

**Bash:** Codex가 Claude planner/critic 결과를 교차검토한다. Antigravity는 freeform advisory가 필요할 때만 별도 quick/advisory로 실행한다.

#### Step 5: 합의 점수 산출 (Claude 직접)

```
각 고유 항목:
  동의 수 >= 2 → CONSENSUS
  == 1 → DISPUTED

consensus_score = CONSENSUS / 전체 * 100

>= 80% → Step 6
60-79% → Round 3 (미합의만 재토론)
< 60%  → AskUserQuestion
```

#### Step 6: 합의 계획 출력

```markdown
## 합의된 구현 계획: [TASK]
**Consensus**: {score}% | **Rounds**: {n} | **Models**: Opus+Codex+ClaudeCritic

### 설계 방향
### 태스크 (T1..., 복잡도, 합의 P:A:C)
### 파일 변경
### 리스크 & 완화 (심각도, 합의도)
### 테스트 전략 (Critic 주도)
### 미합의 사항
```

### Token (Deep): ~25-32K

---

## Quick 모드 (`--quick`)

### Step 1: 요구사항 파싱
사용자 입력 + PROJECT_INDEX.md (있으면) + Glob 파일 목록.

### Step 2: Antigravity 위임

```
Bash("printf '%s' '소프트웨어 아키텍트로서 구현 계획. 기능: {feature}. 컨텍스트: {context}. 파일: {file_list}. 출력: 1) 영향 범위 2) 태스크 분해 (검증 방법 포함) 3) 리스크/의존성 4) 복잡도' | agy --print --dangerously-skip-permissions --print-timeout 10m")
```

**Fallback**: Antigravity 실패 시 Claude Opus 직접.

### Step 3: 구조화 출력

```markdown
## 구현 계획: {feature}

### 영향 범위
### 태스크 (체크박스 + 검증)
### 리스크
### 복잡도: {level}
```

### Token (Quick): ~1.5K (Claude), ~2K (Antigravity)

## 사용 예

```
/tfx-plan "JWT 인증 미들웨어 추가"          # Deep (기본)
/tfx-plan "마이크로서비스 분리"             # Deep
/tfx-plan --quick "README 섹션 추가"        # Quick (Antigravity)
```
