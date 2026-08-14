---
date: 2026-08-14
type: research
status: verified
---

# OMC 런타임 운용 비교 노트

## 결론

이번 비교에서 OMC 코드를 가져오지 않는다. Triflux의 CLI 실행·관측·정리 경계는 유지하고,
기존 등록 worktree를 다시 사용할 때의 검증만 향후 안전성 후보로 기록한다.

## PSM은 현재 Team lifecycle의 정본이 아니다

“Worktree Manager / Tmux Manager / Claude Launcher” 구성은
`docs/design/project-session-manager.md:256-305`의 PSM 설계 초안에서 왔다. 해당 초안은
`docs/design/project-session-manager.md:1030-1033` 기준 2024-01-26에 마지막 갱신되었으므로,
현재 OMC Team lifecycle의 SSOT로 취급하지 않는다.

현재 OMC는 `src/team/unified-team.ts:38-98`에서 Claude Code가 관리하는 native teammate와,
shadow registry·heartbeat로 추적하는 legacy tmux/MCP CLI worker를 구분한다. 두 lifecycle을
하나의 상태 모델이나 정리 규칙으로 합치지 않는다.

## Triflux에 적용하지 않는 범위

- OMC의 launch descriptor(`src/team/tmux-session.ts:757-836`)를 추출하거나 이식하지 않는다.
  Triflux는 이미 launch/daemon ownership과 cleanup을 소유하며, 현재의
  `hub/team/headless.mjs`는 explicit session ownership·foreign-session protection을,
  `hub/team/psmux.mjs`는 transactional cleanup을 추가한다.
- OMC는 provider/pane cleanup이 증명되지 않으면 state와 worktree를 보존한다
  (`src/team/runtime-v2.ts:4320-4522`). Triflux에도 patch preservation과 guarded cleanup이
  `hub/team/swarm-hypervisor.mjs:1699-1725`,
  `hub/team/worktree-lifecycle.mjs:132-166,466-520`에 있으므로, patch-failure 정책 변경은
  별도 결정으로 남긴다.
- PSM의 raw `tmux send-keys`, `--dangerously-skip-permissions`,
  `git worktree remove --force`, `rm -rf` fallback 예시는 채택하지 않는다
  (`skills/project-session-manager/lib/tmux.sh:64-107`,
  `skills/project-session-manager/lib/worktree.sh:180-214`). 이는 Triflux의 profile·argv·
  headless-guard·detach-first 계약과 충돌한다.

## 향후 안전성 후보: 재사용 worktree 검증

아직 구현하지 않은 유일한 후보는 기존 worker worktree 재사용 전 검증이다. OMC의
`src/team/git-worktree.ts:409-439`는 등록된 git worktree인지, dirty 상태인지, 기대 branch 또는
detached mode인지 확인하고, `454-517`은 이 확인을 통과한 worktree를 재사용한다. 해당 코드에는
별도의 cross-run run-ownership token 검증이 명시되어 있지 않다.

현재 Triflux의 `hub/team/worktree-lifecycle.mjs:234-265`는 등록된 기존 worktree를 branch,
dirty state 검증 없이 재사용한다. run ownership 검증은 OMC 해당 코드에서 추출한 동작이
아니며, Triflux에 별도로 둘 수 있는 로컬 hardening 아이디어일 뿐이다. 이 차이는 후속
안전성 작업의 후보일 뿐이며,
이번 문서 작업에서는 런타임 동작을 변경하지 않는다.

## Lifecycle 경계

Triflux는 CLI launch, observation, cleanup을 소유한다. OMC의 과거 PSM 도식은 비교
참고에만 쓰며, native Claude teammate lifecycle과 CLI/tmux worker lifecycle의 분리는 계속
보존한다.

## 출처 및 범위

2026-08-14에 OMC 로컬 소스 버전 `4.15.10-gpt56.1`과 설치된 plugin cache 버전
`4.15.7-gpt56.1`을 확인했다. 아래 OMC 경로는 모두 소스 트리 기준 상대 경로다.

## 근거 식별자

- `docs/design/project-session-manager.md:256-305,1030-1033`
- `src/team/unified-team.ts:38-98`
- `src/team/git-worktree.ts:409-439,454-517`
- `src/team/runtime-v2.ts:4320-4522`
- `src/team/tmux-session.ts:757-836`
- `skills/project-session-manager/lib/tmux.sh:64-107`
- `skills/project-session-manager/lib/worktree.sh:180-214`
