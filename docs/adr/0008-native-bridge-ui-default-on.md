---
id: 0008
title: headless 워커를 기본으로 native-bridge claude agents 패널에 노출한다
status: accepted
date: 2026-05-21
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: "#323"
---

# ADR-0008: headless 워커를 기본으로 native-bridge `claude agents` 패널에 노출한다

## 컨텍스트와 문제 (Context)
triflux는 `tfx-auto`·`tfx multi`·`tfx swarm` 로컬 shard를 headless 워커로 돌린다. 이 워커들이 사용자에게 보이지 않으면 진행 상황을 파악할 수 없고, "시작만 하고 멈춘 것"으로 오진하기 쉽다. Claude Code의 `claude agents` 패널에 워커를 row로 노출할 수 있는 native-bridge가 생겼는데, 이걸 opt-in으로 둘지 default-on으로 둘지 결정이 필요했다.

## 결정 (Decision)
우리는 headless 워커를 **default로 `claude agents` 패널에 row로 노출**한다.

- `tfx-auto` / `tfx multi`(headless) / `tfx swarm` 로컬 shard = default **on**(`--native-bridge-ui agents`). opt-out은 `--no-native-bridge-ui`.
- interactive(tmux/wt) 경로 = default **off**.
- `tfx swarm` **원격** shard = `registerSwarmShard()`가 host≠local일 때 `{ ok: true, skipped: true }` 반환 + warn만 하고 skip. 원격 daemon 실제 등록은 후속 PRD.
- sentinel exit 즉시 daemon `sendKillBySessionId` 발사 → stale row 잔존 없음.

## 검토한 대안 (Considered Options)
- **A안: default-on 노출 (채택)** — 장점: 로컬 워커 진행이 기본으로 보임, 오진 방지, sentinel-exit로 정리 자동. 단점: 원격 shard는 아직 미노출(warn+skip, 후속).
- **B안: default-off (opt-in)** — 장점: 패널 노이즈 없음. 단점: 대부분의 사용자가 워커 가시성을 못 얻음, "멈춤" 오진 반복.
- **C안: triflux 자체 대시보드만 사용** — 장점: CLI 독립. 단점: `claude agents`와 중복 인프라, 네이티브 UI 레버리지 상실.

## 결과 (Consequences)
긍정: 로컬 headless 워커가 기본으로 가시화되고 종료 시 자동 정리된다. 부정/리스크: 원격 swarm shard는 현재 미등록(warn+skip)이라 원격 진행은 별도 경로로 확인해야 함 — 후속 PRD 대상. 구현 PRD: `.triflux/plans/native-bridge-ui-default-expansion.md`. 관련 PR: #323. 운영 상세는 `CLAUDE.md`의 `<native-bridge>` 섹션과 `.claude/rules/tfx-routing.md`의 "Headless UI default" 절.
