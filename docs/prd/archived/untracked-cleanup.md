# PRD: untracked 파일 정리

## 목표
packages/remote/hub/team/ 중복 사본 정리 + swarm 관련 미커밋 파일 정리.

## 작업
1. `packages/remote/hub/team/` 아래의 swarm-*.mjs, worktree-lifecycle.mjs 삭제 (hub/team/에 커밋된 원본이 존재)
2. `packages/remote/hub/team/swarm-reconciler.mjs`도 삭제 (hub/team/에 원본 있음)
3. `packages/triflux/skills/tfx-swarm/` 디렉토리가 필요하면 커밋, 아니면 삭제
4. `.tmpl` 파일들 (packages/triflux/skills/*/*.tmpl) 정리: 원본 SKILL.md가 있으면 .tmpl 삭제
5. `tests/unit/worktree-lifecycle.test.mjs` — 테스트 실행 후 통과하면 커밋
6. `tests/unit/swarm-hypervisor.test.mjs` 수정사항 — 커밋

## 판단 기준
- `hub/team/`에 동일 파일이 있으면 → `packages/remote/hub/team/` 사본 삭제
- 테스트 파일은 실행해서 통과하면 커밋
- 판단 어려우면 해당 파일은 건너뛰기

## 커밋
```
chore: untracked 파일 정리 — packages/remote 중복 제거 + 테스트 커밋
```
