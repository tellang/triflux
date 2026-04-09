# Lake 4: 공유 세그먼트 라이브러리

## 목표

SKILL.md에서 반복되는 공통 섹션(ARGUMENTS 처리, MANDATORY RULES, 에러 핸들링)을 공유 파일로 추출.

## 요구사항

1. `packages/triflux/skills/shared/arguments-processing.md` 생성
   - "이 스킬이 ARGUMENTS: <값>과 함께 호출되면..." 표준 블록
2. `packages/triflux/skills/shared/mandatory-rules.md` 생성
   - headless-guard, tfx-route 경유, cross-review 규칙 등 공통 규칙
3. skill-template.mjs의 `expandTemplate()`에서 `{{#include shared/*.md}}` 지원
   - 이미 Lake 4 telemetry PRD에서 include 디렉티브를 추가하므로, 같은 메커니즘 활용
4. 8개 이상의 스킬에서 중복 블록을 `{{#include}}` 로 교체

## 영향 파일

- packages/triflux/skills/shared/arguments-processing.md (신규)
- packages/triflux/skills/shared/mandatory-rules.md (신규)
- packages/core/scripts/lib/skill-template.mjs (수정 — include 확장)
- packages/triflux/skills/tfx-*/SKILL.md (8개+ 수정)

## 제약

- include 깊이 1단계 (재귀 금지)
- 기존 테스트 전부 통과
