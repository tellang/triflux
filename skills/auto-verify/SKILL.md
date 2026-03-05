---
name: auto-verify
description: OMC 실행 모드 완료 후 자동으로 verify 스킬을 생성/업데이트하고, 통합 검증을 실행합니다. autopilot/team/ralph 완료 시점 또는 커밋 전에 사용.
argument-hint: "[선택사항: skip-manage | skip-verify | full]"
---

# auto-verify — OMC 연동 자동 검증

## 목적

OMC 워크플로우(autopilot, team, ralph, executor 등) 완료 후 **한 번의 호출로** 스킬 관리 + 검증을 자동 수행합니다:

1. `/manage-skills` 실행 → 세션 변경사항 기반 verify 스킬 자동 생성/업데이트
2. `/verify-implementation` 실행 → 생성된 스킬 포함 전체 검증
3. 이슈 발견 시 수정 제안 → 사용자 승인 → 재검증

## OMC 호환

```
[OMC 실행 모드]
  │
  ├─ /autopilot 완료 후 → /auto-verify
  ├─ /team team-verify 단계 → /auto-verify
  ├─ /ralph 각 이터레이션 후 → /auto-verify
  ├─ executor/deep-executor 완료 후 → /auto-verify
  └─ 커밋 전 (수동) → /auto-verify
```

**OMC team-verify 단계에서의 실행 순서:**

```
team-verify:
  1. /auto-verify              ← 프로젝트 고유 규칙 검증 (이 스킬)
  2. OMC verifier (sonnet)     ← 범용 완료성 검증
  3. OMC code-reviewer (opus)  ← 심층 코드 리뷰 (20+ 파일 시)
  4. ask_codex (security)      ← 보안 분석 (MCP, 필요 시)
```

## 워크플로우

### Step 1: 모드 감지 및 옵션 파싱

인수 확인:
- `skip-manage`: manage-skills 단계 건너뛰기 (이미 실행한 경우)
- `skip-verify`: verify-implementation 건너뛰기 (스킬 업데이트만)
- `full` 또는 인수 없음: 전체 실행 (기본값)

현재 OMC 상태 확인 (선택적):

```bash
# OMC 실행 모드 상태 확인 (있으면 컨텍스트로 활용)
cat .omc/state/team-state.json 2>/dev/null
cat .omc/state/autopilot-state.json 2>/dev/null
cat .omc/state/ralph-state.json 2>/dev/null
```

### Step 2: 변경사항 규모 평가

```bash
# 변경된 파일 수 확인
git diff HEAD --name-only | wc -l
git diff main...HEAD --name-only 2>/dev/null | wc -l
```

규모에 따른 동작 조정:
- **소규모 (1-5 파일)**: manage-skills + verify-implementation 순차 실행
- **중규모 (6-20 파일)**: manage-skills 실행 → verify-implementation 실행
- **대규모 (20+ 파일)**: manage-skills 실행 → verify-implementation 실행 후 OMC code-reviewer 권장

### Step 3: manage-skills 실행

`skip-manage`가 아닌 경우:

1. `/manage-skills` 스킬의 워크플로우를 실행
2. 새로 생성/업데이트된 스킬 목록 기록
3. CLAUDE.md Skills 테이블 동기화 확인

**표시:**

```markdown
## 스킬 관리 완료

- 분석된 파일: N개
- 새 스킬 생성: X개 (verify-<name1>, verify-<name2>)
- 기존 스킬 업데이트: Y개
- 면제: Z개

다음 단계: 통합 검증 실행...
```

### Step 4: verify-implementation 실행

`skip-verify`가 아닌 경우:

1. `/verify-implementation` 스킬의 워크플로우를 실행
2. Step 3에서 새로 생성된 스킬도 포함하여 전체 검증
3. 통합 리포트 생성

### Step 5: OMC 에이전트 연계 권장

검증 결과에 따라 OMC 에이전트 후속 작업을 권장:

```markdown
## 추가 권장 사항

| 조건 | 권장 액션 |
|------|----------|
| 보안 관련 이슈 발견 | `ask_codex`(security-reviewer, xhigh)로 심층 분석 |
| 아키텍처 위반 발견 | `ask_codex`(architect, high)로 구조 리뷰 |
| UI/프론트 이슈 발견 | `ask_gemini`(designer)로 UI 리뷰 |
| 20+ 파일 변경 | OMC `/code-review`로 전체 리뷰 |
| 이슈 없음 | 커밋 준비 완료 ✓ |
```

### Step 6: 최종 보고서

```markdown
## Auto-Verify 완료

### 스킬 관리
- 새 스킬: X개 | 업데이트: Y개

### 검증 결과
| 스킬 | 상태 | 이슈 |
|------|------|------|
| verify-<name> | PASS/FAIL | N개 |

### 전체: PASS ✓ / X개 이슈 발견
### 다음 단계: [커밋 준비 완료 | 이슈 수정 필요 | OMC 심층 리뷰 권장]
```

## 예외사항

1. **OMC 실행 모드 상태 파일 없음** — 정상 (독립 실행 지원)
2. **verify 스킬 0개** — manage-skills만 실행하여 최초 스킬 생성
3. **git 이력 없음** — 현재 파일 전체 스캔으로 fallback
4. **MCP 미사용 환경** — OMC 에이전트 권장만 표시, MCP 권장 생략

## 관련 파일

| File | Purpose |
|------|---------|
| `.claude/skills/manage-skills/SKILL.md` | 스킬 생성/관리 |
| `.claude/skills/verify-implementation/SKILL.md` | 통합 검증 실행 |
| `CLAUDE.md` | Skills 섹션 (자동 동기화 대상) |
