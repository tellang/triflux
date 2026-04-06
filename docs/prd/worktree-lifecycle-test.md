# PRD: worktree-lifecycle 테스트 검증

## 목표
tests/unit/worktree-lifecycle.test.mjs 실행 + 실패 시 수정.

## 작업
1. tests/unit/worktree-lifecycle.test.mjs를 읽고 import 경로 확인
2. hub/team/worktree-lifecycle.mjs의 실제 export와 test의 import가 일치하는지 검증
3. `node --test tests/unit/worktree-lifecycle.test.mjs` 실행
4. 실패하면 수정 (import 경로, API 불일치 등)
5. 전체 통과 후 커밋

## 커밋
```
test: worktree-lifecycle 테스트 검증 완료
```
