# PRD: Lake 4 — Skill Template Engine

## Summary

스킬 문서(.md)를 템플릿(.tmpl)에서 자동 생성하는 엔진을 완성하고 검증한다.
반복되는 boilerplate(ARGUMENTS 처리, Telemetry, Deep Consensus 등)를 partial로 분리하여
스킬 문서의 일관성을 보장하고 유지보수 비용을 줄인다.

## Problem

- 70+개 스킬 문서에 동일한 boilerplate가 복사/붙여넣기로 존재
- boilerplate 변경 시 모든 SKILL.md를 수동 편집해야 함
- 새 스킬 생성 시 필수 섹션 누락 발생

## Solution

### 템플릿 엔진 (`scripts/lib/skill-template.mjs`)

| 기능 | 구문 | 설명 |
|------|------|------|
| 변수 치환 | `{{VARIABLE}}` | context에서 값을 찾아 치환 |
| 조건부 블록 | `{{#if FLAG}}...{{/if}}` | FLAG가 truthy이면 포함, 아니면 제거 |
| Partial include | `{{> partial_name}}` | _templates/ 디렉토리에서 로드 |
| Frontmatter | `---\nkey: value\n---` | YAML-like 메타데이터 파싱 |

### 자동 context 변수

| 변수 | 소스 | 설명 |
|------|------|------|
| `SKILL_NAME` | frontmatter.name 또는 디렉토리명 | 스킬 식별자 |
| `SKILL_DESCRIPTION` | frontmatter.description | 스킬 설명 |
| `DEEP` | frontmatter.deep 또는 이름 패턴 추론 | deep 스킬 여부 (boolean) |

### 문서 생성기 (`scripts/gen-skill-docs.mjs`)

- `skills/` 하위의 `SKILL.md.tmpl` 파일을 스캔
- `skills/_templates/` 에서 partial을 로드
- frontmatter + 디렉토리명으로 context를 구성
- 렌더링 결과를 `SKILL.md`로 출력

## Deliverables

### 1. Unit Tests

- `tests/unit/skill-template.test.mjs`: 4개 exported 함수의 단위 테스트
  - `parseFrontmatter()`: 파싱, body 분리, quoted/boolean/multiline 값
  - `buildSkillTemplateContext()`: SKILL_NAME/DESCRIPTION/DEEP 자동 설정
  - `renderSkillTemplate()`: 변수 치환, #if, partial, 중첩, 에러 케이스
  - `loadTemplatePartials()`: 디렉토리 로드, 중첩 경로 alias, basename 충돌
- `tests/unit/gen-skill-docs.test.mjs`: 통합 생성 테스트
  - 단일/다중 스킬 생성, deep/non-deep 분기, write=false dry-run
  - _templates/ 내부 파일 무시, skillsDir 미지정 에러

### 2. .tmpl 변환 (2개 스킬)

- `skills/tfx-find/SKILL.md.tmpl`: `{{> base}}` partial + `{{SKILL_NAME}}` 변수
- `skills/tfx-index/SKILL.md.tmpl`: `{{> base}}` partial + `{{SKILL_NAME}}` 변수
- `gen-skill-docs` 실행으로 .tmpl에서 .md 재생성 검증

### 3. Partials

| 파일 | 용도 |
|------|------|
| `_templates/base.md` | ARGUMENTS 처리 + Telemetry 공통 블록 |
| `_templates/deep.md` | Deep Consensus Protocol 블록 |

## Constraints

- immutable 패턴, 파일 800줄 이하, 함수 50줄 이하
- 기존 SKILL.md의 내용/구조 보존
- npm test 전체 통과
- 기존 API (`parseFrontmatter`, `buildSkillTemplateContext`, `loadTemplatePartials`, `renderSkillTemplate`, `generateSkillDocs`) 호환 유지

## Success Criteria

- `node --test tests/unit/skill-template.test.mjs` 전체 통과
- `node --test tests/unit/gen-skill-docs.test.mjs` 전체 통과
- `node scripts/gen-skill-docs.mjs` 실행 시 변환된 스킬의 SKILL.md 정상 생성
- 생성된 SKILL.md가 기존 내용과 의미적으로 동일
