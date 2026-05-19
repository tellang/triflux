# Issue #281 — auto router 코드 변경 자동 swarm dispatch (#87 격상)

> Source: https://github.com/tellang/triflux/issues/281
> Label: routing, tier:high
> Audit origin: tfx-harness 라우팅 점검 (2026-05-19) D2 (High severity)
> SSOT 갭 라인: `.claude/rules/tfx-execution-skill-map.md` L44/L49/L64
> Closes: #87, #281
> Worktree branch (per shard): `feat/issue-281-shard-{a,b,c}-*`

## 목표

`tfx-auto` 가 staged + unstaged + untracked 변경 파일 카운트로 코드 변경 자동 감지 → 2+ 태스크 + 코드 변경 ≥ 1건 시 자동 swarm dispatch 로 escalate. 사용자 명시 `--parallel N` override 시 warning 후 사용자 결정 존중.

## 회귀 테스트 3 case (필수 — Issue #281 body 명시)

| case | 입력 | 기대 dispatch |
|------|------|--------------|
| 1 | 코드 변경 0건 + 2+ 태스크 | multi |
| 2 | 코드 변경 ≥ 1건 + 2+ 태스크 | swarm 자동 escalate |
| 3 | `--parallel N` 명시 + 코드 변경 | warning + 사용자 결정 존중 |

## Shard 분할

| shard | 범위 | 의존 | worktree branch |
|-------|------|------|-----------------|
| A | `hub/lib/staged-file-detect.mjs` (helper) + `tests/unit/staged-file-detect.test.mjs` | — | `feat/issue-281-shard-a-staged-file-detect` |
| B | `hub/lib/tfx-route-args.mjs` + `bin/triflux.mjs` + `scripts/tfx-route.sh` 자동 escalate 로직 | A | `feat/issue-281-shard-b-router-escalate` |
| C | `tests/integration/tfx-auto-routing.test.mjs` (3 case) + SSOT docs (`.claude/rules/tfx-{routing,execution-skill-map}.md`) + 4-layer mirror 검증 | A, B | `feat/issue-281-shard-c-integration-ssot-mirror` |

## 4-layer mirror 정책 (`.claude/rules/tfx-mirror-policy.md`)

| 레이어 | 대상 | 방식 |
|--------|------|------|
| root | 위 모든 파일 (helper / route-args / triflux.mjs / tfx-route.sh / docs) | direct |
| `packages/core/hub/lib/` | `staged-file-detect.mjs`, `tfx-route-args.mjs` | byte-identical cp |
| `packages/triflux/hub/lib/`, `bin/`, `scripts/` | root 파일 mirror | byte-identical cp |
| `packages/remote/` | 영향 없음 (auto router 는 `@triflux/core` 의존) | mirror 제외 |

검증: `diff -q` exit 0 + `npm pack --dry-run` size ~1MB

## 위치 매핑 (확정 — 2026-05-19 /tfx-find 결과)

| 분류 | 파일 | 비고 |
|------|------|------|
| 수정 | `bin/triflux.mjs` (7272 lines) | tfx-auto JS 라우터 표면 |
| 수정 | `hub/lib/tfx-route-args.mjs` | `--parallel` 인자 파싱 핵심 진입점 |
| 수정 | `scripts/tfx-route.sh` (L789 `auto_reroute()`, L1209 `auto)` 분기) | shell 라우팅 layer |
| 신규 | `hub/lib/staged-file-detect.mjs` | git diff/ls-files 카운트 helper |
| 신규 | `tests/integration/tfx-auto-routing.test.mjs` | 3 case 회귀 가드 |
| 수정 | `.claude/rules/tfx-execution-skill-map.md` L44/L49/L64 | MANDATORY 라인 → 자동 dispatch 정식화 톤 |

참조 모델 (기존 git 감지 로직 위치): `hub/team/worktree-lifecycle.mjs`, `hub/team/swarm-hypervisor.mjs`, `hub/team/codex-review.mjs`, `hub/team/headless.mjs`, `scripts/lib/handoff.mjs`

## Cross-review (`CLAUDE.md` 교차 검증)

- Claude 작성 부분 → Codex 리뷰
- Codex 작성 부분 → Claude 리뷰
- 동일 모델 self-approve 금지
- git commit 전 미검증 파일 감지 시 nudge

## 영향

- cwd 공유 race 사고 회피 (PR #72 패턴 재발 방지)
- SSOT-구현 정합 회복 (현재 L44/L49/L64 갭 closed)
- 사용자가 매번 명시 플래그 안 적어도 안전
- Issue #87 + #281 close
- v10.23.1 patch 또는 v10.24.0 release 진입 가능 (사용자 결정)

## CLI 정책

본 작업은 라우터 핵심 로직 변경 = code-touching lane → Codex default (`.claude/rules/tfx-routing.md` "CLI 우선순위 정책 — default = Codex"). 진입 명령:

```
/tfx-auto --parallel swarm --isolation worktree --cli codex --max-iterations 0 \
  "Issue #281 — PRD: .triflux/plans/issue-281-auto-router-swarm-dispatch.md"
```
