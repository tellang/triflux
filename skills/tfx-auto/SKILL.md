---
name: tfx-auto
description: 통합 CLI 오케스트레이터. 커맨드 숏컷(단일) + 자동 분류/분해(병렬) + 수동 병렬. cli-route.sh 기반.
triggers:
  - tfx-auto
  - implement
  - build
  - research
  - brainstorm
  - design
  - test
  - analyze
  - troubleshoot
  - improve
  - cleanup
  - explain
  - document
  - pm
  - reflect
  - estimate
  - spec-panel
  - business-panel
  - index-repo
argument-hint: "<command|task> [args...]"
---

# tfx-auto — 통합 CLI 오케스트레이터

> **MANDATORY EXECUTION RULE — 이 규칙을 반드시 따르라**
>
> **작업 실행 시** (Phase 3), **절대 Task()를 직접 호출하지 마라.**
> 아래 Claude 네이티브 유지 대상을 제외한 **모든 에이전트는 반드시 Bash("bash ~/.claude/scripts/cli-route.sh ...")로 실행**하라.
>
> **Bash(cli-route.sh)로 실행해야 하는 에이전트:**
> executor, build-fixer, debugger, deep-executor, architect, planner, critic, analyst,
> code-reviewer, security-reviewer, quality-reviewer, scientist, document-specialist,
> designer, writer
>
> **Task()로 실행해야 하는 에이전트 (Claude 네이티브 — 예외 4개만):**
> explore, verifier, test-engineer, qa-tester
>
> **트리아지 (Phase 2)는 예외:** Codex `--full-auto` + Claude 인라인 보정. Agent 스폰 없음.
>
> **위반 시 Codex 무료 토큰 대신 Claude 유료 토큰을 낭비하게 된다.**

> **COST RULE — Codex/Gemini 최대 활용, Claude 최소화**
>
> Codex Pro 무료 기간 — **모든 작업을 가능한 한 Codex/Gemini에 할당하라.**
>
> **라우팅 우선순위 (반드시 순서대로):**
> 1. **Codex 우선** — 코드 구현/수정/분석/리뷰/디버깅/리서치/설계 전부
> 2. **Gemini 우선** — 문서/UI/디자인/멀티모달
> 3. **Claude는 최후 수단** — Glob/Grep/Bash 직접 접근이 필수인 경우만 (탐색/테스트/검증)
>
> **Codex 분류 시**: `claude`를 선택하기 전에 "이 작업이 Codex로 가능한가?" 반드시 재확인.
> 코드 읽기/분석도 Codex로 가능하다. 리서치도 Codex(MCP: context7, brave-search)로 가능하다.
> **claude는 Glob/Grep/Read/Bash 직접 실행이 반드시 필요할 때만 선택하라.**

> **DAG 실행 필수 체크리스트 — Phase 3 진입 전 확인**
>
> 1. graph_type이 SEQUENTIAL 또는 DAG이면 → **반드시 레벨 기반 순차 실행**
> 2. `.omc/context/{session_id}/` 디렉토리 생성했는가?
> 3. Level 0 완료 후 context_output 파일을 저장했는가?
> 4. Level 1+ 태스크에 cli-route.sh **5번째 인자로 context file**을 전달했는가?
> 5. 실패한 태스크의 후속 의존 태스크를 SKIP 처리했는가?

## 3가지 모드

| 입력 형식 | 모드 | 트리아지 | 예시 |
|-----------|------|----------|------|
| `/implement JWT 추가` | **커맨드 숏컷** | 없음 (즉시 실행) | 단일 에이전트 직행 |
| `/tfx-auto "리팩터링 + UI 개선"` | **자동** | Codex 분류 → Opus 분해 | 복잡한 작업 자동 분배 |
| `/tfx-auto 3:codex "리뷰"` | **수동** | Opus 분해만 | 에이전트 직접 지정 |

## 사용법

```
/implement JWT 인증 미들웨어 추가       ← 커맨드 숏컷
/tfx-auto "작업 설명"                    ← 자동 모드
/tfx-auto N:agent_type "작업 설명"       ← 수동 모드
```

## 커맨드 숏컷 (트리아지 없이 즉시 실행)

커맨드명이 매칭되면 트리아지를 건너뛰고 cli-route.sh로 즉시 라우팅.
타임아웃은 cli-route.sh 에이전트별 기본값 사용.

### Codex 직행

| 커맨드 | 에이전트 | MCP 프로필 |
|--------|---------|-----------|
| `implement` | executor | implement |
| `build` | build-fixer | implement |
| `research` | document-specialist | analyze |
| `brainstorm` | analyst | analyze |
| `design` | architect | analyze |
| `troubleshoot` | debugger | implement |
| `cleanup` | executor | implement |
| `pm` | planner | analyze |

```bash
Bash("bash ~/.claude/scripts/cli-route.sh {에이전트} '{PROMPT}' {MCP프로필}")
```

### Codex 2단계 (분석 → 실행)

| 커맨드 | 1단계 | 2단계 | 비고 |
|--------|-------|-------|------|
| `improve` | code-reviewer (review) | executor (implement) | 2단계는 사용자 승인 후 |

```bash
# 1단계 — 분석
Bash("bash ~/.claude/scripts/cli-route.sh code-reviewer '{PROMPT}' review")
# 사용자에게 분석 결과 보고, 승인 요청
# 2단계 — 수정 (승인 시)
Bash("bash ~/.claude/scripts/cli-route.sh executor '리뷰 결과 반영: {1단계_결과_요약}' implement")
```

### Codex 병렬 (동시 다중 에이전트)

| 커맨드 | 에이전트들 | MCP 프로필 |
|--------|----------|-----------|
| `analyze` | quality-reviewer + security-reviewer | review |
| `spec-panel` | architect + analyst + critic | analyze |
| `business-panel` | analyst + architect | analyze |

```bash
# analyze — 2개 병렬
Bash("bash ~/.claude/scripts/cli-route.sh quality-reviewer '{PROMPT}' review", run_in_background=true)
Bash("bash ~/.claude/scripts/cli-route.sh security-reviewer '{PROMPT}' review", run_in_background=true)

# spec-panel — 3개 병렬
Bash("bash ~/.claude/scripts/cli-route.sh architect '기술 실현성 평가: {PROMPT}' analyze", run_in_background=true)
Bash("bash ~/.claude/scripts/cli-route.sh analyst '요구사항 완전성 평가: {PROMPT}' analyze", run_in_background=true)
Bash("bash ~/.claude/scripts/cli-route.sh critic '비판적 검토: {PROMPT}' analyze", run_in_background=true)

# business-panel — 2개 병렬
Bash("bash ~/.claude/scripts/cli-route.sh analyst '시장/전략 분석: {PROMPT}' analyze", run_in_background=true)
Bash("bash ~/.claude/scripts/cli-route.sh architect '기술-비즈니스 연계 분석: {PROMPT}' analyze", run_in_background=true)
```

### Gemini 직행

| 커맨드 | 에이전트 | MCP 프로필 |
|--------|---------|-----------|
| `explain` | writer | docs |
| `document` | writer | docs |

```bash
Bash("bash ~/.claude/scripts/cli-route.sh writer '{PROMPT}' docs")
```

### Claude 네이티브

| 커맨드 | 에이전트 | 모델 |
|--------|---------|------|
| `test` | test-engineer | sonnet |
| `reflect` | verifier | sonnet |

```
Agent(subagent_type="oh-my-claudecode:test-engineer", model="sonnet", prompt="{PROMPT}")
Agent(subagent_type="oh-my-claudecode:verifier", model="sonnet", prompt="{PROMPT}")
```

### 복합 워크플로우

#### estimate — 규모 추정

```bash
# 1. 탐색 (Claude Haiku)
Agent(subagent_type="oh-my-claudecode:explore", model="haiku",
     prompt="다음 작업의 영향 범위 탐색 — 관련 파일, 모듈, 의존성 목록화: {PROMPT}")

# 2. 분석 (Codex)
Bash("bash ~/.claude/scripts/cli-route.sh analyst '탐색 결과: {explore_결과}. 작업: {PROMPT}. 평가: 영향범위, 복잡도(S/M/L/XL), 리스크, 선행조건, 권장실행방식' analyze")
```

#### index-repo — 코드베이스 인덱싱

```bash
# mode 파싱: "mode=quick" → QUICK, "mode=update" → UPDATE, 기본 → FULL

# 1. 구조 탐색 (Claude Haiku)
Agent(subagent_type="oh-my-claudecode:explore", model="haiku",
     prompt="코드베이스 전체 구조 매핑: 디렉토리 트리, 진입점, 설정 파일, 테스트 구조")

# 2. 의존성 분석 (QUICK이면 생략, Claude Haiku)
Agent(subagent_type="oh-my-claudecode:explore", model="haiku",
     prompt="모듈 간 import 관계 분석: 내부 import 그래프, 순환 의존성, API 경계, 공유 유틸리티")

# 3. PROJECT_INDEX.md 생성 (Write 도구)
```

## 자동/수동 병렬 모드 (트리아지 실행)

### 파라미터

- **N** (선택) — 워커 수 (1-10). 미지정 시 Opus가 자동 결정
- **agent_type** (선택) — `codex`, `gemini`, `claude`, 또는 OMC 에이전트명
- **task** (필수) — 작업 설명

### 에이전트 매핑

| 입력 | CLI | 용도 |
|------|-----|------|
| `codex` / `executor` / `debugger` / `deep-executor` | Codex CLI | 코드 구현/분석/디버깅 |
| `gemini` / `designer` / `writer` | Gemini CLI | 문서/UI |
| `claude` / `explore` / `verifier` / `test-engineer` | Claude Task | 탐색/검증 (네이티브) |
| `code-reviewer` / `security-reviewer` / `quality-reviewer` | Codex CLI (exec review) | 리뷰 (전용 review 커맨드) |
| `scientist` | Codex CLI (high, 480s) | 일반 리서치 (검색+요약) |
| `scientist-deep` | Codex CLI (thorough, 1200s) | 심층 리서치 (논문 분석, 교차 검증) |
| `document-specialist` | Codex CLI | 문서 조사 (analyze MCP) |
| `architect` / `planner` / `critic` / `analyst` | Codex CLI (xhigh + Opus 검증) | 설계/계획 (analyze MCP) |

### 예시

```bash
# 자동 모드 — AI가 분류 + 분해
/tfx-auto "인증 모듈 리팩터링 + 로그인 UI 개선 + 테스트 추가"
/tfx-auto "이 프로젝트의 보안 취약점 분석"
/tfx-auto "src/api 전체 TypeScript 에러 수정"

# 수동 모드 — agent 직접 지정
/tfx-auto 3:codex "src/api, src/auth, src/payment 각각 리뷰"
/tfx-auto 2:gemini "UI 컴포넌트 접근성 개선"
/tfx-auto 1:codex "결제 모듈 구현"
```

## 필수 조건

- `~/.claude/scripts/cli-route.sh` — CLI 라우팅 래퍼 (필수)
- **codex** CLI: `npm install -g @openai/codex` (codex 워커 사용 시)
- **gemini** CLI: `npm install -g @google/gemini-cli` (gemini 워커 사용 시)
- tmux **불필요**

## 아키텍처

### 트리아지 (Codex 분류 → Opus 설계)

```
사용자 입력
    |
    +-- agent 지정됨? ──YES──→ [Opus 인라인 분해] → 병렬 실행
    |
    NO
    |
    v
[Codex 분류] (--full-auto, 무료)
  "이 작업은 codex/gemini/claude 중 뭐가 적합?"
  → 가벼운 분류 결과
    |
    v
[Opus 설계+분해] (인라인, Agent 스폰 없음)
  → 구체 에이전트 매핑 + scope + DAG 설계
  → 오케스트레이터 자체가 Opus이므로 별도 Agent 불필요
    |
    v
[cli-route.sh × N 병렬 실행]
  → Windows면 Gemini 안정화 자동 적용
    |
    v
[결과 수집 + 보고]
```

> **설계는 Opus 품질, 비용은 최소화:**
> - 분류(가벼운 작업) → Codex 무료
> - 설계+분해(품질 중요) → Opus 인라인 (오케스트레이터가 직접)
> - Agent 스폰 없음 → MANDATORY RULE 준수 + 오버헤드 제거

### 전체 실행 흐름

```
User: "/tfx-auto 인증 리팩터링 + UI 개선 + 테스트"
         |
         v
   [Phase 1: 입력 파싱] — 자동 모드 감지
         |
         v
   [Phase 2a: Codex 분류]
     Bash("codex exec --full-auto --skip-git-repo-check '분류 프롬프트'")
     → [{auth 리팩터링, codex}, {UI 개선, gemini}, {테스트, claude}]
     (실패 시 Opus가 직접 분류+분해)
         |
         v
   [Phase 2b: Opus 설계+분해 (인라인)]
     codex → executor (implement, scope: src/auth/)
     gemini → designer (docs, scope: src/components/login/)
     claude → test-engineer (Claude 네이티브)
     graph_type: DAG, depends_on 설정
         |
         v
   [Phase 3: 병렬 실행]
     Bash("cli-route.sh executor '리팩터링' implement", run_in_background=true)
     Bash("cli-route.sh designer 'UI 개선' docs", run_in_background=true)
     Agent(subagent_type="oh-my-claudecode:test-engineer", model="sonnet", run_in_background=true)
         |
         v
   [Phase 4: 결과 수집]
   [Phase 5: 실패 처리 → Claude fallback]
   [Phase 6: 보고]
```

## 워크플로우

### Phase 1: 입력 파싱 (모드 감지)

사용자 입력에서 모드를 자동 감지:

```
입력: "3:codex src/api 리뷰"
  → 수동 모드: N=3, agent=codex, task="src/api 리뷰"

입력: "인증 모듈 리팩터링 + UI 개선"
  → 자동 모드: task="인증 모듈 리팩터링 + UI 개선"
```

**감지 규칙:**
- `N:agent_type` 패턴 존재 → 수동 모드
- 그 외 → 자동 모드
- N > 10이면 거부

### Phase 2: 트리아지 (Codex 분류 → Opus 설계)

#### 자동 모드 — Step 2a: Codex 분류

Codex가 작업 유형을 분류 (무료, 가벼운 작업):

```bash
Bash("codex exec --full-auto --skip-git-repo-check '다음 작업을 분석하고 각 부분에 적합한 agent를 분류하라.

  agent 선택:
  - codex: 코드 구현/수정/분석/리뷰/디버깅/설계 (기본값 — 확신 없으면 codex)
  - gemini: 문서/UI/디자인/멀티모달
  - claude: 코드베이스 탐색/테스트 실행/검증 (최후 수단)

  리서치 agent:
  - scientist: 일반 리서치 (high, 480s)
  - scientist-deep: 심층 리서치 (thorough, 1200s)

  작업: {task}

  JSON 형식:
  {
    \"parts\": [
      { \"description\": \"...\", \"agent\": \"codex|gemini|claude\" }
    ]
  }
  '")
```

> **Codex 분류 실패 시:** 오케스트레이터(Opus)가 직접 분류+분해 수행.

#### 자동 모드 — Step 2b: Opus 설계+분해 (인라인)

분류 결과를 받아 **오케스트레이터(Opus)가 직접** 설계+분해. Agent 스폰 없음.

```
오케스트레이터가 인라인으로 수행:
1. 분류 결과를 기반으로 독립적인 서브태스크로 분해
2. 각 서브태스크에 구체 agent 배정:
   - codex → executor / debugger / deep-executor / scientist 등
   - gemini → designer / writer
   - claude → explore / test-engineer / verifier
3. scope (파일/모듈/영역) 명시
4. 의존 관계 설정 (depends_on, context_output, context_input)
5. graph_type 결정 (INDEPENDENT / SEQUENTIAL / DAG)

결과 JSON:
{
  "graph_type": "INDEPENDENT|SEQUENTIAL|DAG",
  "subtasks": [
    {
      "id": "t1",
      "description": "...",
      "scope": "src/auth/",
      "agent": "executor",
      "mcp_profile": "implement",
      "depends_on": [],
      "context_output": "t1-auth-refactor.md",
      "context_input": []
    }
  ]
}

의존 관계 규칙:
- depends_on: 선행 태스크 ID 목록. 순환 금지.
- context_output: 후속 태스크에 전달할 결과 파일명
- context_input: 참조할 선행 태스크의 context_output 목록
```

> **왜 Agent 스폰이 아닌 인라인인가?**
> 오케스트레이터 자체가 Opus. 같은 모델의 Agent를 스폰하면 오버헤드만 추가.
> 설계 품질은 Opus급 그대로, 토큰 절약 + MANDATORY RULE 준수.

#### 수동 모드 — Opus 인라인 분해

agent가 지정된 경우 (`N:agent_type`), Codex 분류를 건너뛰고 Opus가 직접 분해:

```
오케스트레이터가 인라인으로 처리:
1. 작업을 정확히 {N}개의 독립 서브태스크로 분해
2. 모든 서브태스크에 {agent_type} 배정
3. 각 서브태스크는 파일 충돌 없이 독립 실행 가능해야 함
4. JSON 형식으로 구성 후 Phase 3으로 진행
```

### Phase 3: DAG 기반 실행

graph_type에 따라 실행 전략이 달라진다:

#### INDEPENDENT: 전부 병렬 (기존 동작과 동일)

모든 서브태스크를 단일 메시지에서 병렬로 실행:

```bash
Bash("bash ~/.claude/scripts/cli-route.sh {agent} '{prompt}' {mcp_profile}",
     run_in_background=true)
```

#### SEQUENTIAL / DAG: 레벨 기반 실행

**Step 1: 토폴로지 정렬 → 레벨 할당**

depends_on 관계를 분석하여 실행 레벨을 결정:
- Level 0: depends_on이 빈 태스크 (루트)
- Level N: 모든 의존 태스크가 Level 0~(N-1)에 속하는 태스크

예시:
```
t1(리서치A), t2(리서치B) → Level 0 (병렬)
t3(구현, depends_on:[t1,t2]) → Level 1 (t1,t2 완료 후)
t4(테스트, depends_on:[t3]) → Level 2 (t3 완료 후)
```

**Step 2: 컨텍스트 디렉토리 생성**

```bash
Bash("mkdir -p .omc/context/{session_id}")
```

**Step 3: 레벨별 순차 실행**

```
For each level L from 0 to max_level:

  1. 해당 레벨의 모든 태스크를 수집

  2. 각 태스크에 대해:
     a. context_input이 있으면 → 컨텍스트 머지:
        # 다중 선행 컨텍스트를 하나로 합침
        for ctx in context_input:
          echo "=== Context from: {source_task_id} ===" >> combined.md
          cat .omc/context/{session_id}/{ctx} >> combined.md
     b. CLI 에이전트:
        Bash("bash ~/.claude/scripts/cli-route.sh {agent} '{prompt}' {mcp} {timeout} {context_file}",
             run_in_background=(같은 레벨에 다른 태스크가 있으면))
     c. Claude 네이티브 에이전트:
        Agent(subagent_type="oh-my-claudecode:{agent}", model="{model}",
             prompt="{prompt}\n\n<prior_context>\n{context_content}\n</prior_context>",
             run_in_background=(같은 레벨에 다른 태스크가 있으면))

  3. 해당 레벨의 모든 태스크 완료 대기

  4. 각 완료된 태스크에 대해:
     a. context_output이 있으면 → 결과 저장:
        - CLI: OUTPUT 섹션 추출 → .omc/context/{session_id}/{context_output}
        - Claude: 반환값 → .omc/context/{session_id}/{context_output}
     b. 실패/타임아웃 → 의존 태스크 SKIP 처리 (실패 전파)

  5. 다음 레벨로 진행
```

#### CLI 에이전트 실행 (Codex/Gemini)

```bash
# 컨텍스트 없는 경우 (Level 0 또는 독립)
Bash("bash ~/.claude/scripts/cli-route.sh {agent} '{prompt}' {mcp_profile}",
     run_in_background=true)

# 컨텍스트 있는 경우 (Level 1+, 의존 태스크)
Bash("bash ~/.claude/scripts/cli-route.sh {agent} '{prompt}' {mcp_profile} .omc/context/{sid}/combined-{task_id}.md",
     run_in_background=true)
```

**Windows Gemini 안정화 (자동 적용):**
- Gemini 워커에 `--timeout 60` 플래그 자동 추가
- health check: 실행 후 10초 내 응답 없으면 재시작
- `enableInteractiveShell=false`로 node-pty 우회

#### Claude 네이티브 에이전트

```
# 컨텍스트 없는 경우
Agent(subagent_type="oh-my-claudecode:{agent}", model="{model}",
     prompt="{prompt}", run_in_background=true)

# 컨텍스트 있는 경우
Agent(subagent_type="oh-my-claudecode:{agent}", model="{model}",
     prompt="{prompt}\n\n<prior_context>\n{context_from_file}\n</prior_context>",
     run_in_background=true)
```

#### MCP 프로필 자동 결정

| 에이전트 | MCP 프로필 |
|----------|-----------|
| executor, build-fixer, debugger, deep-executor | implement |
| architect, planner, critic, analyst | analyze |
| scientist, document-specialist | analyze |
| code-reviewer, security-reviewer, quality-reviewer | review |
| designer, writer | docs |

#### 컨텍스트 머지 규칙

1. 각 선행 태스크 출력에 `=== Context from: {task_id} ({agent}: {description}) ===` 헤더 추가
2. 합친 크기가 32KB 초과 시 → 각 선행 출력을 비례 절삭
3. 빈 선행 출력 → 경고 출력, 해당 섹션 건너뜀

#### OUTPUT 섹션 추출 (CLI 결과에서)

cli-route.sh 출력에서 `=== OUTPUT ===` ~ 다음 `===` 사이의 내용을 추출:
```bash
# OUTPUT 추출
echo "$result" | sed -n '/^=== OUTPUT ===/,/^=== /{/^=== OUTPUT ===/d;/^=== /d;p}'
```

#### 토큰 스냅샷 (실행 전/후)

각 서브태스크 실행 전, 토큰 상태를 캡처:
```bash
Bash("node ~/.claude/scripts/token-snapshot.mjs snapshot pre-{subtask_id}")
```

각 서브태스크 완료 후, 토큰 상태 캡처 + diff 계산:
```bash
Bash("node ~/.claude/scripts/token-snapshot.mjs snapshot post-{subtask_id}")
Bash("node ~/.claude/scripts/token-snapshot.mjs diff pre-{subtask_id} post-{subtask_id} --agent {agent} --cli {cli} --id {subtask_id}")
```

> **참고:** cli-route.sh가 실행별 토큰을 JSONL 로그에 직접 기록하므로, 병렬 실행 시에도 정확한 추적 가능.
> 스냅샷 diff는 단일 워커 검증용, 로그 토큰은 병렬 워커 구분용으로 이중 추적.

### Phase 4: 결과 수집

모든 백그라운드 작업 완료 후 결과 수집.

#### CLI 워커 결과 파싱

`=== CLI-ROUTE RESULT ===` 헤더에서:

| 필드 | 의미 |
|------|------|
| `exit_code: 0` + `status: success` | 성공. OUTPUT 섹션 사용 |
| `exit_code: 0` + `status: success_with_warnings` | 성공 + 경고 |
| `exit_code: 124` + `status: timeout` | 타임아웃. PARTIAL OUTPUT 사용 |
| `exit_code: ≠0` + `status: failed` | 실패. STDERR 확인 |

#### DAG 모드 추가 처리

- 각 레벨 완료 후 context_output 파일 저장
- 실패한 태스크의 모든 후속 의존 태스크를 SKIPPED로 마킹
- 부분 성공: 완료된 태스크의 컨텍스트 파일은 보존

**실패 전파 규칙:**
| 시나리오 | 처리 |
|----------|------|
| Level N 태스크 실패 | 해당 태스크에 직접/간접 의존하는 모든 태스크를 SKIPPED |
| Level N 태스크 타임아웃 | 실패와 동일 처리 |
| 같은 레벨 일부 실패 | 다른 독립 태스크는 계속 실행 |
| 전체 레벨 실패 | 이후 레벨 전부 SKIP |

### Phase 5: 실패 처리

1. **1차 실패** → Claude 네이티브 에이전트로 fallback:
   ```
   Agent(subagent_type="oh-my-claudecode:executor", model="sonnet",
        prompt="{failed_subtask}")
   ```

2. **2차 연속 실패** → 해당 서브태스크 실패 보고. 나머지 성공 결과만 종합.

3. **전체 타임아웃** → 부분 결과 보고 + 타임아웃 안내.

### Phase 6: 보고

```markdown
## tfx-auto 완료

**모드**: 자동 | **트리아지**: Codex 분류 → Opus 분해
**그래프**: {INDEPENDENT|SEQUENTIAL|DAG} | **레벨**: {max_level+1}

| # | 서브태스크 | Agent | CLI | MCP | 레벨 | 의존 | 상태 | 시간 |
|---|----------|-------|-----|-----|------|------|------|------|
| t1 | 리서치A | scientist | codex | analyze | 0 | - | success | 45s |
| t2 | 리서치B | scientist | codex | analyze | 0 | - | success | 50s |
| t3 | 구현 | executor | codex | implement | 1 | t1,t2 | success | 30s |
| t4 | 테스트 | test-engineer | claude | — | 2 | t3 | success | 25s |

### 컨텍스트 체인
t1 → t3 (t1-research-a.md, 2.3KB)
t2 → t3 (t2-research-b.md, 1.8KB)
t3 → t4 (t3-implementation.md, 4.1KB)

### 워커 t1: 리서치A
(출력 요약)

### 워커 t2: 리서치B
(출력 요약)

### 워커 t3: 구현
(출력 요약)

### 워커 t4: 테스트
(출력 요약)

### Token Savings Report

| # | 서브태스크 | Agent | CLI | Input | Output | Claude 비용(추정) | 실제 비용 | 절약 |
|---|----------|-------|-----|-------|--------|-----------------|---------|------|
| t1 | 리서치A | scientist | codex | 138K | 1.7K | $0.44 | $0.00 | $0.44 |
| t2 | 리서치B | scientist | codex | 52K | 3.1K | $0.20 | $0.00 | $0.20 |
| t3 | 구현 | executor | codex | 95K | 2.4K | $0.30 | $0.00 | $0.30 |
| t4 | 테스트 | test-engineer | claude | — | — | (Claude native) | — | — |

**총 절약: $0.94** (Codex $0.94)

전체 소요: 50s(L0) + 30s(L1) + 25s(L2) = 105s (순차) | 트리아지: Sonnet+Opus ~8s
```

> **토큰 보고서 생성 방법:** Phase 4 완료 후, 각 서브태스크의 diff 결과를 종합하여 위 테이블 출력.
> Claude 네이티브 에이전트(explore, verifier, test-engineer, qa-tester)는 토큰 측정 불가 → "Claude native" 표시.
> ```bash
> Bash("node ~/.claude/scripts/token-snapshot.mjs report {session-id}")
> ```

## 에러 레퍼런스

| 에러 | 원인 | 처리 |
|------|------|------|
| `cli-route.sh: not found` | 래퍼 스크립트 미설치 | `~/.claude/scripts/cli-route.sh` 생성 |
| `codex: command not found` | Codex CLI 미설치 | `npm install -g @openai/codex` |
| `gemini: command not found` | Gemini CLI 미설치 | `npm install -g @google/gemini-cli` |
| `status: timeout` | CLI 타임아웃 (에이전트별 동적) | 타임아웃 늘리거나 작업 범위 축소 |
| `status: failed` | CLI 에러 | stderr 로그 확인 → Claude fallback |
| `N > 10` | 워커 수 초과 | 10 이하로 조정 |
| Codex 분류 실패 | 모호한 작업 설명 | 기본값 codex로 fallback |
| Opus 분해 실패 | 작업 분해 불가 | 단일 워커로 실행 |
| 순환 의존 감지 | depends_on에 순환 존재 | 분해 재시도 또는 사용자에게 확인 |
| 컨텍스트 파일 미생성 | 선행 태스크 출력 비어있음 | 경고 후 컨텍스트 없이 실행 |
| 컨텍스트 크기 초과 | 합친 컨텍스트 > 32KB | 비례 절삭 후 실행 |
| SKIPPED 태스크 발생 | 선행 태스크 실패 | 부분 성공 보고 + 수동 재실행 안내 |

## 관련

| 항목 | 설명 |
|------|------|
| `~/.claude/scripts/cli-route.sh` | CLI 라우팅 래퍼 (필수) |
| `/omc-teams` | tmux 기반 CLI 워커 (별도) |

## Troubleshooting

CLI 실행 오류나 HUD 문제 발생 시:
1. `/tfx-doctor` — 진단 실행
2. `/tfx-doctor --fix` — 자동 수정
3. `/tfx-doctor --reset` — 캐시 초기화
