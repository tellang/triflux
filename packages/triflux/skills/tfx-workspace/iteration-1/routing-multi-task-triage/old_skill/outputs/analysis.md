# tfx-auto 라우팅 분석

## 입력
```
/tfx-auto 프론트엔드 리팩터링하고 보안 리뷰도 해줘
```

---

## 1. 모드 선택

**선택된 모드: 자동(Auto)**

입력 형식이 `/tfx-auto "..."` 형태이며, 커맨드 숏컷 키워드(`implement`, `build`, `research` 등) 없이 자연어 복합 요청이 주어졌다. 또한 수동 모드의 `N:agent_type` 접두어도 없다.

SKILL.md 모드 판정표에 따라:

| 입력 형식 | 모드 | 트리아지 |
|-----------|------|----------|
| `/tfx-auto "리팩터링 + UI"` | 자동 | Codex 분류 → Opus 분해 |

따라서 이 요청은 **자동 모드**로 처리되며, 트리아지 파이프라인이 전부 실행된다.

---

## 2. 트리아지 실행 여부 및 방식

**트리아지가 트리거된다.**

자동 모드에서는 다음 2단계 트리아지가 수행된다:

### 2-1단계: Codex 분류

```bash
codex exec --full-auto --skip-git-repo-check
```

프롬프트를 Codex에 전달하여 태스크를 부분(parts)으로 분류한다. 반환 형식:

```json
{
  "parts": [
    { "description": "프론트엔드 리팩터링", "agent": "codex" },
    { "description": "보안 리뷰", "agent": "codex" }
  ]
}
```

### 2-2단계: Opus 인라인 분해

Codex 분류 결과를 바탕으로 Opus가 서브태스크를 분해한다. 반환 형식:

```json
{
  "graph_type": "INDEPENDENT",
  "subtasks": [
    {
      "id": "t1",
      "description": "프론트엔드 코드 리팩터링",
      "scope": "frontend",
      "agent": "executor",
      "mcp_profile": "implement",
      "depends_on": [],
      "context_output": "refactor-summary",
      "context_input": null
    },
    {
      "id": "t2",
      "description": "보안 취약점 리뷰",
      "scope": "security",
      "agent": "security-reviewer",
      "mcp_profile": "review",
      "depends_on": [],
      "context_output": "security-report",
      "context_input": null
    }
  ]
}
```

"리팩터링"과 "보안 리뷰"는 서로 독립적이므로 `graph_type: "INDEPENDENT"`로 분해될 가능성이 높다. (보안 리뷰가 리팩터링 후 코드를 대상으로 해야 한다면 `SEQUENTIAL`이 될 수도 있으나, 요청 문맥상 기존 코드를 대상으로 한 독립 병렬 작업으로 분류하는 것이 자연스럽다.)

### 트리아지 실패 시

Codex 분류 실패 → Opus가 직접 분류 + 분해를 수행한다 (SKILL.md: "실패 시 Opus가 직접 분류+분해").

---

## 3. 태스크 분해

요청 "프론트엔드 리팩터링하고 보안 리뷰도 해줘"는 명확히 두 가지 독립 태스크를 포함한다:

| # | 서브태스크 | 분류 근거 | 예상 Agent | 예상 MCP |
|---|-----------|---------|-----------|---------|
| t1 | 프론트엔드 코드 리팩터링 | "리팩터링" 키워드 → 코드 수정 작업 | executor | implement |
| t2 | 보안 취약점 리뷰 | "보안 리뷰" 키워드 → 보안 분석 작업 | security-reviewer | review |

에이전트 매핑 근거 (SKILL.md "에이전트 매핑" 섹션):
- `executor` → Codex, MCP: implement
- `security-reviewer` → Codex (review), MCP: review

---

## 4. 서브태스크 수 >= 2 일 때의 동작 (tfx-multi 위임)

**서브태스크가 2개이므로 tfx-multi Native Teams 모드로 자동 전환된다.**

SKILL.md 규칙:
> 트리아지 결과 서브태스크가 2개 이상이면 tfx-multi Native Teams 모드로 자동 전환한다.

| 서브태스크 수 | 실행 경로 |
|---|---|
| 1개 | tfx-auto 직접 실행 |
| **2개+ (현재 케이스)** | **tfx-multi Phase 3** (TeamCreate → TaskCreate → Agent 래퍼) |

전환 시 주요 규칙:
- 트리아지 결과(서브태스크 배열)를 그대로 tfx-multi Phase 3에 전달한다.
- tfx-multi의 Phase 2(트리아지)는 건너뛴다 (이미 수행했으므로).
- Phase 3a(TeamCreate)부터 시작한다.

```
subtasks.length >= 2
  → tfx-multi Phase 3 실행 (트리아지 결과 재사용)
  → TeamCreate → TaskCreate × 2 → Agent 래퍼 spawn (Phase 3a~3c)
  → Phase 4 결과 수집 → Phase 5 정리
```

---

## 5. 실행 시퀀스 (전체 흐름)

```
[Step 1] 모드 판정
  입력: /tfx-auto 프론트엔드 리팩터링하고 보안 리뷰도 해줘
  → 커맨드 숏컷 없음, N:agent 없음
  → 자동 모드 확정

[Step 2] 트리아지 1단계 — Codex 분류
  codex exec --full-auto --skip-git-repo-check
  프롬프트: "프론트엔드 리팩터링하고 보안 리뷰도 해줘"
  → 반환: { parts: [ {description, agent}, ... ] }
  (실패 시: Step 3으로 넘어가되 Opus가 직접 분류)

[Step 3] 트리아지 2단계 — Opus 인라인 분해
  Codex 분류 결과를 입력으로 Opus 호출
  → 반환: { graph_type: "INDEPENDENT", subtasks: [ t1(리팩터링), t2(보안리뷰) ] }

[Step 4] 서브태스크 수 판정
  subtasks.length = 2 → >= 2 조건 충족
  → tfx-multi Phase 3으로 전환

[Step 5] tfx-multi Phase 3a — TeamCreate
  팀 생성: 2개의 워커 슬롯 확보

[Step 6] tfx-multi Phase 3b — TaskCreate × 2
  Task 1: 프론트엔드 리팩터링 (executor / implement)
  Task 2: 보안 리뷰 (security-reviewer / review)

[Step 7] tfx-multi Phase 3c — Agent 래퍼 spawn (병렬)
  graph_type = INDEPENDENT이므로 두 태스크를 동시에 실행:

  워커 1 (t1 - 리팩터링):
    Bash("bash ~/.claude/scripts/tfx-route.sh executor '프론트엔드 코드 리팩터링' implement",
         run_in_background=true)

  워커 2 (t2 - 보안 리뷰):
    Bash("bash ~/.claude/scripts/tfx-route.sh security-reviewer '보안 취약점 리뷰' review",
         run_in_background=true)

  (graph_type이 SEQUENTIAL이었다면 t1 완료 후 context_output을
   .omc/context/{sid}/combined-{tid}.md에 저장하고 t2에 5번째 인자로 전달)

[Step 8] tfx-multi Phase 4 — 결과 수집
  각 워커의 exit_code 판정:
    exit 0 + success → === OUTPUT === 섹션 추출
    exit 124 + timeout → === PARTIAL OUTPUT === 사용
    exit ≠0 + failed → stderr 수집 → Claude fallback 실행
      1차 fallback: Agent(subagent_type="oh-my-claudecode:executor", model="sonnet")
      2차 연속 실패: 실패 보고 + 성공 결과만 종합

[Step 9] tfx-multi Phase 5 — 정리 및 보고
  보고 형식:
    ## tfx-auto 완료
    **모드**: auto | **그래프**: INDEPENDENT | **레벨**: 0
    | # | 서브태스크 | Agent | CLI | MCP | 레벨 | 상태 | 시간 |
    | 1 | 프론트엔드 리팩터링 | executor | Codex | implement | 0 | ✓ | Xs |
    | 2 | 보안 리뷰 | security-reviewer | Codex | review | 0 | ✓ | Xs |
    ### 워커 1: 프론트엔드 리팩터링
    (출력 요약)
    ### 워커 2: 보안 리뷰
    (출력 요약)
    ### Token Savings Report
    node ~/.claude/scripts/token-snapshot.mjs report {session-id}
```

---

## 6. 핵심 판단 포인트 요약

| 항목 | 결정값 | 근거 |
|------|--------|------|
| 모드 | 자동(Auto) | 커맨드 숏컷 없음, N:agent 없음 |
| 트리아지 | 실행 (Codex → Opus) | 자동 모드 필수 |
| 서브태스크 수 | 2개 | "리팩터링" + "보안 리뷰" 명확 분리 |
| 그래프 타입 | INDEPENDENT (예상) | 두 태스크 간 의존 없음 |
| 실행 경로 | tfx-multi Phase 3 | subtasks.length >= 2 |
| 워커 1 에이전트 | executor / Codex | 코드 수정 → implement MCP |
| 워커 2 에이전트 | security-reviewer / Codex | 보안 분석 → review MCP |
| 병렬 실행 | 예 | INDEPENDENT → run_in_background=true |
