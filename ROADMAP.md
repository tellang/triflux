# triflux ROADMAP

> 단일 장부. 체크포인트/Issue/plan이 여기저기 흩어진 것을 **치명도(Crit) × 회귀(Regr)** 로 하나의 우선순위로 정렬.

## Scoring Rubric

| 축 | 값 | 기준 |
|---|---|---|
| **Crit** (치명도 / 개발 속도 영향) | H | 병렬/허브/스웜 등 코어 인프라. 작업 손실 또는 완전 중단 유발 |
| | M | workaround 있음. 특정 경로만 느려짐 |
| | L | 편의성 / 디스크 / 네이밍 |
| **Regr** (회귀) | Y | 과거 해결/완료된 것이 다시 터졌거나 workaround만 있음 |
| | N | 처음 터진 신규 결함 |

우선순위 점수 = `Crit=H×3 + Crit=M×2 + Crit=L×1 + Regr=Y×+2 bonus`

---

## NOW — 즉시 착수 (Score 순, 동점 시 plan-readiness 순)

| # | Track | Crit | Regr | Score | Issues | Plan | 근거 |
|---|---|---|---|---|---|---|---|
| 1 | **tfx-multi-nontty-reliability** | H | Y | **5** | [#114](https://github.com/tellang/triflux/issues/114) · [#116](https://github.com/tellang/triflux/issues/116) · [#117](https://github.com/tellang/triflux/issues/117) | — (investigate 필요) | 백그라운드(non-TTY) `tfx multi/swarm` 6가지 경로 중 5개 실패, tmux 1개만 부분 성공. prompt 파일 미생성 + Enter 미전송 + gemini 텍스트 누락. 다른 사용자(majsoul-coach) 6단계 시도 후 폴백. 환경 조건부 회귀 |
| 2 | **swarm-reliability** | H | N | 3 | [#115](https://github.com/tellang/triflux/issues/115) | [2026-04-19-issue-115-swarm-reliability.md](.triflux/plans/2026-04-19-issue-115-swarm-reliability.md) | worker commit 누락 + cleanup 손실. 11분 작업 silent 손실. plan + PRD 준비 완료 |
| 3 | **codex-approval-stall** | M | Y | 4 | [#66](https://github.com/tellang/triflux/issues/66) | — | v10.9.31 workaround만. 근본 미해결 (OPEN). upstream/environment 성격 — 단독 대응 |
| 4 | **phase3-step-e-wiring** | L | N | 1 | — | [.triflux/plans/phase3-step-e-plus-issue-113.md](.triflux/plans/phase3-step-e-plus-issue-113.md) | chain-file/bridge instruction 배선 미완. auto-escalate 옵트인 경로 없음 |

### 실행 순서 (병렬 OK)

- **#1 과 #2 는 독립적** — 서로 다른 모듈 (`hub/team/` spawn 경로 vs `swarm-hypervisor.mjs` 로직). 병렬 가능
- **#2 먼저 착수 가능** (plan+PRD 완료). #1 은 investigate phase 선행 필요 (재현 조건 정제)
- **#3 은 별도 lane** (upstream/env)
- **#4 는 #1/#2 완료 후**

---

## NEXT — 설계 대기

| Track | Crit | 대기 사유 |
|---|---|---|
| swarm-interactive-attach | M | Issue #115 (4). dashboard(단일 뷰) vs 인터랙티브(직접 pane 진입) 디자인 결정 필요. 사용자 인터뷰 후 진입 |

---

## LATER — carry-over / lint / docs

| Track | 상태 | 처리 |
|---|---|---|
| lint-debt | carry-over from v10.9.30/31/32 체크포인트 | 배치성 cleanup PR 한 번에 |
| .worktrees housekeeping | 부분 | `.gitignore` 이미 반영. 추가 정리 없음 |

---

## DONE — 아카이브 후보 (체크포인트 11개)

실체 완료된 체크포인트. 다음 세션에서 `~/.gstack/projects/tellang-triflux/checkpoints/archived/` 로 일괄 이동 제안.

| # | 체크포인트 | 완료 근거 |
|---|---|---|
| 1 | audit-backlog-guard-fix | PR #71, v10.9.29 |
| 2 | audit-complete-cli-reference | PR #74, #75 |
| 8 | session-end-5-prs-merged | PR #86/#107/#100 |
| 9 | all-pending-done | — |
| 10 | session-wrap-pr86-107-mergeable | PR #100-104 |
| 11 | all-open-prs-merged-with-deep-review-fixes | PR #100-104 + base/cwd fix |
| 15 | v10932-followup-phase1-consolidation | PR #108/#110 + Phase 3~5 |
| 16 | v10.10.0-phase2-front-door-windows-fix | `ec72580` + Phase 3~5 |
| 17 | phase3-step-abc1-done-c2b-next | Step C/D/E/F 완료, v10.11.0 |
| 20 | phase4-implemented-readme-rewritten | v10.12.0, Phase 5 cleanup |
| 21 | native-bash-wrapper-hardening | `e7f1b12`, `09780b7` |

---

## DROPPED — 중복/Deprecated/Superseded (체크포인트 8개)

| # | 체크포인트 | 판정 | 흡수처 |
|---|---|---|---|
| 3 | deep-review-and-reverse-eng | Superseded | 새 이슈로 재정의 시 |
| 4 | tfx-hub-port-sync-pr82 | Deprecated | 완료됨 |
| 5 | opus47-macos72-recovery | Deprecated | PR 전부 MERGED/CLOSED |
| 6 | tfx-persist-phase1-done | Deprecated | `72f7076`, #90 CLOSED |
| 7 | tfx-persist-phase2-end | Duplicate of #4/#5 | 흡수 |
| 12 | v10.9.30-released | Duplicate lint | #14로 통합 |
| 14 | issues-batch-fix-v10931-v10932 | Duplicate | #13 + lint 이슈 |
| 19 | v10.11.0-released-phase3-done-113-fixed | Superseded | 실잔여는 #115로 이동 |

---

## 운영 규칙

1. **새 작업은 여기 먼저 등록**. Issue/plan은 이 표에서 링크로 파생.
2. **체크포인트는 세션 말미 스냅샷**. 작업 단위가 아님. 완료된 체크포인트는 주기적으로 DONE → archive 이동.
3. **3트랙 이상 동시 active 금지**. NOW 가 3 초과하면 NEXT로 밀어라. (오픈소스 1인 프로젝트 집중도 보호)
4. **치명도 기준은 "개발 속도 영향"**. 사용자 편의성·미감은 Crit=L. 병렬/허브/CI 영향은 Crit=H.
5. **회귀는 +2 보너스**. 한번 고친 것이 다시 터지면 근본 원인 미해결 신호.

---

## 현재 결정 사항 (2026-04-19)

- **NOW #2 swarm-reliability** 먼저 착수 (plan+PRD 준비 완료) → Lane 1/2 worktree swarm dispatch
- **NOW #1 tfx-multi-nontty-reliability** 는 investigate 플랜 작성 후 병렬 진입 — #116 umbrella 이슈가 #114/#117 포함
- **NEXT interactive-attach** 는 별도 인터뷰 턴에서 결정
- **DONE 11개 체크포인트** 아카이브 이동 완료 (2026-04-19 세션)
- **DROPPED 8개 체크포인트** `archived/dropped/` 격리 완료
