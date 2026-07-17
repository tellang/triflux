# Native + Headless 2계층 하이브리드 아키텍처

> **우선순위**: P3 (장기) | **난이도**: XL | **관련 핸드오프**: H09, H10, H13

## 1. 개요

OMC Native Agent Team과 triflux headless 실행 엔진을 결합하여
의미론적 추론(Native)과 인프라 신뢰성(headless)을 동시에 확보하는 2계층 하이브리드 아키텍처.

### 핵심 원칙

| 계층 | 담당 | 구현 |
|------|------|------|
| **상위 (Native)** | 의미론적 판단, 팀 통신, 재배정 | OMC Agent SDK |
| **하위 (headless)** | CLI 실행, 에러 복구, 토큰 압축 | triflux `runHeadless` |

---

## 2. 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────┐
│              OMC Team Lead (Native Agent)                │
│  - 작업 분해, 컨텍스트 이해, 최종 판단                       │
└──────────┬────────────────────────────────────┬──────────┘
           │                                    │
    ┌──────▼──────┐                    ┌────────▼────────┐
    │  team-plan  │                    │  team-verify    │
    │  (Native)   │                    │  (Native Agent) │
    │  explore +  │                    │  검증 실패 시      │
    │  planner    │                    │  → team-fix 트리거│
    └──────┬──────┘                    └────────┬────────┘
           │ 서브태스크 목록                        │ verify 통과/실패
           │                                    │
    ┌──────▼──────────────────────────────────┐ │
    │           team-exec (triflux headless)  │ │
    │  Bash("tfx multi --headless --assign …")│ │
    │                                         │ │
    │  ┌─────────────┐  ┌─────────────┐       │ │
    │  │ codex worker│  │gemini worker│  …    │ │
    │  │ (psmux pane)│  │ (psmux pane)│       │ │
    │  └──────┬──────┘  └──────┬──────┘       │ │
    │         └────────┬───────┘              │ │
    │            handoff 수집                  │ │
    │         (150-tok cap, validated)         │ │
    └─────────────────────────────────────────┘ │
                       │ handoff 요약             │
                       └────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  team-fix (triflux)   │
                    │  headless 재실행       │
                    │  (contextFile로       │
                    │   prior_context 전달) │
                    └───────────────────────┘
```

---

## 3. 핵심 변경 사항

### 3.1 team-exec: Agent → Bash 전환

**현재 (Native Agent 직접 실행):**
```js
// OMC skill 내부
Agent({ subagent_type: "executor", model: "sonnet", prompt: subtask })
```

**변경 후 (headless CLI 위임):**
```js
// OMC skill 내부 — team-exec 스테이지
Bash(`tfx multi --headless \
  --assign codex:"${subtask1}" \
  --assign gemini:"${subtask2}" \
  --timeout 300`)
```

### 3.2 handoff 결과 수집 → Native로 전달

triflux `runHeadless`가 반환하는 `results` 배열의 `handoffFormatted` 필드를
Native Lead에게 전달. 토큰 상한 150 tok 강제 적용됨(`validateHandoff` 내 `TOKEN_HARD_CAP = 150`).

```js
// team-exec 스테이지 출력 예시
const summary = results.map(r =>
  `[${r.cli}/${r.paneName}] ${r.handoffFormatted}`
).join("\n\n");
// → Native Lead의 다음 컨텍스트에 삽입
```

### 3.3 verify 실패 → headless fix 재실행

```js
// team-verify 실패 시
if (!verified) {
  Bash(`tfx multi --headless \
    --assign ${failedCli}:"${fixPrompt}" \
    --context-file ${priorResultFile}`)
}
```

---

## 4. 인터페이스 계약 (headless → Native)

### 4.1 handoff 스키마 (기존 `hub/team/handoff.mjs` 기반)

```
--- HANDOFF ---
status: ok | partial | failed
lead_action: accept | needs_read | retry | reassign
task: <1-3 word task type>
files_changed: <comma-separated paths or "none">
verdict: <one sentence, max 80 chars>
confidence: high | medium | low
risk: low | med | high
detail: <result file path or "none">

# 실패 시 추가 필드
error_stage: dispatch | execution | timeout
retryable: yes | no
partial_output: yes | no
```

### 4.2 Native Lead 수신 형식

`formatHandoffForLead()` 출력 (80–120 tok 목표):

```
[HANDOFF] status=ok action=accept confidence=high
verdict: hub/team/headless.mjs에 contextFile 옵션 추가 완료
files: hub/team/headless.mjs
detail: /tmp/tfx-headless/tfx-hl-abc123-worker-1.txt
```

### 4.3 팀 간 흐름 요약

```
team-exec output (triflux)
  └─ handoffFormatted[] (150-tok each)
       └─ Native Lead context window에 삽입
            └─ team-verify: verdict 분석
                 ├─ accept → 완료
                 ├─ needs_read → detail 파일 읽기
                 ├─ retry → team-fix headless 재실행
                 └─ reassign → 다른 CLI로 재배정
```

---

## 5. H09, H10 활용

### 5.1 H09 — contextFile로 prior_context 전달

`team-fix` 재실행 시, 이전 실행 결과 파일을 `contextFile`로 전달:

```js
buildHeadlessCommand(cli, fixPrompt, resultFile, {
  contextFile: prevResultFile,  // H09 기능
  mcp: "implement",
})
// → prompt에 <prior_context>...</prior_context> 자동 삽입 (max 16384자)
```

### 5.2 H10 — Hub 장애 시 headless fallback

Hub 연결 실패 시에도 `runHeadless`는 독립적으로 동작:

```
Hub 연결 시도
  ├─ 성공 → Hub 경유 조율 (선호)
  └─ 실패 → Hub-less fallback 자동 전환 (H10)
       └─ psmux 직접 세션 관리
       └─ 핸드오프 결과는 동일하게 Native에 전달
```

---

## 6. 구현 로드맵

### Phase 1 — 선행 조건 완료 (현재)

| 태스크 | 상태 | 파일 |
|--------|------|------|
| H09: contextFile 옵션 | 완료 | `hub/team/headless.mjs` L67–97 |
| H10: Hub auto-restart + fallback | 완료 | `hub/team/cli/commands/start/start-headless.mjs` |
| H11: team-state.json 세션별 분리 | 완료 | state-store |
| H12: /tmp 자동 정리 | 완료 | `scripts/tmp-cleanup.mjs` |

### Phase 2 — OMC skill 연동 (단기)

1. `skills/tfx-multi/SKILL.md`에 `--headless --assign` 패턴 문서화
2. OMC `team` skill의 team-exec 스테이지에서 `Bash("tfx multi ...")` 호출 패턴 추가
3. handoff 결과를 OMC 컨텍스트에 주입하는 포맷터 구현

### Phase 3 — Native-Headless 파이프라인 구축 (중기)

1. `hub/team/pipeline.mjs` 신규 파일: plan → exec → verify → fix 4-스테이지 오케스트레이터
2. team-exec: `runHeadless` 직접 호출 (Bash 래퍼 없이)
3. team-verify: Native Agent로 handoff 배열 검증
4. team-fix: contextFile 전달 재실행 루프 (최대 2회)

### Phase 4 — 자동 라우팅 (장기)

1. `lead_action: reassign` 수신 시 다른 CLI로 자동 재배정
2. 신뢰도 기반 재시도 정책 (`confidence: low` → 자동 retry)
3. 병렬 verify: 복수 워커 결과를 동시에 검증

---

## 7. 예외 처리 행동

| 상황 | 동작 |
|------|------|
| headless timeout | `error_stage: timeout`, `retryable: no` → Native Lead가 reassign 판단 |
| HANDOFF 블록 없음 | `buildFallbackHandoff()` 자동 생성, `_fallback: true` 플래그 |
| Hub 연결 실패 | H10 fallback — psmux 직접 관리, 결과는 동일 경로로 전달 |
| contextFile 없음 | contextBlock 생략, 기존 동작 유지 (H09 조건 분기) |
| 빈 contextFile | contextBlock 생략 (H09 `ctx.length > 0` 조건) |
| 토큰 초과 (>150) | verdict 80자 절단, files_changed 3개 제한, `lead_action: needs_read` 강제 |

---

## 8. 비고

- **현재 기본 모드**: `tfx multi`의 기본 `--teammate-mode`는 `headless` (`start/index.mjs` L84)
- **Native in-process 모드**: `--teammate-mode in-process`로 mux 없이 직접 실행 가능 (소규모 태스크)
- **Phase 2 이전**: OMC skill에서 `Bash("tfx multi ...")` 패턴으로 즉시 활용 가능
- **handoff 스키마 원본**: `docs/design/handoff-schema-v7.md`
