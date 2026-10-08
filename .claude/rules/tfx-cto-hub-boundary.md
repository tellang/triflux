---
paths:
  - "cto/**/*"
  - "hub/**/*"
  - "hooks/**/*"
  - "tests/cto/**/*"
  - "docs/_archive/adr/0010-*.md"
  - "docs/adr/0024-*.md"
---
# CTO lake 경계 규칙

> 근거(why): [ADR-0023: 허브 제거](../../docs/adr/0023-remove-command-hooks-hub-and-adopt-mods.md), [ADR-0024: CTO 조회 축소](../../docs/adr/0024-cto-explicit-queries-only.md). 허브가 있던 시기의 평면 구분은 [ADR-0010](../../docs/_archive/adr/0010-cto-lake-hub-role-boundary.md)에 남아 있다. 이 문서가 SSOT(어떻게), ADR은 결정 이력(왜).

## 데이터 평면

| 평면 | 데이터 | 수명 |
|------|--------|------|
| **CTO lake** (history/authority) | `.triflux/lake/*` (append-only ledger + current.json/md) | durable. 파일만으로 동작하고 데몬이 필요 없다 |

허브 데몬과 synapse 레지스트리는 제거됐다. 지금 어떤 세션이 살아 있는지는 lake 가 아니라 `tfx-live`, `tmr` 같은 세션 도구가 답한다.
lake 는 이 repo 의 스냅샷 기록자이지 실시간 뷰가 아니다.

## 의존 방향

```
hub/*, hooks/*, scripts/*  →  cto/*   (허용: 세션 시작 이벤트 기록)
cto/*                      →  hub/*   (금지)
```

`cto/*` 는 `hub/*` 를 import 하지 않는다. 필요한 판독은 `cto/` 안에 둔다.
세션 상태 판정을 cto 에 복제하는 것도 금지한다.

## 소비 표면 계약

- `tfx cto status --json` 의 안정 키는 `schema_version`, `repo`, `sources`, `summary`, `ledger_tail`, `hygiene` 이다.
- lake 합성물에 다른 평면의 live 상태를 주입한 채 `cto-lake.v1` 스키마를 붙이지 않는다.
- lake 의 write(`session_started`, `collect`)는 세션 cwd별 멀티레포, `tfx cto status` 의 read 는 현재 단일 repo 다. "모든 프로젝트의 lake 를 보여준다"고 서술하지 않는다.
- 아무 것도 하지 않은 작업을 성공으로 기록하지 않는다(hygiene skip 은 skip 으로).

## 용어표

| 단어 | 의미 | 코드 |
|------|------|------|
| stale (hygiene) | ledger 의 `session_stale` 이벤트 판정 | `cto/hygiene.mjs` |

## 커밋 스코프 규약

| 작업 | 스코프 |
|------|--------|
| lake/collect/status/hygiene/events | `feat(cto)` / `fix(cto)` |
| 허브 코드 정리 | `refactor(hub)` |

## 관련

| 대상 | 포인터 |
|------|--------|
| 결정 근거 | `docs/adr/0023-remove-command-hooks-hub-and-adopt-mods.md`, `docs/adr/0024-cto-explicit-queries-only.md` |
| 미러 범위(cto/ 포함) | `.claude/rules/tfx-mirror-policy.md` |
