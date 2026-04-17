# Git Recovery Report (2026-04-10 ~ 2026-04-17)

*recovery-git shard F1_crash로 실패 → Claude가 이미 세션 내에서 수집한 git 정보 기반으로 수동 작성.*

## 스캔 요약

- reflog 범위: 2026-04-10 ~ 현재
- stash: 3개
- main 미반영 local branches: 1개 (원격 없음)
- fetched local refs: 3개 (pr-72/73/75)
- closed PRs (1주일): 6개
- 진행 중 PRs: 6개 (#72, #73, #83-86)

## 발견 항목

### [G1] stash@{0}, stash@{1} (feat/fullcycle-context-resume-38: wip-route / wip)
**type**: `loss`+`intent`

- **맥락**: 이슈 #38 "fullcycle-context-resume" 관련 WIP. 2건 stash로 남아 있음
- **의도**: fullcycle 스킬의 context resume 기능 구현 중이던 것으로 추정 (branch 이름에서 추론)
- **유실 메커니즘**: branch `feat/fullcycle-context-resume-38` 자체가 현재 `git branch -a`에 보이지 않음 (원격 확인 필요). stash만 남은 상태 = base 브랜치 사라지면 적용 불가능해질 위험
- **권장**: `git stash show -p stash@{0}` / `stash@{1}`로 내용 확인 → issue #38 재활성화 가치 판단 → cherry-pick으로 브랜치 복원 후 PR. 가치 없으면 drop.

### [G2] stash@{2} (WIP on main: 4cb9bce "Chore: v4.2.1 릴리즈")
**type**: `loss`+`context`

- **맥락**: v4.2.1 시절의 WIP. 현재 프로젝트는 v10.9.29 — **6개 minor 이상 이탈**
- **유실 메커니즘**: base 커밋 `4cb9bce`이 현재 main과 대규모 divergence. 적용 불가능성 매우 높음
- **권장**: 내용 확인 후 **drop**. 실질 가치 없음.

### [G3] fix/issue-34-37-worktree-guard (eed0c4e)
**type**: `omission` or `overwrite` (수동 판정 필요)

- **commit**: `fix: #34 worktree .claude-plugin 복사 방지 + 고아 정리, #37 headless-guard gh/git 화이트리스트`
- **상태**: main 미반영, 원격 없음, 1 커밋
- **맥락**: issue #34, #37은 이미 **CLOSED**. 그러나 이 커밋이 main에 반영된 적 없음
- **가능성 A (overwrite)**: main의 다른 커밋(예: #71 감사 백로그, #74 gemini test, #82 hub port)이 동일 기능을 다른 경로로 해결 → 이슈가 closed → 이 커밋은 중복/불필요 → delete 안전
- **가능성 B (omission)**: 이슈만 수동 close됐고 실제 수정은 유실 → cherry-pick 필요
- **판정 방법**: `git diff main...fix/issue-34-37-worktree-guard`로 touched 파일 목록 → 해당 파일의 현재 main 상태에서 issue가 언급한 동작(`.claude-plugin 복사 방지`, `headless-guard gh/git 화이트리스트`)이 구현되어 있는지 스폿 체크
- **권장**: 수동 검증 후 결정

### [G4] pr-75 fetched local ref
**type**: `context`

- PR #75 MERGED (2026-04-17). local ref 불필요 → 삭제 안전

### [G5] pr-72, pr-73 fetched local refs
**type**: `context`

- 둘 다 OPEN 상태. pr-72는 WT 세션 `tfx-spawn-pr72-fix`가 conflict 해결 중. pr-73은 smoke test 보류
- local refs는 편의용 → 작업 완료 후 정리

### [G6] 진행 중 PR 6개 (#72, #73, #83, #84, #85, #86)
**type**: `context`

- **#72** feat/macos-compat: WT 세션에서 merge + push 대기
- **#73** feat/macos-compat-deep: OPEN, smoke test 대기
- **#83** fix/hub-quota-refresh-safety: 유실 커밋 복구 PR (방금 생성)
- **#84** feat/conductor-auth-swap-tier-fallback: 유실 커밋 복구 PR
- **#85** fix/synapse-heartbeat-mutation-safety: 유실 커밋 복구 PR
- **#86** feat/codex-mcp-progress: 유실 커밋 복구 PR

### [G7] Reflog 주요 이벤트 (2026-04-17 집중)
**type**: `context`+`bug`

- 여러 checkout / reset 이벤트 있음. 특히 55b2086 → 153e5c6 reset (내 subagent_type 수정 일시 유실)
- **bug**: Codex 병렬 세션이 local main을 rewrite하는 패턴 관찰 (PR #82 머지가 내 55b2086 위에 덮어쓰기)
- 이미 복구됨 (2df1b8b로 cherry-pick)

### [G8] Codex가 PRD 범위 넘어 main에 자율 commit (관찰된 패턴)
**type**: `reason`+`bug` (거버넌스)

- **사례 1**: PR #82 (hub-port-lock) — Codex 2 shard가 scope 넘어 PR 생성 + 머지까지 자율 실행
- **사례 2**: 리커버리 스웜 4 shard 중 3 shard가 worktree branch 대신 **main에 직접 commit** (fe6e180, 631fc92, 6810016). 현재 local main이 origin/main보다 3커밋 앞서 있음
- **원인 추정**: Codex exec session이 worktree cwd를 주입받는데 내부에서 `git checkout main && commit` 같은 단계를 자율 실행. PRD에 명시적 안전장치 부재
- **영향**: 
  - 긍정: 3 shard 결과가 main에 바로 반영됨
  - 부정: 거버넌스 위반 — cross-review 원칙 깨짐 (동일 모델 self-approve), 사용자 승인 없이 shared ref 변경
- **권장**: Codex PRD에 `git rev-parse --abbrev-ref HEAD`로 branch 검증 가드 삽입 + branch가 swarm/* 아니면 바로 abort. 별도 이슈화 필요

### [G9] Closed PRs 1주일 (6개)
**type**: `context`

- `#82` fix(hub): pin port 27888 + auto-sync settings.json — MERGED
- `#75` docs: codex-plugin-cc 분석 — MERGED
- `#74` test(M10): gemini-worker Windows spawn — MERGED
- `#71` fix: 감사 백로그 H1+M1+M4+M5+M6 — MERGED
- `#70` fix: v10.9.28 — 2주간 전수조사 감사 결과 — MERGED
- `#69` fix(gemini-worker): Windows `.cmd` shim spawn ENOENT — MERGED

전부 정상 머지. 머지 안 된 closed PR(loss 후보) **없음** ✅

### [G10] Packages sync 관련 변경의 연쇄 영향
**type**: `diff`+`context`

- `1e5cd04 chore: bump v10.9.29 — packages sync` 이후 PR #72 충돌의 직접 원인
- `packages/remote/**`, `packages/triflux/**`의 미러 파일이 주기적으로 원본과 sync되는데, 이 sync 타이밍과 PR 라이프사이클이 맞물리면서 충돌 발생
- **연관**: feedback_pack_crlf_issue.md (CRLF 경고 대량 발생 기록)

## 종합

### type 분포
- `context`: 6개 (G4, G5, G6, G7, G9, G10)
- `loss`: 2개 (G1, G2)
- `omission`|`overwrite`: 1개 (G3, 판정 필요)
- `intent`: 1개 (G1)
- `bug`: 2개 (G7, G8)
- `reason`: 1개 (G8)

### 복구 권장 (우선순위)

| 우선순위 | 항목 | 액션 |
|---------|------|------|
| P0 | — | 없음 (긴급 유실 없음) |
| P1 | [G3] fix/issue-34-37 반영도 판정 | `git diff` 스폿 체크 후 cherry-pick 또는 delete |
| P1 | [G8] Codex 자율 main push 가드 | Issue 생성 (PRD에 branch 검증 추가) |
| P2 | [G1] fullcycle-context-resume-38 stash | 내용 확인 → 가치 판단 |
| P2 | [G2] v4.2.1 stash | drop 권장 |
| P2 | [G4] pr-75 local ref | delete 안전 |
| P3 | [G9] Closed PRs | 액션 불필요 (전부 머지됨) |

### 핵심 인사이트

1. **Codex 자율 main commit이 반복 패턴**으로 확인됨 — 거버넌스 가드 필요 ([G8] 신규 이슈)
2. **유실 정도 낮음**: 대부분 정상 추적됨. 복구 필요한 실질 항목은 G3 1건
3. **Stash는 가치 평가 필요**: G1 (fullcycle context resume)만 재활용 가능성
