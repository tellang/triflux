# TODOS

## [Tier 2] 이중 적응형 시스템 통합

**What:** hook-adaptive-collector(파일 3-tier)와 Hub(SQLite adaptive_rules)이 독립적으로 동작하는 문제 해결. sync bridge 또는 단일 경로로 통합.

**Why:** 현재 두 시스템이 동일한 에러 패턴을 각자 따로 학습/저장. 일관성 없는 규칙이 쌓이고, 어느 쪽을 신뢰해야 하는지 모호함.

**Pros:** 단일 진실 소스(single source of truth) 확보. 규칙 관리 단순화. 세션 인식 복원(promoteRule) 시 하나의 파이프라인으로 통합 가능.

**Cons:** 마이그레이션 복잡도. 기존 파일 기반 규칙을 SQLite로 이관하거나, SQLite를 파일 기반으로 대체하는 결정 필요.

**Context:** eng review(2026-04-07)에서 outside voice가 발견: promote-penalties → addAdaptiveRule 경로와 hook-adaptive-collector 경로가 독립 동작. adaptive_rules 스키마 v2 확장(solution/context 컬럼) 완료로 SQLite 쪽이 더 풍부한 데이터 모델을 가짐. 체크포인트 `20260407-031135`에서 Tier 2로 기록됨.

**Depends on:** adaptive_rules 스키마 v2 (완료), promoteRule 프로덕션 연결 (완료)

## [Tier 3] Jujutsu(jj) VCS 백엔드 실험

**What:** Synapse v2에서 git worktree 대신 Jujutsu의 workspace + first-class conflict + operation log를 실험.

**Why:** Codex(GPT-5.4)가 office-hours에서 50% 도구로 jj를 추천. conflict를 first-class로 취급하면 rebase 실패가 구조적으로 불가능. operation log로 모든 ref 변경을 추적할 수 있어 synapse-registry와 자연스럽게 통합.

**Pros:** stale working copy 감지 네이티브. 다중 workspace 지원. conflict가 커밋으로 기록되어 나중에 해결 가능 (rebase 폭발 없음).

**Cons:** git 생태계 전체 교체 리스크. 사용자에게 jj 설치 요구. 원격 호환성 미지수. git interop 레이어 필요.

**Context:** Synapse v1 eng review(2026-04-11)에서 Approach C로 검토됨. Effort XL, Completeness 10/10. v1은 git 기반으로 진행, v2에서 jj 백엔드를 선택적 실험.

**Depends on:** Synapse v1 완료 (Layer 1-3)
