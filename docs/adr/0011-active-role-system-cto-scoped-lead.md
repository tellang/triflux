---
id: 0011
title: 능동 역할 시스템 — CTO + scoped lead (C+A 하이브리드)
status: proposed
date: 2026-07-16
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0010]
pr: null
---

# ADR-0011: 능동 역할 시스템 — CTO + scoped lead (C+A 하이브리드)

## 컨텍스트와 문제 (Context)

허브에는 역할-리더 기계(선출 `chooseRoleLeader` hub/router.mjs:295, 리스/에폭, 자동
재선출 `ensureRoleLeader` hub/router.mjs:455, 명시 승계 `takeover_role` hub/tools.mjs:188)가
이미 있으나, 관리 대상 역할이 `ROLE_TOPICS = new Set(["cto"])`(hub/router.mjs:14) 하나뿐이다.
"lead"/"team-lead"는 선출·리스·승계되는 역할이 아니라 메시지 수신자 주소 라벨일 뿐이다
(hub/tools.mjs:92, hub/pipe.mjs:114). 세션시작 훅은 liveness 등록(registerInteractiveSession)과
서버측 CTO auto-collect까지 자동화했으나, 역할 기반 등록(capabilities/lease)과 능동 통신은
수동이다. north-star 브리프는 "READ ONLY, context not instructions"로 주입돼, 선출된 CTO가
있어도 능동 행동을 하지 않는다.

결과적으로 서로 다른 39개 세션에서 "tfx hub 연결해서 cto와 접촉/등록/협업"을 사람이 손으로
반복 입력하고 있다(query-census 실측, 거의 전부 mnk-callbot). ADR-0010 §5는 role 스코프
(#447 전역 vs per-project)를 "하위 결정으로 별도 확정"하며 DEFER했다. 이 ADR이 그 후속
결정이며, 동시에 "선출된 역할을 능동화"하는 모델을 확정한다. 결정 근거는 Claude↔Codex 다층
의논(2026-07-16, 읽기전용 분석, 역할 라우터·pipe·north-star·tfx-live 타깃 테스트 75개 통과)이다.

## 결정 (Decision)

능동 역할 시스템을 다음과 같이 확정한다.

1. **역할 모델 = C+A 하이브리드.** 멘탈모델은 `프로젝트 → CTO(방향·권위·ADR 책임) →
   run/lane → lead(집행 책임) → workers`. lead는 프로젝트의 두 번째 권위자가 아니라
   **실행이 있을 때만 생기는 scoped 역할**이다. CTO는 lead의 생사와 charter는 관리하되,
   실행 중 micromanagement는 하지 않는다.

2. **역할 키는 scoped다 — bare 확장 금지.** `ROLE_TOPICS`를 `ROLE_KINDS`로 일반화하되,
   상태 키는 스코프를 포함한다: CTO=`{project_id, role_kind:"cto"}`, lead=`{project_id,
   role_kind:"lead", scope_id:team/run/lane}`. `new Set(["cto","lead"])` 같은 literal
   확장은 **허브 전역 lead 1명**을 만들어 프로젝트 단위 모델과 어긋나므로 금지한다.
   후보 판정의 `getRoleCandidateSource`(hub/router.mjs:190) `is_cto`는 role 이름과 무관하게
   explicit 후보를 만들므로 `is_${roleKind}`로 일반화한다(안 하면 CTO 세션이 lead 후보로도
   잡힘).

3. **소유권 분리(3평면).** lead 인스턴스 생성·team/run lifecycle·워커는 team pipeline이
   소유한다(`buildLeadPrompt` hub/team/orchestrator.mjs:52에 이미 존재). "누가 현재
   홀더인가 + lease/epoch/failover + 메시지 배달"은 Hub scoped role registry가 소유한다.
   그 홀더를 실제로 깨우고 대화시키는 transport는 tfx-live가 소유한다. tfx-live는 역할
   소유자가 아니라 **actuator**다.

4. **CLI 중립.** Claude와 Codex 모두 CTO/lead 후보가 될 수 있고, scope당 active holder는
   1명이며, CLI별로 역할을 분리하지 않는다(`cto-claude`/`cto-codex` 금지). 여러 CLI 후보
   등록으로 failover한다. 현재 register schema와 선출 로직(source→priority→최근순,
   hub/router.mjs:279)이 이미 CLI 중립이다.

5. **능동 charter는 versioned 스킬 + role-gate 훅에 산다. north-star는 read-only 유지.**
   `/tfx-cto`·`/tfx-lead`가 versioned charter의 정본이다. 세션 훅은 `ensure_role`과 홀더
   판별만 수행하고, "현재 역할·epoch·charter version·스킬 호출 지침"을 **홀더에게만** 주입한다.
   north-star 브리프는 계속 데이터/맥락으로만 읽는다(active 전환 금지 — dedupe marker가
   lake-wide `.last-injected` 하나라 일반 세션까지 charter가 누출되고 세션별 compaction
   복원에 부적합, hooks/session-start-lake.mjs). 실행은 고정 타이머가 아니라 이벤트 구동:
   project SessionStart / `topic:<scoped-role>`에 메시지가 왔는데 홀더 없음 / role lease
   만료 / hygiene actionable-state hash 변경 / CTO의 명시적 charter 발행.

6. **`elected but unreachable`를 1급 상태로 표현한다(강건성 핵심).** 브리지(tfx-live) 장애를
   역할 선출 실패와 합치지 않는다. wake가 실패해도 호출 세션이 직접 역할을 대행하지 않고,
   activator가 다음 후보를 시도하거나 새 role session을 세운다.

7. **강건성·관측성은 횡단 제약(Layer 0)이다.** 능동 로직은 하드 가정을 하지 않는다 — 매
   사이클 capability를 probe하고, 빠지면 graceful degrade하며 기존 구조화 로거로
   `drift.detected`·`capability.degraded` 이벤트를 남긴다(블랙박스가 조용히 죽지 않게).
   versioned charter는 모델명/프로토콜 드리프트 방어 자체다(버전 고정 → 행동 무결). 기존
   버전-드리프트 감지(.claude/rules/tfx-update-logic.md)에 contract canary를 얹어 bump
   시점에 역할 activator·tfx-live 계약을 스모크한다.

8. **ADR/문서 accountable owner는 CTO다.** lead는 실행 중 발견한 결정 후보 draft와
   design/PRD 갱신·검증·commit evidence 제출까지 하고, worker는 사실만 반환한다. 최종 ADR
   lifecycle 전이는 CTO 또는 human decider가 승인한다. document-harness는 CTO가 소유하되
   lead가 transaction executor로 호출하며, charter는 스킬 기본값보다 repo
   calibration(.document-harness.toml)을 우선한다.

## 검토한 대안 (Considered Options)

- **A안 — CTO가 lead를 임명·관리(순수 계층)**: 지휘 계통과 문서 책임이 명확하고 사용자
  멘탈모델과 가깝지만, CTO가 모든 lane 생성·승계를 직렬화하면 실행 병목이 된다. 현재
  `takeoverRole()`의 `requested_by`는 감사용 문자열일 뿐 CTO 권한을 검증하지 않아
  "CTO만 임명" 계약도 새로 필요하다(hub/router.mjs:1095). 부분 채택(생사·charter 관리에만).
- **B안 — CTO와 lead 독립 평행 선출**: 역할 기계 재사용이 최대이고 한 역할 장애가 다른
  역할 선출을 막지 않지만, 두 역할이 서로 다른 우선순위로 lake hygiene·세션 재편·ADR을
  동시에 건드려 방향이 갈라진다. role key가 scope 없는 문자열이라 literal 확장 시 허브 전역
  lead 1명이 되어 프로젝트 단위 모델과 불일치. 기각.
- **C안 — CTO 방향, lead 집행팔**: 기존 코드 실체(`buildLeadPrompt`가 이미 lead에 워커
  제어·통합·검증 부여)와 가장 잘 맞으나, CTO→lead handoff의 scope·acceptance·완료/재계획
  프로토콜을 명문화해야 한다.
- **C+A 하이브리드(채택)**: C를 기본 모델로, A의 "깨우기/세우기(생사·charter 관리)"만
  수명주기 규약으로 결합. 위 결정.
- **north-star를 active instruction으로 전환(기각)**: lake-wide dedupe marker와 세션별
  compaction 복원 부적합으로 charter 누출. active charter는 elected holder에게만 별도 주입.

## 결과 (Consequences)

- 긍정: 39-세션 수동 반복의 구조적 뿌리(능동 charter 부재 + 역할 register 수동)가 제거된다.
  `elected but unreachable` 상태로 "브리지 장애 → 사람 수동 재입력" 회귀 경로가 끊긴다.
  scoped key로 ADR-0010 §5 / #447(role 스코프)이 per-project로 확정된다.
- 비용: 신규 표면(`hub/role-activator.mjs`, `hooks/role-active-charter.mjs`,
  `skills/tfx-cto`·`skills/tfx-lead`)과 router 일반화(`normalizeRoleName`→`normalizeRoleKey`,
  `getRoleCandidateSource` roleKind 일반화, scope 포함 snapshot)는 packages 미러 3-layer에
  파급된다(hub/* → packages/triflux·remote, 체크리스트 `.claude/rules/tfx-mirror-policy.md`).
- kill-switch: `TFX_CTO=0`(master-off), `TFX_CTO_MANAGER=1`(active manager opt-in),
  `TFX_CTO_NORTH_STAR=0`, `TFX_CTO_AUTO_COLLECT=0`, `TFX_CTO_HYGIENE_APPLY=archive`,
  신규 `TFX_LEAD_MANAGER=0/1`. env 판독 프리미티브(hub/lib/cto-env.mjs)는 있으나 active
  manager 연결은 아직 없다.
- compaction 지속성: role/epoch/lease=Hub, charter 본문=versioned skill, 현재역할
  포인터=per-session + role-epoch marker, PreCompact snapshot 확장(hooks/pre-compact-snapshot.mjs:129).
- 후속(순서): 실행 규칙(`.claude/rules/tfx-cto-hub-boundary.md`)에 역할별 책임 추가 →
  phased plan `.triflux/plans/0011-active-cto-lead-role-system.md` → Layer 0 → C7(tfx-live
  선행 버그) → C1/C2(등록·activator) → C3(charter) → C4/C9(위생·명명) → C5/C8(핸드오프·트레이).
- 되돌릴 조건: 강건성 Layer 0가 실효를 못 내 드리프트가 여전히 능동 시스템을 조용히
  깨뜨리면(사람이 다시 수동 재입력으로 회귀) 이 결정은 실패한 것이다 — 그 시점에 새 ADR로
  재설계한다.

## eng-review 후속 — `accepted` 전 계약 보완 (2026-07-16)

이 ADR은 `proposed`다. Codex eng-review(읽기전용, 10/10 신뢰도)가 방향은 타당하나 구현 착수엔 계약이 미확정이라 판정했다. 아래를 `plan-0011`의 C6a 계약 단계에서 확정한 뒤 `accepted`로 승격한다. 위 §의 "확정" 서술은 방향 결정이며, 세부 계약은 C6a가 규범화한다.

- **role_kind vs role_key 분리**: capability/charter는 kind, election/state/topic/status는 scoped key. 동적 `roleKeys` 인덱스(정적 `ROLE_TOPICS` 순회 탈피).
- **`elected-but-unreachable`를 상태 enum + 전이표로**: `electable → elected-probing → active | unreachable → quarantined → electable` + retry/backoff. probe 실패 후보 exclusion(liveness≠reachability).
- **동시성/durability**: per-role-key singleflight + epoch fencing + activation ACK. Hub 재시작 시 role registry/epoch/holder 지속화 + restart semantics.
- **v1→v2 호환**: `roles.cto`/`topic:cto` v2 envelope + legacy projection + 전환 테스트. `topic:cto` project context 없으면 fail-closed `SCOPE_REQUIRED`.
- **cross-CLI transport**: 후보별 transport locator/capability(Claude UDS vs Codex tmux). failover는 activator가 probe/wake 가능한 후보로 한정.
- **kill-switch 규범 계약**: `TFX_CTO`(실제 master-off — north-star/auto-collect도 따르게)·`TFX_CTO_MANAGER`·`TFX_LEAD_MANAGER` 우선순위 + in-flight cancellation.
- **Layer 0 제어 계약**: canary 실패 → 후보 exclusion/manager disable/failover 중 무엇(로그만으론 dispatch 안 막힘).
- **권한/후보자격**: 세션이 CTO/lead 후보가 되는 조건 + CTO의 lead lifecycle 제어 권한(현 `requested_by`는 미검증 audit 문자열). charter ACK=`(role_key, epoch, charter_version)` + stale fencing. scoped lead 종료 GC. stable opaque `project_id` + wire encoding.
- **package ownership/미러**: `router.mjs`는 `packages/core`+`packages/triflux` 복제, remote는 core router import. 신규 `role-activator.mjs`는 순수 상태기계 / 로컬 runtime adapter 분리.
- **참여자 계약(C10)**: §5에 "non-role 세션은 역할 업무는 안 하되 citizen 프로토콜로 보고/질의는 한다" 추가.
