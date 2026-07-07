---
id: "0001"
title: hosts.json을 user-state 경로로 이전 (skill reference 폴더에서 분리)
type: requirement
kind: raw
status: Active
source: null
refined_by: docs/req/0001-hosts-json-user-state-refined.md
---

# hosts.json을 user-state 경로로 이전 (skill reference 폴더에서 분리)

## Source

GitHub Issue #178 (`tellang/triflux`), 2026-04-24 제기, 2026-04-25 종결.

## 원문 (raw)

### 문제

원격 호스트 설정 파일 `hosts.json`이 skill reference 폴더에 위치함:

- `skills/tfx-remote-spawn/references/hosts.json`
- `packages/triflux/skills/tfx-remote-spawn/references/hosts.json`
- `~/.claude/skills/tfx-remote-spawn/references/hosts.json` (설치본)

이는 구조적으로 잘못됨:

1. **역할 혼동**: `references/`는 skill 정의의 일부(예제, 스키마). hosts.json은 user/machine-specific state. 성격이 다름.
2. **덮어쓰기 리스크**: `tfx setup` 실행 시 source → global 방향으로 설치되면서 user가 글로벌에서 수정한 hosts.json이 덮어씌워질 가능성.
3. **동기화 부담**: user가 설정을 바꿀 때마다 세 위치(source/packages/global)를 수동으로 맞춰야 함. 임시 패치(SKILL.md fan-out 단계)는 근본 해결이 아님.

### 제안 (raw — 미확정)

hosts.json을 user-state 전용 경로로 이전. 후보 3개, 미확정:

- 후보 1: `~/.config/triflux/hosts.json` (XDG 계열 표준)
- 후보 2: `~/.triflux/hosts.json` (gstack 유사 패턴)
- 후보 3: `.omc/state/remote-hosts.json` (프로젝트 단위 상태)

필요한 변경(raw 시점 추정, 정제 전):

- `hub/lib/hosts-compat.mjs`의 `resolveHost()` 경로 탐색 로직
- `tfx-remote-setup` 스킬의 hosts.json 쓰기 위치
- `tfx setup`이 hosts.json을 설치 대상에서 제외
- migration: 기존 `references/hosts.json` 감지 시 새 경로로 자동 이전

### 배경

- 2026-04-25 `/tfx-remote setup` 사용 중 글로벌 수정 → 소스 트리 미반영 문제 발견
- 임시 패치(Option A, fan-out): SKILL.md에 동기화 단계 추가(별도 PR)
- 이 이슈는 근본 해결(Option B)

### 관련

- `.claude/rules/tfx-routing.md`의 tfx-remote-spawn 블록 참조 경로 갱신 필요
- 플랫폼별 home dir 처리(Windows `%APPDATA%` 등) 고려

## 정제 상태

3개 후보 중 하나로 확정, 구체적 shard/테스트/완료조건까지 잡은 버전은
[0001-hosts-json-user-state-refined.md](0001-hosts-json-user-state-refined.md) 참조.
