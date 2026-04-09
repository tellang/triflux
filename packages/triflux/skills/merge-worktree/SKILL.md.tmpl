---
name: merge-worktree
description: "워크트리 브랜치를 main으로 squash-merge + conventional commit 자동 생성. codex-swarm 워크트리 자동 인식. '머지해', 'merge worktree', '워크트리 머지', '결과 수집', 'squash merge' 요청에 사용."
argument-hint: "[target-branch]"
disable-model-invocation: true
---

# Merge Worktree

워크트리 브랜치를 대상 브랜치로 squash-merge하고 conventional commit 메시지를 자동 작성한다.

## Current context

* Git dir: `!git rev-parse --git-dir`
* Current branch: `!git branch --show-current`
* Recent commits: `!git log --oneline -20`
* Working tree status: `!git status --short`

## Instructions

### Phase 1: Validation

1. **Worktree 확인**: `git rev-parse --git-dir` 출력에 `/worktrees/`가 포함되어야 한다. 아니면 중지.

2. **현재 브랜치 확인**: `git branch --show-current`

3. **대상 브랜치 결정**:
   * `$ARGUMENTS`가 있으면 해당 브랜치 사용
   * 없으면 `main` 존재 확인, 없으면 `master`

4. **원본 레포 경로 확인**: `git rev-parse --git-common-dir`의 부모 디렉토리

5. **클린 상태 확인**: `git status --porcelain`이 비어있어야 한다. 미커밋 변경이 있으면 먼저 커밋/스태시 안내.

### Phase 2: Research

1. **커밋 이력**: `git log --oneline <target>..HEAD`

2. **변경 파일 요약**: `git diff <target>...HEAD --stat`

3. **전체 diff**: `git diff <target>...HEAD` — 꼼꼼히 읽는다.

4. **핵심 파일 읽기**: 가장 큰 변경, 신규 파일, 삭제 파일을 Read로 확인.

5. **변경 분류**:
   * Features (신규 기능)
   * Fixes (버그 수정)
   * Refactors (구조 변경)
   * Tests (테스트)
   * Docs (문서)
   * Config/Chore (빌드, CI, 의존성)

6. **dominant type 결정**: `feat`, `fix`, `refactor`, `docs`, `chore`, `test` 중 하나

### Phase 3: 대상 브랜치 준비

1. **대상 브랜치 최근 커밋 확인**: `git -C <원본레포> log --oneline -10 <target>`

2. **WIP 커밋 감지**: `wip:`, `auto-commit`, `WIP` 시작 커밋이 있으면 사용자에게 경고.

3. **최신 fetch**: `git -C <원본레포> fetch origin <target> 2>/dev/null`

### Phase 4: Squash Merge

1. **대상 브랜치 checkout**:
   ```
   git -C <원본레포> checkout <target>
   ```

2. **squash merge 실행**:
   ```
   git -C <원본레포> merge --squash <워크트리브랜치>
   ```

3. **충돌 처리**: 충돌 발생 시 충돌 파일 목록 + 마커를 보여주고 **중지**. 자동 해결 시도 금지.

### Phase 5: 커밋 메시지 작성 + 커밋

Phase 2 분석 기반으로 아래 구조의 커밋 메시지를 작성한다:

```
<type>: <명령형 요약, 72자 이내, 마침표 없음>

<무엇을 왜 했는지 2-4문장. 동기와 접근 방식 중심.>

Changes:
* <그룹별 변경 사항>
* <하위 항목은 서브 불릿>
```

**규칙:**
* `<type>`은 `feat`, `fix`, `refactor`, `docs`, `chore`, `test` 중 하나
* 여러 유형이 섞이면 dominant 사용
* 요약: 명령형 ("add", "fix", "refactor"), 마침표 없음, 72자 제한
* 본문: *왜*와 *맥락*, *무엇*만이 아님
* Changes: 관련 항목 그룹핑, 중요한 것 먼저
* Co-Authored-By 푸터 **절대 추가 금지** (글로벌 설정 `includeCoAuthoredBy: false`)

**커밋 실행**:
```bash
git -C <원본레포> commit -m "$(cat <<'EOF'
<커밋 메시지>
EOF
)"
```

### Phase 6: 정리 + 검증

1. **커밋 확인**: `git -C <원본레포> log --oneline -3`

2. **워크트리 자동 정리**:
   ```bash
   git -C <원본레포> worktree remove <워크트리경로>
   git -C <원본레포> branch -d <워크트리브랜치>
   ```

3. **codex-swarm 정리 감지**: 워크트리 경로가 `.codex-swarm/wt-*` 패턴이면:
   * 같은 `.codex-swarm/` 디렉토리에 다른 워크트리가 남아있는지 확인
   * 모든 워크트리가 머지 완료되었으면 `.codex-swarm/` 전체 정리 제안
   * `git worktree prune` 실행

4. **결과 보고**:
   * 커밋 해시 + 요약
   * 머지 대상 브랜치
   * 워크트리 정리 완료 여부
   * push 안내 (`git push`)

## codex-swarm 연동

이 스킬은 `tfx-codex-swarm`의 Step 10 "결과 수집"에서 자동으로 호출된다.
codex-swarm이 완료한 각 워크트리에 대해 순차적으로 실행:

```
각 워크트리에 대해:
  1. 워크트리로 cd
  2. /merge-worktree main
  3. 다음 워크트리로 이동
```

## 주의사항

* force-push, destructive 연산은 사용자 확인 없이 절대 실행 금지
* pre-commit hook 건너뛰기(`--no-verify`) 금지
* 예상치 못한 상황이면 추측하지 말고 **중지 후 설명**
