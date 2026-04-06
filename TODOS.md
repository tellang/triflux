# TODOS

## [Tier 2] 이중 적응형 시스템 통합

**What:** hook-adaptive-collector(파일 3-tier)와 Hub(SQLite adaptive_rules)이 독립적으로 동작하는 문제 해결. sync bridge 또는 단일 경로로 통합.

**Why:** 현재 두 시스템이 동일한 에러 패턴을 각자 따로 학습/저장. 일관성 없는 규칙이 쌓이고, 어느 쪽을 신뢰해야 하는지 모호함.

**Pros:** 단일 진실 소스(single source of truth) 확보. 규칙 관리 단순화. 세션 인식 복원(promoteRule) 시 하나의 파이프라인으로 통합 가능.

**Cons:** 마이그레이션 복잡도. 기존 파일 기반 규칙을 SQLite로 이관하거나, SQLite를 파일 기반으로 대체하는 결정 필요.

**Context:** eng review(2026-04-07)에서 outside voice가 발견: promote-penalties → addAdaptiveRule 경로와 hook-adaptive-collector 경로가 독립 동작. adaptive_rules 스키마 v2 확장(solution/context 컬럼) 완료로 SQLite 쪽이 더 풍부한 데이터 모델을 가짐. 체크포인트 `20260407-031135`에서 Tier 2로 기록됨.

**Depends on:** adaptive_rules 스키마 v2 (완료), promoteRule 프로덕션 연결 (완료)
