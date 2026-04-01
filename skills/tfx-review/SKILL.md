---
name: tfx-review
description: "코드 리뷰가 필요할 때 사용한다. 'review', '리뷰해줘', '코드 봐줘', '이거 괜찮아?', 'PR 리뷰', '변경사항 확인' 같은 요청에 반드시 사용. git diff, 특정 파일, 또는 최근 변경에 대한 빠른 피드백이 필요할 때 적극 활용. 코드 변경사항 확인, '이거 문제 없어?', 'looks good?', 'LGTM?', '머지해도 될까' 같은 요청에도 적극 활용. 꼼꼼한 심층 리뷰는 tfx-deep-review를 사용."
triggers:
  - review
  - 리뷰
  - 코드 리뷰
  - code review
argument-hint: "[파일 경로 또는 변경 설명]"
---

# tfx-review — Light Code Review

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> **Deep 버전**: tfx-deep-review. "제대로/꼼꼼히" 수정자로 자동 에스컬레이션.
> **HARD RULE**: 리뷰 결과를 생성할 때 Claude가 직접 git log/diff를 실행하지 마라. Codex code-reviewer에게 위임하라.
> Codex 단일 리뷰로 빠른 피드백. 토큰 최소화.

## 워크플로우

### Step 1: 리뷰 대상 식별
```
우선순위:
  1. 사용자가 파일 경로 지정 → 해당 파일
  2. git diff (staged + unstaged) → 변경된 파일
  3. 최근 커밋 → git diff HEAD~1
```

### Step 2: Codex 리뷰 실행
```bash
bash ~/.claude/scripts/tfx-route.sh codex \
  "다음 코드 변경을 리뷰하라. 심각도별 분류(critical/high/medium/low).
   체크: 로직 결함, 보안 취약점, 성능 문제, SOLID 위반, 에러 핸들링.
   변경사항: {diff_or_file_content}" review
```

### Step 3: 결과 포맷
```markdown
## Code Review: {target}

### Critical (즉시 수정)
- [C1] {파일:라인} — {설명}

### High (수정 권장)
- [H1] {파일:라인} — {설명}

### Medium (개선 제안)
- [M1] {파일:라인} — {설명}

### Summary
{전체 코드 품질 평가 1-2줄}
```

## 토큰: ~8K
