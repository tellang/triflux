---
name: tfx-auto
description: >
  통합 CLI 오케스트레이터. 커맨드 숏컷(단일) + 자동 분류/분해(병렬) + 수동 병렬. tfx-route.sh 기반.
  '코드 짜줘', '구현해줘', '만들어줘', '수정해줘', '고쳐줘', 'implement', 'build', 'fix' 같은
  구현/수정 요청에 사용. CLI 라우팅이 필요한 모든 작업에 적극 활용.
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

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.

> **Telemetry**
>
> - Skill: `tfx-auto`
> - Description: `통합 CLI 오케스트레이터. 커맨드 숏컷(단일) + 자동 분류/분해(병렬) + 수동 병렬. tfx-route.sh 기반. '코드 짜줘', '구현해줘', '만들어줘', '수정해줘', '고쳐줘', 'implement', 'build', 'fix' 같은 구현/수정 요청에 사용. CLI 라우팅이 필요한 모든 작업에 적극 활용.`
> - Session: 요청별 식별자를 유지해 단계별 실행 로그를 추적한다.
> - Errors: 실패 시 원인/복구/재시도 여부를 구조화해 기록한다.



### Step 0: 스마트 라우팅 (tfx-auto 진입 시 자동 실행)

preamble에서 routing-weights.json을 읽고, 사용자 입력을 분석하여 dispatch 결정.

```bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
WEIGHTS_FILE="$HOME/.gstack/projects/$SLUG/routing-weights.json"
USER_MODE=""
if [ -f "$WEIGHTS_FILE" ]; then
  USER_MODE=$(node -e "
    const w=JSON.parse(require('fs').readFileSync('$WEIGHTS_FILE','utf8'));
    const m=w.weights?.mode_bias||{};
    const top=Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
    if(top && top[1]>0.3) console.log(top[0]);
  " 2>/dev/null)
fi
echo "USER_PREFERRED_MODE: ${USER_MODE:-none}"
```

판단 기준 (우선순위 순):

1. **사용자 명시 키워드** (최우선):
   - "병렬", "swarm", "PRD 돌려" → `Skill("tfx-swarm")` dispatch
   - "꼼꼼히", "제대로", "deep" → 해당 `tfx-deep-*` dispatch
   - "끝까지", "멈추지마", "ralph" → `Skill("tfx-persist")` dispatch
   - "multi", "팀", "협업" → `Skill("tfx-multi")` dispatch
   - "codex로", "gemini로" → `Skill("tfx-codex")` 또는 `Skill("tfx-gemini")` dispatch

2. **PRD 인자 분석**:
   - PRD 경로 2개 이상 → `Skill("tfx-swarm")` dispatch
   - PRD 1개 + XL 규모 → `Skill("tfx-fullcycle")` dispatch

3. **선호도 가중치** (tiebreaker):
   - USER_PREFERRED_MODE가 있고 가중치 > 0.3이면 제안
   - "[tfx] 사용자 선호: {mode}. 이 모드로 실행할까요?" 1줄 표시
   - 응답 없으면 기본(auto) 진행

4. **기본**: 기존 tfx-auto 워크플로우 그대로 실행

dispatch 시 해당 스킬을 Skill 도구로 호출하고 **이 워크플로우를 종료**한다. dispatch하지 않으면 아래 기존 워크플로우 진행.

라우팅 결정 후 1줄 표시:
```
[tfx] 규모: {S/M/L/XL}, 모드: {mode} ({profile}) — 오버라이드: /tfx-multi, /tfx-swarm 등
```

> **MANDATORY RULES**
>
> 1. **실행**: CLI 에이전트는 반드시 `Bash("bash ~/.claude/scripts/tfx-route.sh ...")`. Claude 네이티브(explore/verifier/test-engineer/qa-tester)만 `Agent()`.
> 2. **비용**: Codex 우선 → Gemini → Claude 최후 수단. `claude` 선택 전 "Codex로 가능한가?" 재확인.
> 3. **DAG**: SEQUENTIAL/DAG이면 레벨 기반 순차 실행. `.omc/context/{sid}/` 생성, context_output 저장, 실패 시 후속 SKIP.
> 4. **트리아지**: Codex `exec --full-auto` 분류 + Opus 인라인 분해. Agent 스폰 금지.
> 5. **thorough 기본**: `--thorough`가 기본. Opus가 규모(S/M)·커맨드 숏컷 판단 시 자동 경량화 가능. `--quick`은 명시적 옵트아웃.
> 6. **직접 수정 금지**: implement/review/analyze 등 커맨드 숏컷 실행 시 절대로 Edit/Write 도구로 직접 코드를 수정하지 마라. 반드시 Bash(tfx-route.sh)를 통해 Codex/Gemini에 위임하라. 작업이 아무리 사소해도 예외 없음.

## 모드

| 입력 형식 | 모드 | 트리아지 |
|-----------|------|----------|
| `/implement JWT 추가` | 커맨드 숏컷 (thorough) | Opus 판단 → 규모 S면 자동 경량화 |
| `/tfx-auto "리팩터링 + UI"` | 자동 (thorough) | Codex 분류 → Opus 분해 → Pipeline |
| `/tfx-auto -q "빠르게 수정"` | 자동 (quick) | Opus 분해만, plan/verify 생략 |
| `/tfx-auto --quick "빠르게"` | 자동 (quick) | `-q` 동일 |
| `/tfx-auto 3:codex "리뷰"` | 수동 (thorough) | Opus 분해 + Pipeline |

> **tfx-auto는 `--thorough`가 기본.** 모든 작업에 plan/verify 파이프라인을 적용한다.
> Opus가 규모(S)·단순 커맨드 숏컷으로 판단하면 자동 경량화(plan/verify 생략)한다.
> 명시적 `--quick`/`-q`로 강제 경량화 가능.

## 커맨드 숏컷

커맨드명 매칭 시 트리아지 없이 즉시 실행. 패턴: `Bash("bash ~/.claude/scripts/tfx-route.sh {에이전트} '{PROMPT}' {MCP}")`.

### Codex 직행

| 커맨드 | 에이전트 | MCP |
|--------|---------|-----|
| `implement` | executor | implement |
| `build` | build-fixer | implement |
| `research` | document-specialist | analyze |
| `brainstorm` | analyst | analyze |
| `design` | architect | analyze |
| `troubleshoot` | debugger | implement |
| `cleanup` | executor | implement |
| `pm` | planner | analyze |

### 2단계: `improve`

1단계 `code-reviewer '{PROMPT}' review` → 사용자 승인 → 2단계 `executor '리뷰 반영: {요약}' implement`

### 병렬

| 커맨드 | 에이전트들 (병렬, run_in_background=true) | MCP |
|--------|------------------------------------------|-----|
| `analyze` | quality-reviewer + security-reviewer | review |
| `spec-panel` | architect + analyst + critic | analyze |
| `business-panel` | analyst + architect | analyze |

### Gemini 직행

| 커맨드 | 에이전트 | MCP |
|--------|---------|-----|
| `explain` | writer | docs |
| `document` | writer | docs |

### Claude 네이티브

| 커맨드 | 실행 |
|--------|------|
| `test` | `Agent(subagent_type="oh-my-claudecode:test-engineer", model="sonnet")` |
| `reflect` | `Bash(tfx-route.sh verifier '{PROMPT}' review)` (기본) / `Agent(subagent_type="oh-my-claudecode:verifier", model="sonnet")` (TFX_VERIFIER_OVERRIDE=claude 시) |

### 복합

| 커맨드 | 흐름 |
|--------|------|
| `estimate` | explore(haiku) → analyst(codex): 영향범위, 복잡도(S/M/L/XL), 리스크 |
| `index-repo` | explore(haiku) × 2 → Write(PROJECT_INDEX.md). mode=quick/update/full |

## 트리아지

**자동 모드:**
1. Codex 분류: `codex exec --full-auto --skip-git-repo-check` → JSON `{parts: [{description, agent: "codex|gemini|claude"}]}`
2. Opus 인라인 분해: `{graph_type: "INDEPENDENT|SEQUENTIAL|DAG", subtasks: [{id, description, scope, agent, mcp_profile, depends_on, context_output, context_input}]}`
3. 실패 시 Opus가 직접 분류+분해

**수동 모드 (`N:agent_type`):** Codex 분류 건너뜀 → Opus가 N개 서브태스크 분해. N > 10 거부.

## 파이프라인 (기본: thorough)

`--thorough`가 기본. `--quick`/`-q` 명시 시 경량화. Opus가 규모 S·단순 숏컷으로 판단 시 자동 경량화.

```
분기점은 "실행 전략"이지 "계획"이 아님:

TRIAGE
  │
  ├─ [기본/thorough] → PIPELINE INIT(plan) → PLAN → PRD → [APPROVAL]
  │                                                      │
  │                                      ┌───────────────┤
  │                                      │               │
  │                                  [1 task]        [2+ tasks]
  │                                      │               │
  │                                  AUTO 직접 실행   TEAM EXEC (multi Phase 3)
  │                                      │               │
  │                                      └───────┬───────┘
  │                                              │
  │                                          VERIFY → FIX loop → COMPLETE
  │
  ├─ [Opus 자동 경량화] → 규모 S + 단일 파일 → fire-and-forget (plan/verify 생략)
  │
  └─ [--quick 명시] → [1 task] → fire-and-forget
                      [2+ tasks] → TEAM EXEC → COLLECT → CLEANUP
```

### 단일 태스크 thorough

1. `Bash("node hub/bridge.mjs pipeline-init --team ${sid}")` — 파이프라인 초기화 (phase: plan)
2. Plan: Codex architect → 결과를 `pipeline.writePlanFile()` 저장
3. PRD: Codex analyst → acceptance criteria 확정
4. `pipeline_advance_gated` → [Approval Gate] → 사용자 승인 대기
5. Exec: tfx-auto 직접 실행 (아래 "실행" 섹션)
6. Verify: Codex verifier → 검증
7. 실패 시 Fix loop (최대 3회) → Exec 재실행
8. Complete

### 멀티 태스크 thorough

Plan/PRD/Approval은 tfx-auto에서 실행한다. 이후 2개 이상 서브태스크는 아래 라우팅 규칙으로 dispatch 엔진을 결정한다.
- 읽기 전용 shard만 있으면 `tfx-multi` Phase 3로 전환한다.
- 코드 변경 shard가 하나라도 있으면 `tfx-swarm`으로 전환한다.
- 서브태스크 배열 + `thorough: true` 신호를 함께 전달하여 선택된 엔진에서 verify/fix를 수행한다.

## 멀티 태스크 라우팅 (트리아지 후)

> **트리아지 결과에 따라 2개 이상 서브태스크는 읽기 전용이면 `tfx-multi`, 코드 변경이 포함되면 `tfx-swarm`으로 dispatch한다.**
> `--quick` 명시 시에도 엔진 선택 규칙은 동일하며, 차이는 plan/verify 생략 여부뿐이다.

| 입력 특성 | 실행 경로 | 엔진 |
|-----------|-----------|------|
| 1 태스크 S | tfx-auto 직접 실행 (fire-and-forget 가능) | 직접 실행 |
| 1 태스크 M+ | Plan/PRD/Approval → 직접 실행 → verify/fix loop | pipeline |
| 2+ 태스크 + 코드 변경 없음 | Plan/PRD/Approval 후 읽기 전용 병렬 실행 | tfx-multi |
| 2+ 태스크 + 코드 변경 포함 | Plan/PRD/Approval 후 편집 shard 병렬 실행 | tfx-swarm |
| 원격 + 코드 변경 | Plan/PRD/Approval 후 host별 shard 분리 실행 | tfx-swarm (shard host:) |

### 판정 기준

- `shard.files`에 `src/`, `hub/`, `bin/`, `packages/`, `tests/` 중 하나라도 매치하면 `code_change=true`로 간주하고 swarm 경로를 우선한다.
- shard의 agent가 `executor`, `build-fixer`, `spark`, `debugger` 중 하나면 편집 계열로 간주하고 swarm을 강제한다.
- 사용자 입력에 `"multi"` 또는 `"multi로"`가 명시되면 위 기준보다 우선하여 `tfx-multi`를 유지한다.
- 원격 shard(`host:` prefix 포함)가 코드 변경을 포함하면 항상 `tfx-swarm`으로 묶고 `shard host:` 단위로 dispatch한다.

### 예제

- **swarm 선택**: `"A, B, C 각각 다른 모듈 수정해"` → 2개 이상 + 코드 변경 포함 → `tfx-swarm`
- **multi 유지**: `"파일 3개 read-only로 분석해"` → 2개 이상 + 코드 변경 없음 → `tfx-multi`
- **사용자 override**: `"multi로 병렬 리뷰"` → 명시 override → `tfx-multi`

> **MANDATORY: 2개+ 서브태스크 시 dispatch 엔진을 먼저 판정한다.**
> 읽기 전용이면 `tfx-multi`, 코드 변경이 포함되면 `tfx-swarm`으로 위임한다. 단일 엔진으로 강제 고정하지 않는다.

**전환 방법:**

```
quick = args에 -q 또는 --quick 명시, 또는 Opus 자동 경량화 판단
force_multi = user_input에 "multi" 또는 "multi로" 포함
has_code_change = any(
  shard.agent in ["executor", "build-fixer", "spark", "debugger"] ||
  shard.files matches /(src|hub|bin|packages|tests)\//
)
has_remote_edit = any(shard.host && has_code_change)

if subtasks.length >= 2:
  if force_multi:
    → Bash("tfx multi ...")
  else if has_remote_edit:
    → Skill("tfx-swarm") with shard host: dispatch
  else if has_code_change:
    → Skill("tfx-swarm")
  else:
    → Bash("tfx multi ...")
else:
  if quick or size == "S":
    → tfx-auto 직접 실행 (fire-and-forget)
  else:
    → Pipeline init → Plan → PRD → Approval → 직접 실행 → Verify → Fix loop

if quick and subtasks.length >= 2:
  → 선택된 엔진에서 quick 모드로 실행 (plan/verify 생략)
```

## 실행

### CLI 에이전트 (Codex/Gemini)

```bash
# Level 0 / INDEPENDENT
Bash("bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile}", run_in_background=true)

# Level 1+ (컨텍스트 의존) — 4번째=timeout(빈값), 5번째=context_file
Bash("bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile} '' .omc/context/{sid}/combined-{tid}.md", run_in_background=true)
```

### Claude 네이티브

```
Agent(subagent_type="oh-my-claudecode:{agent}", model="{model}", prompt="{prompt}", run_in_background=true)
# 컨텍스트 있으면 prompt에 <prior_context>...</prior_context> 추가
```

### 에이전트 매핑

| 입력 | CLI | MCP |
|------|-----|-----|
| codex / executor / build-fixer / spark / debugger / deep-executor | Codex | implement |
| architect / planner / critic / analyst | Codex (xhigh) | analyze |
| scientist / document-specialist | Codex | analyze |
| code-reviewer / security-reviewer / quality-reviewer | Codex (review) | review |
| gemini / designer / writer | Gemini | docs |
| explore / test-engineer / qa-tester | Claude native | — |
| verifier | Codex review (기본) / Claude native (TFX_VERIFIER_OVERRIDE=claude 시) | review / — |

### MCP 프로필 자동 결정

| 에이전트 | MCP |
|----------|-----|
| executor, build-fixer, spark, debugger, deep-executor | implement |
| architect, planner, critic, analyst, scientist, document-specialist | analyze |
| code-reviewer, security-reviewer, quality-reviewer | review |
| designer, writer | docs |

### 결과 파싱

여기서 `failed`는 `tfx-route.sh`/CLI 종료 결과를 뜻한다. Claude Code `TaskUpdate` 상태값이 아니다.

| exit_code + status | 사용할 출력 |
|--------------------|-----------|
| 0 + success | `=== OUTPUT ===` 섹션 |
| 124 + timeout | `=== PARTIAL OUTPUT ===` |
| ≠0 + failed | STDERR → Claude fallback |

OUTPUT 추출: `echo "$result" | sed -n '/^=== OUTPUT ===/,/^=== /{/^=== OUTPUT ===/d;/^=== /d;p}'`

### 실패 처리

1차 → `Agent(subagent_type="oh-my-claudecode:executor", model="sonnet")` fallback.
2차 연속 실패 → 실패 보고 + 성공 결과만 종합.

### 보고 형식

```markdown
## tfx-auto 완료
**모드**: {auto|manual} | **그래프**: {type} | **레벨**: {N}
| # | 서브태스크 | Agent | CLI | MCP | 레벨 | 상태 | 시간 |
### 워커 {n}: {제목}
(출력 요약)
### Token Savings Report
(node ~/.claude/scripts/token-snapshot.mjs report {session-id})
```

## 필수 조건

- `~/.claude/scripts/tfx-route.sh` (필수)
- codex: `npm install -g @openai/codex` | gemini: `npm install -g @google/gemini-cli`

## 에러 레퍼런스

| 에러 | 처리 |
|------|------|
| `tfx-route.sh: not found` | tfx-route.sh 생성 |
| `codex/gemini: not found` | npm install -g |
| timeout / failed (`tfx-route.sh` 결과) | stderr → Claude fallback |
| N > 10 | 10 이하로 조정 |
| 순환 의존 | 분해 재시도 |
| 컨텍스트 > 32KB | 비례 절삭 |

> Claude Code `TaskUpdate`를 사용할 때는 `status: "failed"`를 쓰지 않는다.
> 실패 보고는 `status: "completed"` + `metadata.result: "failed"`로 표현한다.

## Troubleshooting

`/tfx-doctor` 진단 | `/tfx-doctor --fix` 자동 수정 | `/tfx-doctor --reset` 캐시 초기화

## 상세 레퍼런스

DAG 알고리즘, 컨텍스트 머지 규칙, 토큰 스냅샷, 보고서 상세는 `scripts/tfx-route.sh` 내부 주석 및 `hub/` 모듈 참조.
