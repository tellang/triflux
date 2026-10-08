---
id: 0035
title: CTO 삭제
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: [0024]
superseded_by: null
relates: [0022, 0024]
pr: null
---

# ADR-0035: CTO 삭제

## 컨텍스트와 문제

ADR-0024 는 CTO 를 `tfx cto collect`, `tfx cto status`, hygiene dry-run 조회로 줄였다. 그 뒤 남은 기록은 `collect` 와 Codex, Antigravity 세션 훅의 `session_started` 두 종류뿐이었다. hygiene 가 읽는 이벤트(task, checkpoint, worktree, session_stale, hygiene_applied)는 기록하는 코드가 없어 늘 0 을 보였다(#647). ledger 잠금 파일이 남으면 이후 기록이 계속 건너뛰어지는 결함도 있었다(#646). 세션 훅의 기록은 `TFX_CTO_AUTO_COLLECT=1` 을 켠 기기에서만 돌았다.

2026-10-08 사용자가 CTO 전체 삭제를 결정했다.

## 결정

CTO 를 통째로 지운다.

- `cto/` 전체, `tfx cto` 명령과 도움말, 전용 테스트, packages 미러, pack 과 미러 검사 목록의 cto 항목을 지운다.
- 세션 훅의 ledger 기록(`scripts/lib/session-presence.mjs`)과 그 게이트를 읽던 `hub/lib/cto-env.mjs` 를 지운다. Codex 세션 훅은 세션 레지스트리 기록만 남는다.
- Antigravity 세션 훅은 ledger 기록이 유일한 동작이었다. 설치된 hooks.json 이 이 파일을 가리키므로 빈 성공 응답만 하는 훅으로 남기고, 훅과 설치기, 사용자 설정 항목 정리는 후속 이슈에서 한다.
- 생산자가 없는 `ctoHygiene` 알림 종류를 지운다.
- `.claude/rules/tfx-cto-hub-boundary.md`, README 와 AGENTS.md 의 CTO 절, CTO 설계 문서를 지우거나 보관 위치로 옮긴다.

## 검토한 대안

- **hygiene 만 지우고 잠금 결함을 고친다**: 수집과 status 는 남지만, 쓰는 사람이 없는 기능을 계속 유지해야 한다.
- **전체 삭제(채택)**: 기록, 조회, 훅 연결, 문서가 한 번에 사라진다.

## 결과

- `tfx cto` 를 부르면 알 수 없는 명령 오류가 난다.
- 사용자 저장소의 `.triflux/lake/` 데이터는 지우지 않는다. 읽고 쓰는 코드가 없으니 남아 있어도 영향이 없다.
- `TFX_CTO*`, `TFX_LEAD_MANAGER` 환경변수는 더 이상 읽지 않는다.

## 되돌리는 방법

삭제 PR 을 `git revert` 하면 코드, 훅 연결, 문서가 함께 돌아온다. 다시 만들 때는 이 ADR 을 대체하는 새 ADR 을 쓴다.
