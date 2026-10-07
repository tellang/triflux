---
paths:
  - "cto/**/*"
  - "hub/**/*"
  - "hooks/**/*"
  - "tests/cto/**/*"
  - "docs/adr/0010-*.md"
  - "docs/adr/0024-*.md"
---
# CTO lake ↔ Hub role 경계 규칙

> 근거(why): [ADR-0010: CTO lake와 Hub role 경계](../../docs/adr/0010-cto-lake-hub-role-boundary.md), [ADR-0024: CTO 조회 축소](../../docs/adr/0024-cto-explicit-queries-only.md). 이 문서가 SSOT(어떻게), ADR은 결정 이력(왜).

## 두 평면 정의

| 평면 | 소유 | 데이터 | 수명 |
|------|------|--------|------|
| **Hub** (liveness/coordination) | 지금 누가 살아있고 누가 리더인가 | store `agents` 테이블(=presence SSOT), in-memory `roleStates`(파생 캐시), 메시지 배달 | 에페메랄 — 데몬 재시작 시 store에서 재구성 |
| **CTO lake** (history/authority) | 이 repo에 무슨 일이 있었나, 권위 스냅샷 | `.triflux/lake/*` (append-only ledger + current.json/md) | durable — hub 없이 파일만으로 동작 |

lake는 live 상태의 **스냅샷 기록자**이지 실시간 뷰가 아니다.

## 의존 방향 (단방향)

```
hub/*  →  cto/*          (허용 — auto-collect, 이벤트 기록)
cto/*  →  hub/*          (금지)
cto/*  →  공용 하위 계층   (허용 — 아래 allowlist만)
```

**공용 하위 계층 allowlist** (의존성 없는 프리미티브만, 추가 시 이 표를 갱신):

| 모듈 | 사유 |
|------|------|
| `hub/lib/cto-env.mjs` | TFX_CTO_* kill-switch 판독. env만 읽는 dep-free 프리미티브 |

**금지 패턴**: `cto/*`가 `hub/team/*`를 import. 2026-10-08 에 ADR-0024 로 `cto/status.mjs`, `cto/hygiene.mjs` 의 synapse-registry import 를 걷어냈고, 조회는 저장된 레지스트리 파일만 읽는다. synapse TTL/phase **판정 로직을 cto에 복제하는 것도 금지**(판정 기계 4중화).

## Presence 계약 (false-positive 성공 금지)

- presence 갱신을 주장하는 모든 응답(register/heartbeat)은 store 반영을 검증하거나
  (`effective` readback), 반영 실패를 `ok:false`로 명시 반환한다.
- 응답에는 발신자가 대조할 수 있는 신원을 싣는다: `hub_pid`,
  `effective.store_type`(sqlite|memory), `effective.db_path`.
- 큐잉만 하고 배달을 보장하지 않는 응답(ask/publish)은 "성공"이 배달을 뜻하지 않음을
  응답 필드로 구분해야 한다(#450 수리 방향).
- 아무 것도 하지 않은 작업을 ack/성공으로 기록하지 않는다(hygiene skip은 skip으로).

## 용어표

| 단어 | 평면 | 정확한 의미 | 코드 |
|------|------|------------|------|
| stale (lease) | hub | agents lease 만료 | `store.sweepStaleAgents` |
| stale (session) | synapse | registry TTL 초과 | `hub/team/synapse-registry.mjs` |
| stale (hygiene) | lake | ledger/overlay 판정 | `cto/hygiene.mjs` |

UI/문서에서 "stale"을 표기할 때는 어느 평면인지 라벨을 붙인다.

## 소비 표면 계약

- lake 합성물에 hub 데이터(roles 등)를 주입한 채 `cto-lake.v1` 스키마를 붙이지
  않는다. lake와 hub live 상태를 함께 내보내는 표면은 둘을 형제 키로 분리하고 섹션
  라벨에 스코프를 명시한다("this repo" / "hub-wide").
- hub의 lake **write**(auto-collect)는 세션 cwd별 멀티레포, `tfx cto status`의 lake
  **read**는 현재 단일 repo — "hub가 모든 프로젝트 lake를 보여준다"고 서술하지 않는다.
- CTO 트레이(옛 tray payload 소비자)는 제거됐다. 근거(why):
  [ADR-0022](../../docs/adr/0022-remove-cto-tray.md).

## 커밋 스코프 규약

| 작업 | 스코프 |
|------|--------|
| roleStates/선출/sweeper/presence/메시징 | `feat(hub)` / `fix(hub)` |
| lake/collect/status/hygiene/events | `feat(cto)` / `fix(cto)` |

(PR #442가 `feat(cto)`로 hub/router 작업을 표기한 오표기 재발 방지.)

## 관련

| 대상 | 포인터 |
|------|--------|
| 결정 근거 | `docs/adr/0010-cto-lake-hub-role-boundary.md` |
| CTO 조회 축소 | `docs/adr/0024-cto-explicit-queries-only.md` |
| role 스코프(전역 vs per-project) | 이슈 #447 (의도적 DEFER — ADR 하위 결정으로 별도 확정) |
| 미러 범위(cto/ 포함) | `.claude/rules/tfx-mirror-policy.md` |
| resident CTO PRD | `.triflux/plans/resident-cto-manager.md` (precursor 브랜치) |
