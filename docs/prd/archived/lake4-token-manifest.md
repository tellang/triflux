# Lake 4: Skill Manifest 분리

## 목표

SKILL.md의 YAML 헤더(name, description, triggers)를 별도 skill.json으로 분리하여 토큰 절감.

## 요구사항

1. 각 스킬 디렉토리에 `skill.json` 생성 (자동 생성 스크립트)
   ```json
   {
     "name": "tfx-auto",
     "description": "통합 CLI 오케스트레이터...",
     "triggers": ["tfx-auto", "implement", "build"],
     "argument_hint": "[선택사항]"
   }
   ```
2. SKILL.md에서 YAML frontmatter 제거 (프롬프트 본문만 유지)
3. skill-template.mjs의 `parseSkillFrontmatter()` → `skill.json` 우선 로드하도록 수정
   - skill.json 있으면 JSON 파싱, 없으면 기존 YAML fallback
4. 기존 스킬 로더(bin/triflux.mjs)가 skill.json을 인식하도록 수정

## 영향 파일

- packages/triflux/skills/tfx-*/skill.json (40개 신규)
- packages/triflux/skills/tfx-*/SKILL.md (40개 수정 — frontmatter 제거)
- packages/core/scripts/lib/skill-template.mjs (수정)
- bin/triflux.mjs (수정)

## 제약

- 하위 호환: skill.json 없으면 기존 YAML 파싱 유지
- 기존 테스트 전부 통과
