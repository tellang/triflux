---
name: verify-implementation
description: 프로젝트의 모든 verify 스킬을 순차 실행하여 통합 검증 보고서를 생성합니다. 기능 구현 후, PR 전, 코드 리뷰 시 사용.
disable-model-invocation: true
argument-hint: "[선택사항: 특정 verify 스킬 이름]"
---

# verify-implementation — 통합 구현 검증

## 목적

프로젝트에 등록된 모든 `verify-*` 스킬을 순차적으로 실행하여 통합 검증을 수행합니다:

- 각 스킬의 Workflow에 정의된 검사를 실행
- 각 스킬의 Exceptions를 참조하여 false positive 방지
- 발견된 이슈에 대해 수정 방법을 제시
- 사용자 승인 후 수정 적용 및 재검증

## OMC 호환

이 스킬은 OMC 파이프라인에서 **team-verify 단계의 보완 도구**로 사용 가능합니다:

- **실행 순서 권장**: `/verify-implementation` (프로젝트 규칙) → OMC `verifier` (일반 품질)
- **MCP-First 연동**: 이슈 리포트를 `ask_codex`(code-reviewer)에 전달하여 심층 리뷰 가능
- OMC `quality-reviewer`, `security-reviewer`는 **범용** → verify 스킬은 **프로젝트 고유 규칙** 검증
- OMC `/code-review`와 결합 시 프로젝트 규칙 + 범용 품질을 한 번에 확인

## 실행 시점

- 새로운 기능을 구현한 후
- Pull Request를 생성하기 전
- 코드 리뷰 중
- 코드베이스 규칙 준수 여부를 감사할 때

## 실행 대상 스킬

이 스킬이 순차 실행하는 검증 스킬 목록입니다. `/manage-skills`가 스킬을 생성/삭제할 때 이 목록을 자동 업데이트합니다.

(아직 등록된 검증 스킬이 없습니다)

<!-- 스킬이 추가되면 아래 형식으로 등록:
| # | 스킬 | 설명 |
|---|------|------|
| 1 | `verify-example` | 예시 검증 설명 |
-->

## 워크플로우

### Step 1: 소개

**실행 대상 스킬** 테이블을 확인합니다. 선택적 인수가 있으면 해당 스킬만 필터링합니다.

**등록된 스킬이 0개인 경우:**

```markdown
## 구현 검증

검증 스킬이 없습니다. `/manage-skills`를 실행하여 프로젝트에 맞는 검증 스킬을 생성하세요.
```

### Step 2: 순차 실행

각 스킬에 대해:

1. `.claude/skills/verify-<name>/SKILL.md`를 읽고 Workflow/Exceptions/Related Files 파싱
2. Workflow의 각 검사를 순서대로 실행 (Grep, Glob, Read, Bash)
3. 탐지 결과를 PASS/FAIL 기준에 대조
4. Exceptions에 해당하면 면제 처리
5. FAIL이면 이슈 기록 (파일 경로, 라인 번호, 문제, 수정 방법)

```markdown
### verify-<name> 검증 완료

- 검사 항목: N개
- 통과: X개
- 이슈: Y개
- 면제: Z개
```

### Step 3: 통합 보고서

```markdown
## 구현 검증 보고서

### 요약

| 검증 스킬 | 상태 | 이슈 수 |
|-----------|------|---------|
| verify-<name1> | PASS / X개 이슈 | N |
| verify-<name2> | PASS / X개 이슈 | N |

**발견된 총 이슈: X개**
```

**이슈 발견 시:**

```markdown
### 발견된 이슈

| # | 스킬 | 파일 | 문제 | 수정 방법 |
|---|------|------|------|-----------|
| 1 | verify-<name> | `path:42` | 문제 설명 | 수정 코드 |
```

### Step 4: 사용자 액션 확인

`AskUserQuestion`으로 확인:
1. **전체 수정** — 모든 권장 수정사항 자동 적용
2. **개별 수정** — 각 수정사항 하나씩 검토
3. **건너뛰기** — 변경 없이 종료

### Step 5: 수정 적용

사용자 선택에 따라 수정 적용 + 진행 상황 표시.

### Step 6: 수정 후 재검증

이슈가 있었던 스킬만 재실행하여 Before/After 비교:

```markdown
| 검증 스킬 | 수정 전 | 수정 후 |
|-----------|---------|---------|
| verify-<name> | X개 이슈 | PASS |
```

## 예외사항

1. **등록된 스킬이 없는 프로젝트** — 안내 메시지 표시 후 종료
2. **스킬 자체적 예외** — 각 verify 스킬의 Exceptions에 정의된 패턴은 이슈 아님
3. **verify-implementation 자체** — 실행 대상에 자기 자신 미포함
4. **manage-skills** — `verify-`로 시작하지 않으므로 실행 대상 아님

## 관련 파일

| File | Purpose |
|------|---------|
| `.claude/skills/manage-skills/SKILL.md` | 스킬 유지보수 |
| `CLAUDE.md` | 프로젝트 지침 |
