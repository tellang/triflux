# plan-0011 — 능동 CTO/lead 역할 시스템 (phased 실행 분해)

> 결정 근거(왜): [ADR-0011](../../docs/adr/0011-active-role-system-cto-scoped-lead.md). 이 문서는 **어떻게·어떤 순서로**(폐기성 실행 분해)다.
> 상위 경계: [ADR-0010](../../docs/adr/0010-cto-lake-hub-role-boundary.md) (hub liveness ↔ lake authority), 실행 SSOT `.claude/rules/tfx-cto-hub-boundary.md`.

## 북극성 (사용자 vision)

켠 세션이 알아서 역할 등록 → 리드/CTO가 알아서 섬(없으면 standup, 자면 wake) → 세션·체크포인트·goal·north-star 관리 → 주기적(역할 판단, 매번X) 세션 위생(재정렬·분리) → 핸드오프 자동화. **최상위 제약 = 업데이트 드리프트(모델명·소통방식 주~달 주기 변경)에 대한 강건성.** 블랙박스로 굴리므로 로그로 진단·수정 가능해야 함.

## Layer 0 — 강건성 + 관측성 (횡단, 모든 단계에 선적용)

| # | 항목 | 내용 |
|---|------|------|
| 0a | probe→degrade→log | 능동 로직은 하드 가정 금지. 매 사이클 capability probe, 빠지면 graceful degrade |
| 0b | 구조화 이벤트 택소노미 | **기존 triflux 로거**(service/env/module/event/dur_ms) 재사용. 신규 이벤트: `role.registered/elected/standup/woke`, `charter.cycle.{start,action.*,end}`, `handoff.auto.*`, **`drift.detected`**, **`capability.degraded`**. 발명 금지 |
| 0c | contract canary | 기존 버전-드리프트 감지(`.claude/rules/tfx-update-logic.md`)에 얹어, bump 시점에 role-activator·tfx-live·MCP 계약 스모크 |
| 0d | 미러 무결성 canary | **C7b 재발방지** — skill 미러(canonical→user-env twin) byte/의미 drift 감지. Claude→Codex 전역치환류 오염을 자동 포착 |
| — | 핵심 프리미티브 | **`elected but unreachable`**: 브리지 장애 ≠ 선출 실패. capability.degraded 로깅 + activator가 다음 후보/standup. 호출 세션 자가대행 금지 |

## 컴포넌트 & 순서

### C7 — tfx-live 선행 버그 (C2/C3가 브리지에 의존)

| 항목 | 상태 | 내용 |
|------|------|------|
| **C7a** CL-1 캡처 절단 | ✅ **완료(미커밋)** | `CAPTURE_START "-200"→"-"` 전체 스크롤백, MAX_BUFFER 10MiB 상한 유지, 회귀테스트+미러+npm test 통과. Codex 구현→Claude 교차검증 PASS. 파일: `bin/tfx-live.mjs`, `packages/triflux/bin/tfx-live.mjs`, `tests/unit/tfx-live-task-list-extract.test.mjs` |
| **C7b** codex twin 오염 | 🔴 **스코프됨(블라인드 금지)** | `~/.codex/skills/tfx-live/SKILL.md`가 전역 "Claude"→"Codex" 치환으로 오염(`--cli Codex` 실행실패, `~/.Codex` 경로오답, 신원붕괴). **codex 환경에 정상 `claude-live` 진입점이 이미 존재** → 해결은 "twin을 canonical에서 재생성" vs "tfx-live twin 은퇴하고 claude-live로 일원화" 중 택. **Codex 소유 표면 판단 필요.** 재발방지=0d 미러 canary |
| C7c(선택) CL-2/CL-3 | ⬜ 저위험 | argument-hint verb 누락(`orchestrate`/`interrupt`), UDS bug-report 무음 드롭. 별도 |

### C1 — 자동 역할 등록

- 세션시작 훅에서 **Synapse liveness 등록과 role candidate 등록을 명시 분리**. 홀더 후보로 `register`(capabilities/lease) 자동 발행.
- 파일: `hooks/session-start-fast.mjs:243` `registerInteractiveSession`, `hub/store.mjs:374` `registerAgent`(project_id·session_id·transport ref 보존), `hub/tools.mjs:188`(project_id·scope_id 계약).
- Claude/Codex 공유(`hooks/codex-session-hook.mjs`가 같은 함수 사용).

### C2 — 자동 wake/standup (activator)

- 신규 `hub/role-activator.mjs`: `createRoleActivator`/`ensureRoleAwake`. 홀더 조회 → 있으면 wake(tfx-live probe/ask/start), 자면 wake, 없으면 standup(새 role session). 실패 시 다음 후보/standup, **자가대행 금지**.
- 역할 키 일반화: `hub/router.mjs:28` `normalizeRoleName`→scoped `normalizeRoleKey`, `:190` `getRoleCandidateSource`의 `is_cto`→`is_${roleKind}`, `:409` scope 포함 snapshot, `:14` `ROLE_TOPICS`→`ROLE_KINDS`. **bare `["cto","lead"]` 금지 — scoped key 필수.**
- 소유권: team pipeline=lead 인스턴스/워커(`hub/team/orchestrator.mjs:52` `buildLeadPrompt`에 CTO charter·scope·완료조건 포함), Hub=홀더+lease/failover, tfx-live=actuator.

### C3 — 능동 charter

- 신규 versioned 스킬 `skills/tfx-cto/SKILL.md`, `skills/tfx-lead/SKILL.md`(charter 정본, ADR owner/draft 책임 명시).
- 신규 훅 `hooks/role-active-charter.mjs` + `hooks/hook-registry.json:163` 등재: 홀더에게만 "역할·epoch·charter version·스킬 호출 지침" 주입. **north-star 훅은 read-only 유지**(active 전환 금지).
- 이벤트 구동: SessionStart / no-holder message / lease 만료 / hygiene actionable hash 변경(`cto/hygiene-notify.mjs:125`) / CTO charter 발행. 고정 타이머 아님(`cto/steward.mjs`의 60s watch는 기본 경로 아님).
- compaction 지속성: `hooks/pre-compact-snapshot.mjs:129`에 role/epoch/charter version 추가. 다음 prompt에서 홀더 재검증+compact charter 재주입.
- kill-switch: `TFX_CTO=0`/`TFX_CTO_MANAGER=1`/`TFX_LEAD_MANAGER=0·1`/`TFX_CTO_NORTH_STAR=0`/`TFX_CTO_AUTO_COLLECT=0`(env 프리미티브 `hub/lib/cto-env.mjs:18`).

### C4 — 세션 위생  →  C9 — 세션 명명/색상

- C4: 역할 판단으로 주기 실행 — `session-realign`(오늘 세션 작업줄기 재편성), `checkpoint-sweep`(체크포인트 정렬), `query-census`(반복질의 포렌식), lake hygiene. **매번 X, 역할 판단.**
- C9: C4의 **가시 산출물** — 포렌식 기반 역할별 라벨 + 색상을 `claude agents` 뷰에 한 달 뒤에도 이해되는 쉬운 한국어로 표출. **session-realign 인프라 재사용**(이름/색 복원). native-bridge 워커 row 포함.

### C5 — 핸드오프 자동화

- `checkpoint-handoff` 연동. 사용자가 옆세션 작업파일 제공 → 자동 핸드오프 문서 생성·전달. (입력 파일 대기)

### C6 — ADR/문서 관리

- CTO=accountable owner, lead=draft+evidence, worker=사실만. document-harness는 CTO 소유·lead가 transaction executor. **charter는 repo calibration(`.document-harness.toml`) 우선.**
- **mnk 번호 이중배정 방어 백포트**: `docs/adr/CONVENTIONS.md`에 "발번 = `max(로컬, git ls-tree origin/main)+1` 교차확인" 추가(triflux는 멀티세션/swarm이라 선제 가치). 현행 규약엔 이 방어 없음.
- 역할별 책임을 `.claude/rules/tfx-cto-hub-boundary.md`에 추가.

### C8 — 트레이 iTerm2+tmux CTO 세션 버튼

- `hub/public/tray.html`에 실행 버튼 + `POST /api/open-cto-session`(신규, loopback-only) 왕복. 기존 `/api/focus-session`(`hub/server.mjs:1507`)은 포커스 전용이라 참고만.
- iTerm2+tmux 실행기 신규: `terminal-opener.mjs` darwin 경로가 `open -a Terminal` 하드코딩(`:53`)이라 iTerm2 분기 없음 → osascript로 iTerm2 창 생성 + `tmux new-session -A -s cto-<scope> 'tfx cto ...'`. 의존방향 주의: 실행 로직은 `hub/*`, cto는 read-only 소비(`tfx-cto-hub-boundary.md:18`).
- 미러: tray.html/server.mjs/terminal-opener.mjs 변경 시 packages 미러.

### C10 — 참여자 상호작용 프로토콜 (linchpin)

> 문제(사용자 지적): CTO/lead를 잘 만들어도 일반 Claude/Codex 세션이 **능동적으로 CTO에 접촉하지 않는다** — 뭘 언제 해야 하는지 모른다. 이게 "cto와 접촉해"를 39세션 수동 반복한 직접 원인. 모델이 "CTO에 연락"을 기억하도록 의존하면 실패한다(north-star가 read-only인 이유와 동일 함정).

**해법 = 훅 우선 2-tier. 참여자 모델의 기억에 의존하지 않는다.**

- **Tier 1 (기계적, 훅 주도, 모델 무관):** lifecycle 이벤트에서 훅이 참여자 상태를 CTO/lead에 fire-and-forget 발행. SessionStart(이미=auto-collect) 확장 → **Stop/idle 훅**(유닛 완료+요약), **PreCompact**(체크포인트 핸드오프 신호, C5 연동), blocked 감지. 파일: `hooks/`의 Stop/PreCompact 훅 + `hub/team/synapse-http.mjs` publish. **CTO unreachable → 로깅(`capability.degraded`)+계속, 워커 절대 블록 금지(Layer 0).**
- **Tier 2 (판단, 모델 대면, 최소):** 홀더가 아닌 참여자에게도 얇은 citizen 프로토콜 주입 — 우선순위 불확실/scope 변경 시 CTO에 ask. C3의 role-gate 훅과 짝: 홀더=능동 charter, 참여자=citizen 프로토콜(둘 다 versioned). north-star read-only 계약은 그대로.
- ADR-0011 후속 보완 필요: §5("non-role 세션은 역할 업무 안 함")에 "단 citizen 프로토콜로 보고/질의는 한다" 추가. eng-review 후 ADR 개정 패스에 포함.

## 실행 순서 (의존)

```
Layer 0 (0a/0b 기반) 
  → C7a ✅ → C7b ✅(codex twin) 
  → C1(등록) + C10-T1(참여자 훅 보고, C1과 짝) → C2(activator, router 일반화) 
  → C3(holder charter) + C10-T2(citizen 프로토콜, C3과 짝) 
  → C4 → C9 
  → C5, C8 (병렬 가능)
  → C6(문서 규약, 상시)
```
> C10은 linchpin이므로 C1/C3와 동반 착수(별도 뒤로 미루지 않는다).

## 교차검증 규약

- Codex 구현 → Claude 리뷰 / Claude 구현 → Codex 리뷰. self-approve 금지.
- 코드 변경 병렬 = 파일집합 disjoint 확인 후 동일 worktree 또는 swarm 격리.
- 미러 대상(hub/*, bin/*, skills/*) 변경은 `.claude/rules/tfx-mirror-policy.md` 체크리스트.

## 잔여 오픈

- C5 입력: 사용자 옆세션 작업파일 제공 대기.
- C7b: codex 스킬 토폴로지 결정(재생성 vs 은퇴) — Codex 소유.
- role scope per-project keying 세부: ADR-0011 §2로 방향 확정, 구현 시 canonical root resolver(`cto/lake-root.mjs:10`) 재사용.

---

## eng-review 반영 (2026-07-16, Codex 586s read-only) — 계약 선행으로 재편

**종합 판정: 구현 착수 기준 REJECT.** 방향은 타당하나 scoped role 데이터 모델·reachability 상태기계·cross-CLI transport·호환성 계약이 C1보다 먼저 확정돼야 함. Phase 판정: Layer0/C1/C2/C3=REJECT, C4/C5/C6/C8=MODIFY, C7=MODIFY(완료→회귀테스트로 축소).

### 최소변경 표면 정정 (계획의 4지점은 틀렸거나 과소)

- **C1 register 경로 오류**: `session-start-fast`는 Hub role register가 아니라 Synapse `/synapse/register`만 호출(`hooks/session-start-fast.mjs:243`, `hub/team/synapse-http.mjs:141`). `hub/store.mjs:374` schema에 `project_id/session_id/scope_id/transport locator` 없음(`hub/schema.sql:5`). 계획이 인용한 `hub/tools.mjs:188`은 register 아니라 **takeover_role 시작점**.
- **Scoped kernel 실제 영향 함수**: `normalizeRoleName`·`ensureRoleState`·`getRoleCandidateSource`·`refreshRoleCandidateForAgent`·`messageMatchesRole`·`buildRoleSnapshot`·`ensureRoleLeader`·`resolveRecipients`·`handlePublish`·`takeoverRole`·`reelectStaleRoles`·`getStatus` 전부(router.mjs:159/304/545/1095/1506). registration/API는 schema.sql:5·store.mjs:374·tools.mjs:128·pipe.mjs:221·bridge.mjs:616·server.mjs:1707 동반.
- **C4 hash 포인터 오류**: 실제 hash는 `ctoHygieneStateHash`(hygiene-notify.mjs:58), :125는 알림 함수.
- **Layer0 logger 오류**: 기존 logger는 `event` 필드 보장 안 함(이벤트는 `msg`로 감, scripts/lib/logger.mjs:34/90). allowlist+출력 shape 검증 테스트 필요(codex field-drop 회귀테스트 패턴 codex-mcp-profile-resolve.test.mjs:167).
- **미러 blast radius 정정**: `router.mjs`는 `packages/core`+`packages/triflux`에 복제되고 **remote는 core router를 import**(scripts/pack.mjs:23). 신규 `role-activator.mjs`는 package ownership 명시 필수 + **순수 상태기계 / 로컬 runtime(tfx-live) adapter 분리**(안 그러면 remote/core layering 파손).

### 재편 실행 순서 (계약 선행)

```
C6a 계약 선행 (구현 전 확정) ─ 아래 10개 계약
  → Layer 0 실행가능화 (logger schema + CLI별 capability probe + field-allowlist canary + 실패시 dispatch 차단 규칙 + 회귀테스트)
  → Scoped role kernel v2 (schema/store/router/status/topic/takeover/replay v2 전환 + legacy projection 테스트)
  → Registration plumbing (SessionStart + team lead가 project_id/scope_id/session_id/transport 등록 + Hub lease heartbeat)
  → Activator (per-role-key singleflight + probe + exclusion/backoff + standup + ACK/fencing, server/no-holder 경로 연결)
  → Charter hooks (Claude fast-path+UserPrompt, Codex hooks, compaction 복구 전부 연결) + C10-T2
  → 호환 소비자 전환 (tray-state.mjs:454, tray.html:376, MCP status, topic:cto, pipe replay:471 → scoped-aware)
  → Shadow rollout (manager opt-in 관찰만 → 단일 project CTO → failover drill → scoped lead)
  → C4/C9 → C5 → C8 → 마지막 C6b(문서·ADR status 확정)
```

### C6a — 확정해야 할 10개 계약 (구현 게이트)

1. **role_kind vs role_key 분리** — capability/charter 선택은 kind, election/state/topic/status는 scoped key. 동적 `roleKeys` 인덱스 별도(정적 순회 탈피).
2. **reachability 상태기계** — `electable → elected-probing → active | unreachable → quarantined → electable` enum + retry/backoff + probe 실패 후보 exclusion.
3. **activation 계약** — `ensure_role` API + 호출 연결점(no-holder publish/SessionStart/lease expiry) + 비동기 dispatch.
4. **동시성** — per-role-key singleflight + epoch fencing + activation ACK(중복 standup/stale activation 차단).
5. **Hub 재시작 durability** — role registry/epoch/holder를 store 지속화 + stale charter/holder 식별 restart semantics.
6. **v1→v2 호환** — `roles.cto`/`topic:cto` v2 status envelope + legacy projection 정책 + 전환 테스트. `topic:cto` multi-project 의미(project context 없으면 fail-closed `SCOPE_REQUIRED`).
7. **cross-CLI transport** — 후보별 transport locator/capability(Claude UDS vs Codex tmux). failover는 "activator가 probe/wake 가능한 후보"로 한정.
8. **kill-switch 우선순위** — `TFX_CTO`(master-off, north-star/auto-collect도 실제로 따르게)·`TFX_CTO_MANAGER`·`TFX_LEAD_MANAGER` 우선순위 + in-flight cancellation을 규범 계약으로.
9. **Layer 0 제어 계약** — canary 실패가 후보 exclusion/manager disable/failover 중 무엇을 하는지(로그만으론 dispatch 안 막힘).
10. **권한/후보자격** — 일반 세션이 CTO/lead 후보가 되는 조건 + CTO의 lead lifecycle 제어 권한(현 `requested_by`는 미검증 audit 문자열). charter ACK=`(role_key, epoch, charter_version)` + stale fencing. scoped lead 종료 GC(state/backlog/status). stable opaque `project_id` + wire encoding(raw absolute lake root는 cross-machine 부적합).

### C7 상태 (MODIFY→완료)

C7a·C7b·control-key 모두 완료. C7은 "미완료 구현"이 아니라 **생성·미러 회귀테스트**(codex twin 오염 정규식 canary = Layer 0d)로 축소.
