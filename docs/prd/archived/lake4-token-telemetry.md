# Lake 4: Telemetry 블록 표준화

## 목표

40개 스킬 SKILL.md에 반복되는 Telemetry 섹션을 공유 템플릿으로 추출하여 토큰 절감.

## 요구사항

1. `packages/triflux/skills/shared/telemetry-segment.md` 생성
   - 현재 각 스킬에 반복되는 Telemetry 블록을 하나의 템플릿으로 통합
   - `{{SKILL_NAME}}` 변수만 주입하면 동작하도록 설계
2. 기존 skill-template.mjs의 `expandTemplate()` 함수가 shared segment를 인라인 확장하도록 수정
   - `{{#include shared/telemetry-segment.md}}` 디렉티브 지원
3. tfx-auto, tfx-codex, tfx-plan, tfx-qa, tfx-research, tfx-review 6개 스킬에 우선 적용
   - 기존 Telemetry 블록을 `{{#include}}` 디렉티브로 교체

## 영향 파일

- packages/triflux/skills/shared/telemetry-segment.md (신규)
- packages/core/scripts/lib/skill-template.mjs (수정)
- packages/triflux/skills/tfx-*/SKILL.md (6개 수정)

## 제약

- 기존 테스트 전부 통과
- immutable 패턴 유지
- 파일 800줄 이하
