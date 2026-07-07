---
id: "0001"
title: hosts.json user-state 경로 이전 요구사항
type: requirement
kind: refined
status: Active
source: docs/req/0001-hosts-json-user-state-raw.md
refined_by: null
---

# hosts.json user-state 경로 이전 요구사항 (refined)

## Source

원문(raw): [0001-hosts-json-user-state-raw.md](0001-hosts-json-user-state-raw.md) — GitHub Issue #178.

## Refined Requirement

원문의 3개 후보 중 **후보 1 `~/.config/triflux/hosts.json`**(XDG 계열,
Windows는 `%APPDATA%\triflux\hosts.json`)로 확정. 후보 2(`~/.triflux/`)·
후보 3(`.omc/state/`)는 각각 "triflux 전용 숨김 디렉토리 새로 만들 이유 없음"·
"프로젝트 단위 상태로 두면 머신을 옮길 때마다 재설정해야 함"으로 기각.

확정 요구사항:

1. `userStateHostsPath()`가 플랫폼별 user-state 경로를 반환한다.
2. 최초 `readHosts()` 호출 시 source-tree `hosts.json`이 있고 user-state
   경로가 없으면 1회 `migrateLegacyHosts()`로 자동 이전한다(idempotent,
   비파괴, 실패해도 throw 금지 — source-tree fallback 유지).
3. `tfx setup`은 user-state 파일을 설치 대상에서 제외한다(덮어쓰기 금지).
4. 기존 `readHosts()` / `resolveHost()` / `readHost()` API 시그니처는
   변경하지 않는다.

세부 shard 분해·프롬프트·완료조건은 실행 계획인
[docs/prd/178-hosts-user-state.md](../prd/178-hosts-user-state.md)가 정본이다
(이 문서는 요구사항까지만 소유하고, "어떻게 나눠 구현하나"는 PRD로 위임한다).

## Acceptance Evidence

- 구현: `hub/lib/hosts-compat.mjs`의 `userStateHostsPath()`(계약 §1) +
  `migrateLegacyHosts()`(계약 §2).
- 커밋: `deabe8d7` — `fix(#178): hosts.json user-state 경로 이전 (lazy migration
  + source-tree fallback) (#183)`.
- 테스트: `tests/integration/tfx-remote-v1v2-matrix.test.mjs`(migration·
  user-state 우선순위·source-tree fallback·비파괴 실패·cross-platform 경로
  케이스).
- Issue #178: 2026-04-24 제기 → 2026-04-25 종결(CLOSED).
