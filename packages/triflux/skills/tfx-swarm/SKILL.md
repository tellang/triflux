---
name: tfx-swarm
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --parallel swarm --mode consensus --isolation worktree` 로 리다이렉트.
  실제 swarm 엔진 (PRD 파싱, shard 스케줄링, reconcile) 은 `tfx swarm` CLI 에 그대로 유지된다.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - swarm
  - 스웜
  - 병렬 실행
  - codex-swarm
argument-hint: "<PRD 경로 — tfx-auto 로 passthrough>"
---

# tfx-swarm (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --parallel swarm --mode consensus --isolation worktree` 로 리다이렉트.
> Phase 5 (v11) 에 물리 삭제 예정.

## 동작

canonical 위임 **이전** 에 아래 bash 블록을 한 번 실행한다. Phase 5 (v11) 물리 삭제 게이트는 `.omc/state/alias-usage.log` 의 7일 zero-usage 검증에 의존 — 이 logging 이 빠지면 게이트가 영영 열리지 않는다.

```bash
mkdir -p .omc/state
echo "[deprecated] tfx-swarm -> use: tfx-auto --parallel swarm --mode consensus --isolation worktree" >&2
echo "[DEPRECATED] tfx-swarm — see tfx-auto --parallel swarm --mode consensus --isolation worktree"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tfx-swarm -> tfx-auto --parallel swarm --mode consensus --isolation worktree" >> .omc/state/alias-usage.log
```

1. 위 bash 블록 실행 (stderr 경고 + stdout `[DEPRECATED]` 마커 + alias-usage.log append).
2. ARGUMENTS 전체 앞에 `--parallel swarm --mode consensus --isolation worktree` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. tfx-auto 의 플래그 오버라이드 로직이 `tfx swarm <prd>` CLI 를 호출한다 (실제 swarm 엔진은 변경 없음).

## 등가 플래그

`--parallel swarm --mode consensus --isolation worktree`

## 이 alias 의 의미

tfx-swarm 의 "worktree 격리 + 다중 모델 + PRD 기반 오케스트레이션" 은 플래그 조합으로 entry semantics 를 표현한다. 실제 swarm 엔진 (`hub/team/swarm-planner.mjs`, `swarm-hypervisor.mjs`, file-lease, reconcile) 은 그대로 유지되고 tfx-auto 가 이 경로를 호출한다. PRD 포맷 예시는 `docs/prd/_template.md` 참조.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-swarm <PRD>` | `/tfx-auto <PRD> --parallel swarm --mode consensus --isolation worktree` |
