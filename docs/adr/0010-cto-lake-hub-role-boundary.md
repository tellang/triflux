---
id: 0010
title: CTO lake ↔ Hub role 경계 — liveness/history 평면 분리
status: proposed
date: 2026-07-07
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0005, 0007]
pr: null
---

# ADR-0010: CTO lake ↔ Hub role 경계 — liveness/history 평면 분리

## 컨텍스트와 문제 (Context)

"CTO"가 코드베이스에서 세 실체를 동시에 지칭한다: (a) `cto/` 레포-로컬 authority lake
콘솔, (b) `hub/router.mjs`의 라이브 리더 role(`roleStates`, 선출/승계/failover —
PR #442/#444/#445), (c) 그 role을 맡은 실제 세션. 경계가 문서화된 적이 없어 다음이
누적됐다 (2026-07-07 감사, 23-agent 워크플로우 + 적대적 검증):

- **양방향 의존**: hub→cto(server.mjs가 collect/status import, tray, auto-collect)와
  cto→hub(`cto/status.mjs`·`cto/hygiene.mjs`가 `hub/team/synapse-registry.mjs` 직접
  import)가 공존 — 레이어 순환.
- **tray 스키마 거짓말**: `mergedCtoStatus`가 lake JSON에 hub roles를 주입하고도
  `schema_version: "cto-lake.v1"`을 유지. lake(단일 repo) + synapse live(전 repo) +
  hub roles(전역)가 한 키에 병합.
- **presence SSOT 미정의**: register 응답(lease 발급)과 store agents row가 따로 노는
  false-positive 성공 계열(#450/#451/#454)이 반복 — "지금 누가 살아있는가"의 소유자가
  결정된 적 없음.
- **read/write 비대칭**: hub의 lake write(auto-collect)는 세션 cwd별 멀티레포인데
  tray의 lake read는 `CANONICAL_PROJECT_ROOT` 단일 고정.
- **용어 충돌**: "stale"이 세 판정 기계(hub lease 만료 / synapse TTL / hygiene ledger
  판정)를, "steward"가 두 실체(hygiene apply lock / 주기 루프 명령)를 가리킴.

## 결정 (Decision)

두 평면의 단일 목적과 의존 방향을 다음과 같이 확정한다.

1. **Hub = liveness/coordination 평면.** "지금 누가 살아있고 누가 리더인가"를 소유한다.
   **presence의 SSOT는 store(agents 테이블)다** — in-memory `roleStates`는 파생 캐시로,
   데몬 재시작 시 소실되어도 store에서 재구성 가능해야 한다. 상태 갱신을 주장하는 응답
   (register/heartbeat)은 store 반영을 검증하거나 반영 실패를 명시적으로 반환한다
   (false-positive 성공 금지 — PR #455의 effective 계약이 이 방향).
2. **CTO lake = history/authority 평면.** "이 repo에 무슨 일이 있었고 권위 스냅샷이
   무엇인가"를 소유한다. `.triflux/lake/*`(append-only ledger + 파생 current.json/md)가
   데이터이고, hub 없이 파일만으로 동작해야 한다. lake는 live 상태의 **스냅샷 기록자**이지
   실시간 뷰가 아니다.
3. **의존 방향은 hub→cto 단방향만 허용한다.** `cto/*`에서 `hub/*` import는 금지한다.
   예외는 **공용 하위 계층** 하나뿐: 의존성 없는 프리미티브(`hub/lib/cto-env.mjs` 등
   `hub/lib/` 일부)는 양쪽이 쓸 수 있는 공용 계층으로 지정하되, 목록은
   `.claude/rules/tfx-cto-hub-boundary.md`(실행 SSOT)가 관리한다. 현재 위반 2건
   (`cto/status.mjs`·`cto/hygiene.mjs`의 synapse-registry import)은 reader 주입 seam
   또는 공용 계층 강등으로 해소한다 — TTL/phase 판정 로직을 cto에 복제하는 방식은
   금지한다(판정 기계 4중화 방지, DRY).
4. **소비 표면은 lake와 live를 형제 키로 분리한다.** tray payload는 `cto`(lake)와
   `roles`(live)를 분리하고 각 섹션 라벨에 스코프("this repo" / "hub-wide")를 명시한다.
   MCP `status`·CLI 표면도 같은 계약을 따른다.
5. **role 스코프(#447 전역 vs per-project)는 이 ADR의 하위 결정으로 별도 확정한다.**
   확정 전까지 전역 단일 "cto" 스코프(의도된 DEFER)를 유지한다.

## 검토한 대안 (Considered Options)

- **A안 — 두 레이어 통합(단일 CTO 모듈)**: 이름 충돌은 사라지지만 수명주기가 다른 두
  관심사(에페메랄 조율 vs durable 히스토리)가 한 모듈에 묶여 hub 재시작·오프라인 동작이
  꼬인다. 기각.
- **B안 — cto가 hub HTTP를 직접 조회해 라이브 뷰 제공**: lake가 실시간 뷰가 되면
  "hub 없이 동작"이라는 lake의 핵심 성질이 깨지고 의존 방향도 역전된다. 기각 —
  라이브 시야가 필요하면 hub가 lake에 스냅샷/이벤트를 기록하는 방향(hub→cto)으로.
- **C안 — synapse-registry 판정 로직을 cto에 복제해 import 절단**: 순환은 풀리지만
  v10.33.1 TTL 사고 이력이 있는 판정 로직 사본이 생겨 "stale 3중 판정"을 4중으로
  악화. 기각.
- **D안(채택) — 단방향 + 공용 하위 계층 + 표면 분리**: 위 결정.

## 결과 (Consequences)

- 긍정: false-positive 성공 계열 결함의 구조적 뿌리(소유자 미정)가 제거된다. tray/MCP
  표면에서 스코프 오독이 사라진다. 커밋 스코프(`feat(hub)` vs `feat(cto)`)가 결정
  가능해진다.
- 비용: tray 키 분리와 import 절단은 packages 미러 3-layer 전체에 파급된다 —
  `packages/remote`는 `hub/server.mjs`·`tray-state.mjs`뿐 아니라 **`cto/` 8파일도
  미러**하므로 blast radius 산정에 반드시 포함한다(체크리스트는
  `.claude/rules/tfx-mirror-policy.md`).
- 후속(순서): ① 실행 규칙 파일(`.claude/rules/tfx-cto-hub-boundary.md`) — 이 ADR과 동시.
  ② tray 키 분리. ③ cto→hub import 절단. ④ collect의 죽은 hub 아티팩트 경로 정리.
  ⑤ hub role 전이의 lake ledger 기록(`role_leader_changed`) — #447 스코프 확정 이후.
  ⑥ #447 per-project keying 별도 결정.
- 되돌릴 조건: 공용 하위 계층 목록이 비대해져 사실상 양방향 의존이 되면 이 결정은
  실패한 것이다 — 그 시점에 새 ADR로 재설계한다.
