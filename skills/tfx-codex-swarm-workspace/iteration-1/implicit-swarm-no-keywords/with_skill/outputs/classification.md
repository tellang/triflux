# tfx-codex-swarm — Step 3: 태스크 분류 및 OMX 스킬 매핑

> 사용자 요청: "이 PRD 3개 파일을 각각 독립적으로 코덱스한테 맡겨서 병렬로 구현해줘"
> 입력 파일: docs/prd/auth-refactor.md, docs/prd/api-v2.md, docs/prd/cache-layer.md

## 분류 결과

| # | 파일 | 슬러그 | 유형 | 판별 근거 | OMX 스킬 |
|---|------|--------|------|-----------|----------|
| 1 | docs/prd/auth-refactor.md | auth-refactor | 리팩터링 (refactor) | 파일명에 "refactor" 포함 → 리팩터링 자동 분류 | `$plan` → `$ralph` |
| 2 | docs/prd/api-v2.md | api-v2 | 구현 (implement) | 파일명 "api-v2" → 새 API 버전 구현, 기본 구현 분류 | `$plan` → `$autopilot` |
| 3 | docs/prd/cache-layer.md | cache-layer | 구현 (implement) | 파일명 "cache-layer" → 새 레이어 추가, 기본 구현 분류 | `$plan` → `$autopilot` |

## 분류 로직

### auth-refactor → 리팩터링
- 파일명 키워드: `refactor` 매치
- SKILL.md 분류 테이블: "리팩터", "refactor", "정리", "개선" → 리팩터링
- OMX 스킬: `$plan` → `$ralph` (계획 후 완료까지 반복 실행)
- 근거: 리팩터링은 기존 코드 구조 변경이므로 ralph의 반복 검증이 적합

### api-v2 → 구현
- 파일명 키워드: `api-v2` → 명시적 리팩터/조사 키워드 없음, 새 버전 = 구현
- SKILL.md 분류 테이블: "구현", "implement", "추가", "변경" → 구현
- OMX 스킬: `$plan` → `$autopilot` (계획 후 자율 구현)
- 근거: 새 API 엔드포인트/버전 추가는 전형적 구현 태스크

### cache-layer → 구현
- 파일명 키워드: `cache-layer` → 새 레이어 추가
- SKILL.md 분류 테이블: "구현", "implement", "추가" → 구현
- OMX 스킬: `$plan` → `$autopilot` (계획 후 자율 구현)
- 근거: 캐시 레이어는 신규 아키텍처 컴포넌트 추가

## 참고

- PRD 파일이 실제 존재하지 않으므로 **파일명 기반** 분류만 수행
- 실제 실행 시 파일 내용을 읽어 키워드 복잡도, 영향 파일 수 등을 추가 판별
- 사용자가 스킬을 명시하지 않았으므로 자동 분류 적용
