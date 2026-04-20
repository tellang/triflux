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

| # | Track | Crit | Regr | Score | Issues | Plan | 상태 근거 |
|---|---|---|---|---|---|---|---|
| 1 | **tfx-multi-nontty-reliability** | H | Y | **5** | [#114](https://github.com/tellang/triflux/issues/114) · [#116](https://github.com/tellang/triflux/issues/116) · [#117](https://github.com/tellang/triflux/issues/117) | [2026-04-19-issue-116-tfx-multi-investigate.md](.triflux/plans/2026-04-19-issue-116-tfx-multi-investigate.md) | investigate ✅ dual-lane (debugger+tracer). 2 sub-issue fix 완료 (로컬). 4 sub-issue + #114 fix 는 probe/사용자 게이트 대기 |
| 2 | **swarm-reliability** | H | N | 3 | [#115](https://github.com/tellang/triflux/issues/115) | [2026-04-19-issue-115-swarm-reliability.md](.triflux/plans/2026-04-19-issue-115-swarm-reliability.md) | ✅ **DONE** — Lane 1 (worker completion + F7) `1f339c4` + Lane 2 (recovery-store preservation) `2874074`. push 완료. 아카이브 후보 |
| 3 | **codex-approval-stall** | M | Y | 4 | [#66](https://github.com/tellang/triflux/issues/66) | — | v10.9.31 workaround만. 근본 미해결 (OPEN). upstream/environment 성격 — 단독 대응 |
| 4 | **phase3-step-e-wiring** | L | N | 1 | — | [phase3-step-e-plus-issue-113.md](.triflux/plans/phase3-step-e-plus-issue-113.md) | 실체는 skill-drift 20 todo 복원 + #113 CLAUDE.md 자동주입 차단. 소규모 wiring 아님 — 2 shard 격리 착수 필요 |

### 실행 순서 (병렬 OK)

- **#2 완료** → NOW 슬롯 하나 비었음. #1 fix 단계 진입 가능
- **#1 은 sub-issue 6건 분해** (#116-A~F). 상세는 `2026-04-19-issue-116-tfx-multi-investigate.md` 참조
- **#3 은 별도 lane** (upstream/env)
- **#4 는 codex/gemini 복귀 후** 병렬 가능. 현재 Claude native-only 유지 중

### #1 sub-issue 분해 (상세)

| 신규 Issue | 가설 | 우선순위 | fix 소유 | 상태 |
|---|---|---|---|---|
| **#116-A** codex kill before HANDOFF flush (timeout/flush) | H_A | P0 | triflux | probe 사용자 기계 필요 |
| **#116-B** `tfx multi status` false-negative | H_B | P0 | triflux | ✅ 로컬 fix `ce48491` |
| **#116-C** `tfx swarm` bg hang (lease) | H_D | P1 | triflux | Hub probe 선행 |
| **#116-D** workdir config/instruction delta | H_F | P2 | upstream | drift 감지만 |
| **#116-E** codex MCP approval drift regression | H_G | P2 | oh-my-codex | upstream |
| **#116-F** non-TTY dashboard UX | H_H | P3 | triflux | ✅ 로컬 fix `266aed2` |

기존 유지:
- **#114** in-process + bg 즉시 종료 — H_C → **deprecate 결정 (A: warn + auto-fallback to headless, 2026-04-19 session 5)**. 구현은 P1 headless opt-in 과 합침
- **#117** tmux/mux prompt injection race — H_E → P2 관찰 후 fix

**umbrella #116**: 위 sub-issue 링크 + 진행 상태 체크박스 (gh issue create 승인 대기)

---

## NEXT — 설계 대기

| Track | Crit | 대기 사유 |
|---|---|---|
| swarm-interactive-attach | M | Issue #115 (4). dashboard(단일 뷰) vs 인터랙티브(직접 pane 진입) 디자인 결정 필요. 사용자 인터뷰 후 진입 |
| conductor-completion-payload-wiring | M | **구현 완료 (2026-04-19 session 5)**: `hub/team/extract-completion-payload.mjs` pure helper (9 tests) + `conductor.mjs` 로컬/원격 exit(0) 경로 wiring. swarm-hypervisor F7 guard (validateWorkerCompletion) 와 end-to-end 연결 |
| prd-template-completion-protocol | L | Issue #115 PRD #5. **위치 결정 완료 (2026-04-19 session 5)**: B-hybrid — `swarm-hypervisor.mjs:433` buildSessionConfig 에서 `shard.prompt + COMPLETION_PROTOCOL_APPENDIX` 런타임 주입 + `docs/prd/_template.md` 에 placeholder 주석만. **구현 완료 (2026-04-20 session 6, [#125](https://github.com/tellang/triflux/issues/125))**: sentinel framing (`<<<TFX_COMPLETION_BEGIN/END>>>`) → `sentinel-capture.mjs` + `build-worker-prompt.mjs` 신규 helper, +30 unit tests, Codex 2 라운드 (R1 REQUEST_CHANGES → R2 APPROVE). overflow guard + standalone-line matching RESOLVED |

---

## LATER — carry-over / lint / docs

| Track | 상태 | 처리 |
|---|---|---|
| lint-debt | carry-over from v10.9.30/31/32 체크포인트 | 배치성 cleanup PR 한 번에 |
| .worktrees housekeeping | 부분 | `.gitignore` 이미 반영. 추가 정리 없음 |
| 체크포인트 slug 통합 | `~/.gstack/projects/triflux/` 와 `tellang-triflux/` 병존. gstack-slug 출력 = `tellang-triflux` | 일원화 검토 |

---

## DONE — 아카이브 후보 (체크포인트 11개 → 아카이브 이동 완료)

실체 완료된 체크포인트. 2026-04-19 세션에서 `~/.gstack/projects/tellang-triflux/checkpoints/archived/` 로 일괄 이동 완료.

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

새 아카이브 후보 (2026-04-19 세션 3):
- `20260419-153817-issue-115-fix-backlog.md` — #115 Lane 1+2 완료로 해소
- `20260419-171653-issue-115-lane12-done.md` — push `53f6771..2874074` 로 종결 가능 (후속 세션에서 판단)

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
6. **병렬 실행 금지 조건**: `tfx-multi/tfx-swarm/tfx-auto --parallel` 은 #116 umbrella 해결 전까지 Claude native-only (Agent tool / TeamCreate + isolation=worktree) 로 우회.

---

## 현재 결정 사항 (2026-04-19 session 3+)

- **NOW #2 swarm-reliability (#115) ✅ 완료** — Lane 1 (`1f339c4`) + Lane 2 (`2874074`). push `53f6771..2874074`. 전체 `npm test` green.
- **NOW #1 tfx-multi-nontty-reliability investigate 완료** — debugger + tracer dual-lane 보고서 + 통합 plan + sub-issue 분해 (#116-A~F). 2 fix 로컬 커밋 (#116-B `ce48491`, #116-F `266aed2`). 4 sub-issue 는 probe/사용자 게이트 대기.
- **사용자 경계선 수립** — Claude 단독 실행 가능 작업 / 주의 완료 후 확인 / 사용자·외부 검증 필수 3-tier 분리. codex/gemini CLI 직접 호출 금지 (#116 까지).
- **미push 로컬 commit 2개** — `ce48491` (#116-B), `266aed2` (#116-F). 사용자 게이트 push 대기.
- **sub-issue 생성 미승인** — gh issue create × 6 (#116-A~F). umbrella #116 body 업데이트 필요.
- **DONE 11개 체크포인트** `archived/` 이동 완료 (2026-04-19 세션 2).
- **DROPPED 8개 체크포인트** `archived/dropped/` 격리 완료 (2026-04-19 세션 2).
- **NOW #4 phase3-step-e** — plan 규모 확인 결과 "소규모 wiring" 아님. skill-drift 20 todo + #113 조사. 별도 세션 또는 Agent 위임 권장.
