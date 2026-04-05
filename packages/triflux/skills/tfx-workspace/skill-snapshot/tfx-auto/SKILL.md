---
name: tfx-auto
description: 통합 CLI 오케스트레이터. 커맨드 숏컷(단일) + 자동 분류/분해(병렬) + 수동 병렬. tfx-route.sh 기반.
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

> **MANDATORY RULES**
>
> 1. **실행**: CLI 에이전트는 반드시 `Bash("bash ~/.claude/scripts/tfx-route.sh ...")`. Claude 네이티브(explore/verifier/test-engineer/qa-tester)만 `Agent()`.
> 2. **비용**: Codex 우선 → Gemini → Claude 최후 수단. `claude` 선택 전 "Codex로 가능한가?" 재확인.
> 3. **DAG**: SEQUENTIAL/DAG이면 레벨 기반 순차 실행. `.omc/context/{sid}/` 생성, context_output 저장, 실패 시 후속 SKIP.
> 4. **트리아지**: Codex `--full-auto` 분류 + Opus 인라인 분해. Agent 스폰 금지.

## 모드

| 입력 형식 | 모드 | 트리아지 |
|-----------|------|----------|
| `/implement JWT 추가` | 커맨드 숏컷 | 없음 (즉시 실행) |
| `/tfx-auto "리팩터링 + UI"` | 자동 | Codex 분류 → Opus 분해 |
| `/tfx-auto 3:codex "리뷰"` | 수동 | Opus 분해만 |

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
| `reflect` | `Agent(subagent_type="oh-my-claudecode:verifier", model="sonnet")` |

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

## 멀티 태스크 라우팅 (트리아지 후)

> **트리아지 결과 서브태스크가 2개 이상이면 tfx-multi Native Teams 모드로 자동 전환한다.**

| 서브태스크 수 | 실행 경로 | 이유 |
|--------------|----------|------|
| 1개 | tfx-auto 직접 실행 (아래 "실행" 섹션) | 팀 오버헤드 불필요, 경량 fire-and-forget |
| 2개+ | **tfx-multi Phase 3** (TeamCreate → TaskCreate → Agent 래퍼) | Shift+Down 네비게이션, 상태 추적, fallback |

**전환 방법:** 트리아지 완료 후 서브태스크 배열을 그대로 tfx-multi Phase 3에 전달한다.
tfx-multi의 Phase 2(트리아지)는 건너뛰고 Phase 3a(TeamCreate)부터 시작한다.

```
if subtasks.length >= 2:
  → tfx-multi Phase 3 실행 (트리아지 결과 재사용)
  → TeamCreate → TaskCreate × N → Agent 래퍼 spawn (Phase 3a~3c)
  → Phase 4 결과 수집 → Phase 5 정리
else:
  → tfx-auto 직접 실행 (아래)
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
| codex / executor / debugger / deep-executor | Codex | implement |
| architect / planner / critic / analyst | Codex (xhigh) | analyze |
| scientist / document-specialist | Codex | analyze |
| code-reviewer / security-reviewer / quality-reviewer | Codex (review) | review |
| gemini / designer / writer | Gemini | docs |
| claude / explore / verifier / test-engineer / qa-tester | Claude native | — |

### MCP 프로필 자동 결정

| 에이전트 | MCP |
|----------|-----|
| executor, build-fixer, debugger, deep-executor | implement |
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

DAG 알고리즘, 컨텍스트 머지 규칙, 토큰 스냅샷, 보고서 상세 → [`docs/tfx-auto-internals.md`](../../docs/tfx-auto-internals.md)
