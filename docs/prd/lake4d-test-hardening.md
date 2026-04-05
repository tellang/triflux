# PRD: Lake 4d — Context Monitor + Skill Templates 테스트 강화

## Summary

Lake 4a/4b 단위 테스트는 통과하지만, 경계값/에지케이스/통합 시나리오 커버리지가 부족하다.
프로덕션 안정성을 위해 테스트를 강화한다.

## Problem

- Context Monitor: 4개 테스트 (111줄) — 기본 시나리오만 커버
- Skill Templates: gen-skill-docs 테스트 104줄 — 해피 패스 위주
- 경계값, 에러 복구, 통합 시나리오 미검증

## Solution

### Context Monitor 추가 테스트

| 테스트 | 설명 |
|--------|------|
| 임계값 경계 | 59.9%→ok, 60.0%→info, 79.9%→info, 80.0%→warn, 89.9%→warn, 90.0%→critical |
| 제로/음수 토큰 | estimateTokens(0), estimateTokens(-1), estimateTokens("") |
| 대형 페이로드 | MAX_CAPTURE_BYTES(256KB) 경계 테스트 |
| malformed usage | parseUsageFromPayload({}) / null / undefined |
| 포맷 엣지 | formatTokenCount(0), formatTokenCount(999999999) |
| 모니터 라이프사이클 | 생성→기록→스냅샷→리포트→close 전체 흐름 |

### Skill Templates 추가 테스트

| 테스트 | 설명 |
|--------|------|
| 순환 partial 감지 | A→B→A 순환 include 시 에러 |
| 빈 frontmatter | `---\n---\n` 파싱 처리 |
| 중복 키 | frontmatter에 동일 키 2회 시 동작 |
| 특수문자 변수 | `{{FOO.BAR}}`, `{{FOO-BAR}}` |
| 중첩 조건 | `{{#if A}}{{#if B}}...{{/if}}{{/if}}` |
| 대형 템플릿 | 1000줄 이상 템플릿 렌더링 |
| gen-skill-docs 에러 | 존재하지 않는 partial 참조 시 에러 처리 |

### 통합 테스트

| 테스트 | 설명 |
|--------|------|
| gen-skill-docs 파이프라인 | 실제 _templates/ + 변환된 스킬로 전체 생성→비교 |
| Context Monitor 뷰 빌드 | buildContextUsageView 출력 형식 + 임계값 분류 연동 |

## Deliverables

- `tests/unit/context-monitor.test.mjs` 확장 (6+ 테스트 추가)
- `scripts/__tests__/skill-template.test.mjs` 확장 (7+ 테스트 추가)
- `tests/integration/lake4-integration.test.mjs` 신규 (2+ 테스트)

## Constraints

- 기존 테스트 수정 금지 (추가만)
- npm test 전체 통과
- 테스트 파일 각 800줄 이하

## Success Criteria

- 추가된 테스트 전부 통과
- npm test 전체 통과 (기존 424+ 테스트 포함)
