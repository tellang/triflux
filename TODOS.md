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

## [Tier 2] MCP hub Option C cleanup ownership 설계

**What:** Option C (parent hub + per-CLI MCP frontends) 우선 작업 시 cleanup ownership 명시. orphan node, psmux session, fsmonitor daemon, stale process cleanup 의 단일 owner 1개 고정.

**Why:** PR #200 (fsmonitor cleanup) / Issue #214 (다중 worktree 회귀) 가 보여줬듯 cleanup ownership 모호하면 race + 누락 발생. PRD B Option C 가 cleanup을 acknowledge 만 하고 메커니즘 미정의 → Codex outside voice도 동일 지적.

**Pros:** parent/frontend 양측에서 동일 cleanup 발화 시 race 방지. 'who owns orphan reaping' 명확. 디버깅 시 'which process killed it' 추적 가능.

**Cons:** ownership 결정이 토폴로지에 결합 → Option C 채택 후에만 의미 있음. 지금 결정하면 premature.

**Context:** PRD B (`.triflux/plans/mcp-singleton-redesign-prd.md`) eng review (2026-04-30) Issue 4 + Codex outside voice. PRD Migration Path Step 6+ 에서 적용. 현재 hub/server.mjs:1845-1891 의 orphan cleanup, 1893-1905 rate-limit eviction 이 single-owner 패턴 — Option C 분리 시 이 패턴 깨짐.

**Depends on:** PRD B Step 1 trace 완료 → Step 5 (registry compatibility) → Step 6 (Option C prototype). 이 셋 모두 선행.

## [Tier 2] Q1 benchmark harness real-client lifecycle 재현

**What:** PRD B Step 2 benchmark harness 가 합성 N×M×K 매트릭스 대신 실제 Claude/Codex/Gemini CLI 의 initialize/list/call 호출 주기를 재현해야 함. 합성은 실제 client 가 만들지 않는 워크로드 측정 위험.

**Why:** Codex outside voice (2026-04-30): "Many MCP clients initialize once, list tools once, then serialize or lightly parallelize calls. A synthetic K=8 session model could measure a workload no real Claude/Codex/Gemini lifecycle creates." 합성 측정은 hub topology 결정을 잘못된 데이터로 유도.

**Pros:** Q1 결정의 신뢰도 상승. fairness/saturation 의 진짜 원인을 측정. tools/list 가중치 같은 weak metric 함정 회피.

**Cons:** real CLI 구동 시 외부 모델 latency 노이즈 유입 (mock 가능 영역 줄어듦). 테스트 비용 증가.

**Context:** PRD B Migration Path Step 2 ("Build the Q1 benchmark harness"). 현재 PRD는 합성 N×M×K 스펙. Codex outside voice + 내부 review 모두 합성 < 실제 lifecycle 우선 권장. tools/list initialize 가중치 과다 우려와 동반 검토.

**Depends on:** PRD B Step 1 trace (실제 client lifecycle 데이터 확보) → Step 2 harness 설계.
