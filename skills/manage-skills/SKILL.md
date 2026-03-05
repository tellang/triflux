---
name: manage-skills
description: 세션 변경사항을 분석하여 검증 스킬 누락을 탐지합니다. 기존 스킬을 동적으로 탐색하고, 새 스킬을 생성하거나 기존 스킬을 업데이트한 뒤 CLAUDE.md를 관리합니다.
disable-model-invocation: true
argument-hint: "[선택사항: 특정 스킬 이름 또는 집중할 영역]"
---

# manage-skills — 세션 기반 스킬 유지보수

## 목적

현재 세션에서 변경된 내용을 분석하여 검증 스킬의 드리프트를 탐지하고 수정합니다:

1. **커버리지 누락** — 어떤 verify 스킬에서도 참조하지 않는 변경된 파일
2. **유효하지 않은 참조** — 삭제되거나 이동된 파일을 참조하는 스킬
3. **누락된 검사** — 기존 검사에서 다루지 않는 새로운 패턴/규칙
4. **오래된 값** — 더 이상 일치하지 않는 설정값 또는 탐지 명령어

## OMC 호환

이 스킬은 OMC(oh-my-claudecode) 에이전트 시스템과 **보완적**으로 작동합니다:

- **OMC verifier**: 세션 단위 일회성 검증 (매번 코드 분석)
- **verify 스킬**: 프로젝트별 영구 규칙 기반 검증 (누적 지식)
- OMC `code-reviewer`, `quality-reviewer` 등은 범용 리뷰 → verify 스킬은 **프로젝트 고유 규칙** 검증
- 두 시스템을 함께 사용 시: verify 스킬로 프로젝트 규칙 검증 → OMC verifier로 일반 품질 검증

**MCP-First 환경 적용**: verify 스킬의 리포트를 Codex/Gemini CLI에 전달하여 심층 분석 위임 가능.

## 실행 시점

- 새로운 패턴이나 규칙을 도입하는 기능을 구현한 후
- 기존 verify 스킬을 수정하고 일관성을 점검하고 싶을 때
- PR 전에 verify 스킬이 변경된 영역을 커버하는지 확인할 때
- 검증 실행 시 예상했던 이슈를 놓쳤을 때
- 주기적으로 스킬을 코드베이스 변화에 맞춰 정렬할 때

## 등록된 검증 스킬

현재 프로젝트에 등록된 검증 스킬 목록입니다. 새 스킬 생성/삭제 시 이 목록을 업데이트합니다.

(아직 등록된 검증 스킬이 없습니다)

<!-- 스킬이 추가되면 아래 형식으로 등록:
| 스킬 | 설명 | 커버 파일 패턴 |
|------|------|---------------|
| `verify-example` | 예시 검증 | `src/example/**/*.ts` |
-->

## 워크플로우

### Step 1: 세션 변경사항 분석

현재 세션에서 변경된 모든 파일을 수집합니다:

```bash
# 커밋되지 않은 변경사항
git diff HEAD --name-only

# 현재 브랜치의 커밋 (main에서 분기된 경우)
git log --oneline main..HEAD 2>/dev/null

# main에서 분기된 이후의 모든 변경사항
git diff main...HEAD --name-only 2>/dev/null
```

중복을 제거한 목록으로 합칩니다. 선택적 인수로 스킬 이름이나 영역이 지정된 경우 관련 파일만 필터링합니다.

**표시:** 최상위 디렉토리(첫 1-2 경로 세그먼트) 기준으로 파일을 그룹화합니다:

```markdown
## 세션 변경사항 감지

**이 세션에서 N개 파일 변경됨:**

| 디렉토리 | 파일 |
|----------|------|
| src/components | `Button.tsx`, `Modal.tsx` |
| src/server | `router.ts`, `handler.ts` |
```

### Step 2: 등록된 스킬과 변경 파일 매핑

**등록된 검증 스킬** 섹션에 나열된 스킬을 참조하여 파일-스킬 매핑을 구축합니다.

등록된 스킬이 0개인 경우, Step 4로 바로 이동합니다. 모든 변경 파일이 "UNCOVERED"로 처리됩니다.

등록된 스킬이 1개 이상인 경우, 각 스킬의 SKILL.md를 읽고 Related Files, Workflow 섹션에서 파일 경로 패턴을 추출합니다.

```markdown
### 파일 → 스킬 매핑

| 스킬 | 트리거 파일 | 액션 |
|------|-----------|------|
| verify-api | `router.ts`, `handler.ts` | CHECK |
| (스킬 없음) | `package.json` | UNCOVERED |
```

### Step 3: 커버리지 갭 분석

영향받은 각 스킬에 대해 SKILL.md를 읽고 점검합니다:

1. **누락된 파일 참조** — 관련 변경 파일이 Related Files에 없는 경우
2. **오래된 탐지 명령어** — grep/glob 패턴이 현재 파일 구조와 일치하는지
3. **커버되지 않은 새 패턴** — 스킬이 검사하지 않는 새로운 규칙
4. **삭제된 파일의 잔여 참조** — 존재하지 않는 파일 참조
5. **변경된 값** — 특정 값(식별자, 설정 키)이 수정되었는지

### Step 4: CREATE vs UPDATE 결정

```
커버되지 않은 각 파일 그룹에 대해:
    IF 기존 스킬의 도메인과 관련:
        → UPDATE (커버리지 확장)
    ELIF 3개+ 관련 파일이 공통 패턴 공유:
        → CREATE (새 verify 스킬)
    ELSE:
        → 면제 (스킬 불필요)
```

`AskUserQuestion`으로 사용자에게 확인합니다.

### Step 5: 기존 스킬 업데이트

**규칙:**
- 추가/수정만 — 작동하는 기존 검사는 절대 제거하지 않음
- Related Files 테이블에 새 파일 경로 추가
- 새 탐지 명령어 추가
- 삭제 확인된 파일의 참조 제거
- 변경된 값 업데이트

### Step 6: 새 스킬 생성

**반드시 사용자에게 스킬 이름 확인 후 생성.**

**이름 규칙:**
- `verify-`로 시작 (예: `verify-auth`, `verify-api`)
- kebab-case 사용

**필수 섹션:**
- Frontmatter: name, description
- **Purpose** — 2-5개 검증 카테고리
- **When to Run** — 3-5개 트리거 조건
- **Related Files** — 실제 파일 경로 테이블 (`ls`로 검증)
- **Workflow** — 검사 단계 (도구, 패턴, PASS/FAIL 기준, 수정 방법)
- **Output Format** — 마크다운 테이블
- **Exceptions** — 2-3개 면제 케이스

**연관 파일 자동 업데이트:**
1. `manage-skills/SKILL.md` — 등록된 검증 스킬 테이블
2. `verify-implementation/SKILL.md` — 실행 대상 스킬 테이블
3. `CLAUDE.md` — Skills 섹션 테이블

### Step 7: 검증

1. 수정된 SKILL.md 다시 읽어 마크다운 형식 확인
2. Related Files 경로 존재 확인: `ls <path> 2>/dev/null || echo "MISSING"`
3. 탐지 명령어 드라이런으로 문법 검증
4. 등록 테이블 동기화 확인

### Step 8: 요약 보고서

```markdown
## 세션 스킬 유지보수 보고서

### 분석된 변경 파일: N개
### 업데이트된 스킬: X개
### 생성된 스킬: Y개
### 업데이트된 연관 파일: [목록]
### 미커버 변경사항: [면제 사유]
```

## 관련 파일

| File | Purpose |
|------|---------|
| `.claude/skills/verify-implementation/SKILL.md` | 통합 검증 스킬 |
| `.claude/skills/manage-skills/SKILL.md` | 이 파일 |
| `CLAUDE.md` | 프로젝트 지침 (Skills 섹션) |

## 예외사항

다음은 **문제가 아닙니다**:

1. **Lock 파일 및 생성된 파일** — `package-lock.json`, `yarn.lock`, 빌드 출력물
2. **일회성 설정 변경** — 버전 범프, 린터 설정 사소한 변경
3. **문서 파일** — `README.md`, `CHANGELOG.md`, `LICENSE`
4. **테스트 픽스처** — `fixtures/`, `test-data/` 디렉토리
5. **CLAUDE.md 자체** — 문서 업데이트이며 코드 패턴이 아님
6. **벤더/서드파티 코드** — `vendor/`, `node_modules/`
7. **CI/CD 설정** — `.github/`, `Dockerfile`
8. **AI 설정 파일** — `.claude/`, `.omc/`, `.codex/`, `.gemini/` (OMC 호환)
