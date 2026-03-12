# ADR-009: 오케스트레이션 아키텍처 통합 결정

> 날짜: 2026-03-12
> 상태: Accepted
> 범위: Hub MCP, bridge CLI, tfx-auto, tfx-multi, OMC team 전체

---

## 배경

triflux에는 5개의 오케스트레이션 경로가 공존한다.
세션마다 "어떤 게 뭐가 낫나"를 반복 논의하게 되어,
코드 검증 기반으로 사실을 확정하고 방향을 결정한다.

---

## 5개 경로 코드 검증 결과

### 1. Hub MCP (hub/server.mjs + hub/tools.mjs)

**실체**: HTTP MCP 서버 (port 27888) + Named Pipe + SQLite WAL

| 구성 요소 | 파일 | 역할 |
|-----------|------|------|
| MCP 서버 | hub/server.mjs:55-418 | Streamable HTTP MCP + REST bridge |
| MCP 도구 12개 | hub/tools.mjs:34-329 | register, status, publish, ask, poll(deprecated), handoff, HITL 2개, team_* 4개 |
| 라우터 | hub/router.mjs:21-461 | 인메모리 Actor mailbox + EventEmitter 응답 대기 |
| 저장소 | hub/store.mjs:87-414 | SQLite WAL 감사 로그 |
| Named Pipe | hub/pipe.mjs:42-457 | NDJSON 제어 채널 (~60μs) |
| HITL | hub/hitl.mjs:9-140 | 5종 (captcha, approval, credential, choice, text) |

**ADR-002에서 Accepted**: MCP 서버 방식이 primary로 결정됨.

**현실**: `/mcp` 엔드포인트를 호출하는 프로덕션 코드 없음 (테스트만).
`poll_messages`는 deprecated. Codex/Gemini가 MCP 클라이언트로 Hub에
능동적으로 연결하는 패턴은 실제로 구현/운용되지 않음.

**사용되는 부분**: `/bridge/*` REST 엔드포인트만 tfx-route.sh에서 curl로 호출.

### 2. bridge CLI (hub/bridge.mjs)

**실체**: Named Pipe(우선) / HTTP(fallback) CLI 클라이언트

| 커맨드 | 프로토콜 | 용도 |
|--------|----------|------|
| register, result, context, deregister | Pipe → HTTP fallback | 에이전트 등록/결과 |
| team-task-list, team-task-update | **HTTP 전용** | 팀 상태 관리 |
| team-send-message, team-info | **HTTP 전용** | 팀 통신 |

**핵심 발견**: team 커맨드 4개가 HTTP 전용 (bridge.mjs:306-355).
Hub 서버가 꺼지면 Phase 4 결과 수집 실패.

**그러나**: nativeProxy.mjs (hub/team/nativeProxy.mjs:1-23)는
100% 파일시스템 직접 접근 (~/.claude/teams/, ~/.claude/tasks/).
Hub 서버는 nativeProxy를 HTTP로 프록시하는 중간 레이어일 뿐.

### 3. tfx-auto (skills/tfx-auto/SKILL.md)

**실체**: Lead Claude가 `Bash(tfx-route.sh)` 직접 실행

| 단계 | 동작 |
|------|------|
| 분류 | Codex --full-auto (무료) |
| 분해 | Opus 인라인 (Agent spawn 없음) |
| 실행 | Bash(tfx-route.sh) × N, DAG 레벨별 순차 |
| 결과 | stdout 캡처 (50KB 상한) |

**의존성**: tfx-route.sh만. Hub 무관, Native Teams 무관.
**강점**: DAG 체이닝 (context_output → context_input), 토큰 최소.
**약점**: 파이프라인(verify/fix) 없음.

### 4. tfx-multi (skills/tfx-multi/SKILL.md)

**실체**: Claude Code Native Agent Teams API + 슬림 래퍼 Agent

| 단계 | 동작 | 의존성 |
|------|------|--------|
| Phase 0 | preflight (hub/route 점검) | 선택적 |
| Phase 1 | 입력 파싱 | 없음 |
| Phase 2 | Codex 분류 + Opus 분해 | Codex CLI |
| Phase 3 | TeamCreate + Agent 래퍼 spawn | **Native Teams API 필수** |
| Phase 4 | team_task_list 결과 수집 | Hub HTTP (nativeProxy 경유) |
| Phase 5 | TeamDelete 정리 | Native Teams API |

**Native Teams 없이**: `--tmux` fallback 존재 (Phase 3-tmux).
**Hub 없이**: Phase 3 실행 OK (tfx-route.sh curl `|| true`), Phase 4 실패.
**강점**: N개 동시 병렬, Shift+Down 네비게이션, 실패 격리.
**약점**: 파이프라인(verify/fix) 없음, Hub Phase 4 의존.

### 5. OMC /team (skills/team/SKILL.md)

**실체**: 프롬프트 주도 5단계 파이프라인 + TypeScript 상태 기계

| 단계 | 에이전트 | 동작 |
|------|---------|------|
| team-plan | explore + planner | 작업 범위/접근법 설계 |
| team-prd | analyst + critic | 수용 기준 확정 |
| team-exec | executor/designer/writer | Codex/Gemini CLI 워커 실행 |
| team-verify | verifier + reviewers | 결과 검증 |
| team-fix | executor/debugger | 실패 재시도 (max 3회, 코드 강제) |

**코드 강제 (dist/hooks/team-pipeline/)**:
- transitions.js: 전이 규칙 (team-verify → [team-fix, complete, failed])
- state.js:128-161: fix loop attempt > max_attempts → 강제 failed
- bridge.js:74-100: stop 훅으로 파이프라인 지속성 보장

**Codex/Gemini 통합**:
- team-exec에서 `execution_mode` 태그: claude_worker, codex_worker, gemini_worker
- CLI 워커는 tmux pane에서 one-shot 실행
- **한계**: CLI 워커는 TaskUpdate/SendMessage 사용 불가 (Lead가 관리)
- **한계**: Windows에서 tmux 필요 (psmux 간접 지원)

**Ralph 연동**: fix loop 3회 초과 → Ralph iteration 증가 → 전체 재시도 (max 10)

---

## 비교 매트릭스 (코드 검증 완료)

| | tfx-auto | tfx-multi | Hub MCP | OMC /team |
|---|---|---|---|---|
| **파이프라인** | 없음 | 없음 | 인프라만 | **있음 (5단계)** |
| **fix loop** | 없음 | 없음 | 없음 | **3회 (코드 강제)** |
| **Codex/Gemini 라우팅** | **20종 테이블** | **20종 테이블** | MCP 도구 | tmux one-shot |
| **Named Pipe IPC** | 없음 | bridge fallback | **~60μs** | 없음 |
| **Windows** | **OK** | **psmux primary** | Named Pipe | tmux/psmux 필요 |
| **네비게이션** | 없음 | **Shift+Down** | 없음 | 없음 |
| **워커간 통신** | 불가 | 불가 | **ask/publish N:M** | SendMessage (Claude만) |
| **HITL** | 없음 | 없음 | **5종** | 없음 |
| **DAG 체이닝** | **있음** | 없음 | topic fanout | 핸드오프 파일 |
| **Hub 의존** | 없음 | Phase 4만 | **전면** | 없음 |
| **토큰 소비** | 최저 | 낮음 (~100/래퍼) | 높음 (~2,400/턴) | 중간 |
| **인터랙티브** | 없음 | 없음 | **설계상 가능** | 없음 |

---

## GitHub 이슈 현황 (49건 중 관련 25건)

### Critical/Security (4건)
| # | 제목 | 관련 |
|---|------|------|
| 22 | Hub CORS * + 인증 부재 | Hub MCP 보안 |
| 27 | json_escape 인젝션 위험 | tfx-route.sh |
| 24 | nativeProxy stale lock 영구 잠금 | bridge/Hub |
| 26 | nativeProxy O(N) I/O 블로킹 | bridge/Hub |

### High (5건)
| # | 제목 | 관련 |
|---|------|------|
| 28 | task 업데이트 3중 경로 통합 | Hub+bridge+MCP |
| 29 | status: failed 불일치 통일 | 전체 |
| 31 | 상태 저장소 3곳 분산 단일화 | 아키텍처 |
| 19 | cli.mjs God Object 분해 (1,499줄) | 구조 |
| 20 | Runtime Strategy 패턴 (11곳 분기) | 구조 |

### P0 (3건)
| # | 제목 | 관련 |
|---|------|------|
| 15 | PR#2 핵심 코드 복구 | Hub 자동기동 |
| 18 | Hub 자동기동 로직 유실 | Hub |
| 9 | psmux 통합 | 런타임 |

### P1 (3건)
| # | 제목 | 관련 |
|---|------|------|
| 48 | EXPERIMENTAL_AGENT_TEAMS API 의존 | tfx-multi |
| 21 | Hub vs TaskList 상태 이원화 | bridge |
| 23 | 테스트 인프라 전무 | 전체 |

### 해결 완료 (7건)
| # | 해결 |
|---|------|
| 52 | failed → completed + metadata.result 자동 변환 |
| 32 | ADR-002로 v2.2+ 확정 |
| 30 | ADR-003으로 SKILL.md primary |
| 37 | node-pty 파일 삭제, ADR-001로 해소 |
| 47 | ADR-003 확정으로 해소 |
| 50 | ADR-001로 사실상 해소 |
| 1 | PR#3에서 codex profiles 수정 |

---

## OMC 4.7.10 현황 (triflux와의 격차)

| 기능 | OMC 구현 | triflux 구현 | 격차 |
|------|---------|-------------|------|
| 파이프라인 | 프롬프트+코드 하이브리드 | **없음** | triflux에 필요 |
| fix loop 바운딩 | state.js 코드 강제 (3회) | **없음** | triflux에 필요 |
| Codex/Gemini CLI 라우팅 | model-contract.ts (3종) | **tfx-route.sh (20종)** | triflux 우위 |
| Named Pipe IPC | 없음 | **~60μs (ADR-004)** | triflux 우위 |
| psmux 지원 | 간접 (tmux 호환 바이너리) | **psmux primary (ADR-001)** | triflux 우위 |
| MCP 프로필 힌트 | 없음 | **프로필별 힌트 주입** | triflux 우위 |
| stream wrapper | 없음 | **codex-mcp/gemini/claude** | triflux 우위 |
| Runtime V2 | 기본 활성 (v4.7.3) | 해당 없음 | 구조 다름 |
| Ralph 연동 | 내장 (loop.js) | 없음 | triflux에 필요 |
| Team 워커 Role | `N:agent:role` (v4.7.6) | 없음 | 참고 |
| 쉼표 멀티타입 | `1:codex,1:gemini` (v4.7.7) | 없음 | 참고 |

**핵심**: OMC는 파이프라인+Ralph이 강점, triflux는 CLI 라우팅+IPC+Windows가 강점.
둘은 경쟁이 아니라 **보완 관계**.

---

## 결정 사항 (Accepted)

### Q1: Hub MCP 도구를 유지하는가? → **A: 유지**

Hub MCP 도구 유지 (ADR-002 존중). ask/publish/HITL을 파이프라인 verify/fix에서 활용 가능.
bridge REST 엔드포인트가 실질적 프로덕션 경로.

### Q2: 파이프라인을 어디에 구현하는가? → **D: 하이브리드**

SKILL.md에 `--thorough` 모드로 파이프라인 단계 지시 (프롬프트 주도) +
`hub/pipeline/` 코드 guardrails (전이 규칙, fix loop 바운딩, SQLite 상태).

구현 완료:
- `hub/pipeline/transitions.mjs` — 전이 규칙 (7단계, fix loop 3회, ralph 10회)
- `hub/pipeline/state.mjs` — SQLite CRUD
- `hub/pipeline/index.mjs` — 통합 매니저
- `skills/tfx-multi/SKILL.md` v3 — `--quick`/`--thorough` 모드

### Q3: bridge CLI의 Hub 의존성을 제거하는가? → **A: fallback 추가**

bridge CLI team 커맨드 4개에 nativeProxy 직접 import fallback 추가.
Hub 서버 미실행 시에도 파일시스템 직접 접근으로 동작.
pipeline 커맨드 2개(`pipeline-state`, `pipeline-advance`)도 동일 패턴.

---

## 기존 ADR과의 관계

| ADR | 본 문서와의 관계 |
|-----|----------------|
| ADR-001 (psmux primary) | 유지. triflux의 Windows 우위 근거. |
| ADR-002 (MCP 서버 primary) | **재검토 필요**. Q1에서 결정. |
| ADR-004 (Named Pipe) | 유지. bridge fallback으로 활용 중. |
| ADR-005 (Codex stdio MCP) | 유지. codex-mcp.mjs에 구현 완료. |
| ADR-006 (Gemini stream-json) | 유지. gemini-worker.mjs에 구현 완료. |
| ADR-007 (Claude stream-json) | 유지. claude-worker.mjs에 구현 완료. |
| ADR-008 (테스트 프레임워크) | 유지. 아직 미구현 (#23). |

---

## 참조

### 코드
- hub/server.mjs:55 — Hub 진입점
- hub/tools.mjs:34-329 — MCP 도구 12개
- hub/tools.mjs:126-128 — poll_messages deprecated
- hub/bridge.mjs:306-355 — team 커맨드 HTTP 전용
- hub/team/nativeProxy.mjs:1-23 — 순수 파일시스템
- scripts/tfx-route.sh:86-141 — team claim/complete (|| true)
- scripts/tfx-route.sh:143-250 — 20종 라우팅 테이블
- hub/team/native.mjs:27-52 — buildSlimWrapperPrompt ~100 토큰

### 문서
- docs/handoff/11-architecture-decisions.md — ADR-001~007
- docs/handoff/10-research-findings.md — R1~R5 리서치
- docs/handoff/12-tfx-team-status.md — 이슈 분류
- skills/tfx-multi/SKILL.md — Phase 0~5
- skills/tfx-auto/SKILL.md — DAG 트리아지

### OMC (v4.7.10)
- skills/team/SKILL.md:91-147 — 5단계 파이프라인
- dist/hooks/team-pipeline/transitions.js — 전이 규칙
- dist/hooks/team-pipeline/state.js:128-161 — fix loop 바운딩
- src/team/model-contract.ts — CLI 에이전트 계약
- src/team/runtime-v2.ts:378-508 — V2 워커 spawn
- src/team/phase-controller.ts — TypeScript 페이즈 추론

### GitHub
- 전체 이슈 49건 (OPEN 42, CLOSED 7)
- 전체 PR 3건 (OPEN 1, MERGED 1, CLOSED 1)
- Critical: #22, #24, #26, #27 / High: #28, #29, #31 / P0: #15, #18, #9
