# Worker Signaling Consolidation PRD

date: 2026-04-25
status: draft (단일 세션 부적절 — outline + 1차 분석. 실제 구현은 swarm 또는 multi-step)
related-checkpoint: `~/.gstack/projects/tellang-triflux/checkpoints/20260425-191243-v10150-shipped-remaining-meta-f-and-worker-signaling.md`

## 1. 통합 대상 (4 family)

| # | Source | Status | 증상 | 회귀 매핑 |
|---|--------|--------|------|----------|
| 1 | issue [#176](https://github.com/tellang/triflux/issues/176) | open | `tfx-route.sh --async --job-status` 가 stdout.log 가 별도 경로에 쓰이는 동안 조기 "failed" 반환 | — |
| 2 | 메타 B | closed [#115](https://github.com/tellang/triflux/issues/115) (PR #184 fix landed, regression 위험 잔존) | F7 worker did not commit — worker 죽었는데 synapse 에 commit 안 됨 → silent loss | #115 |
| 3 | 메타 E | open [#190](https://github.com/tellang/triflux/issues/190) | `tfx swarm list` 가 synapse-registry 만 조회 → inflight swarm-logs run 누락 → 거짓 보고 | (신규) |
| 4 | PR [#185](https://github.com/tellang/triflux/pull/185) silent-flush guard | merged | codex 0.124.0 silent-success 회귀 detect + exec fallback | (신규) |

이 네 family 는 모두 동일 **ground truth 부재** 패턴. worker / job 의 상태를 단일 채널 (synapse only / stdout only / job-status only) 으로만 집계하다가 각자 다른 시점에 silent loss 발생.

## 2. Ground Truth Spec — 4-channel principle

worker / job 상태는 다음 4 채널의 합집합으로만 결정한다. 단일 채널 의존 금지.

| Channel | Source | 의미 | 누락 시 증상 |
|---------|--------|------|------------|
| **process state** | OS pid alive + parent reap | worker process 살아있는가 | 메타 B (#115) — worker 죽음 미감지 |
| **heartbeat** | `swarm-logs/run-*/swarm-events.jsonl` mtime | 진행 중 token 발화 | 메타 E (#190) — list 가 누락 → stale 미표시 |
| **commit evidence** | git tree / synapse-registry record | 작업 산출물 commit 됨 | 메타 B (#115) — silent loss |
| **stdout 4-channel** | task output file + stdout.log + stderr.log + status.log | 명시적 lifecycle event | issue #176 + PR #185 — silent flush / 조기 failed |

**합집합 결정 규칙**:

```
status = match (process, heartbeat, commit, stdout):
  alive ∧ recent-hb ∧ -            ∧ -            → "active"
  alive ∧ stale-hb  ∧ -            ∧ -            → "stalled"
  dead  ∧ -         ∧ committed    ∧ "complete"   → "completed"
  dead  ∧ -         ∧ committed    ∧ silent       → "silent-success" (PR #185 family)
  dead  ∧ -         ∧ -            ∧ -            → "silent-loss"   (메타 B family)
  dead  ∧ -         ∧ -            ∧ "failed"     → "failed"
  -     ∧ -         ∧ -            ∧ "failed-early" → "false-failed"  (issue #176 family)
```

| Reporter | 통합 후 동작 |
|----------|-------------|
| `tfx swarm list` | synapse-registry ∪ swarm-logs 합집합 (메타 E 해소) |
| `tfx-route.sh --job-status` | stdout 채널 + 다른 3채널 cross-check 후 보고 (#176 해소) |
| codex MCP wrapper | silent-flush detect → exec fallback (PR #185 이미 landed) |
| swarm orchestrator | F7 worker did not commit → process state + commit evidence cross-check (메타 B 재발 방지) |

## 3. Acceptance Criteria

각 family 별 통합 후 만족해야 할 조건.

| # | 조건 | 검증 방법 |
|---|------|---------|
| AC1 | issue #176 reproducer (stdout.log 별도 경로 + 조기 종료) 가 더 이상 "failed" 로 보고되지 않음 | tfx-route 통합 테스트 추가 (state machine 진입/종료 시뮬) |
| AC2 | 메타 B 재현 (worker SIGKILL → synapse 에 commit 안 됨) 시 "silent-loss" 로 명시 분류 + alert | swarm reliability 통합 테스트 (kill -9 worker 후 list / status 검증) |
| AC3 | 메타 E 재현 (inflight run + synapse 미등록) 시 list 가 "stale" 표시 (제외 X, 보고) | 단위 테스트 + integration |
| AC4 | PR #185 silent-flush guard 가 cross-review codex critic 호출에서 자연 검증 | 다음 release cycle 의 cross-review 로그 확인 |
| AC5 | 4 채널 합집합 결정 규칙이 단일 모듈 (`hub/team/worker-signal.mjs` 가칭) 에 위치 | 코드 리뷰 + grep `worker-signal.mjs` 단일 import |

## 4. Shard 분할 안 (swarm 실행용)

이 PRD 를 swarm shard 로 분할 시:

| shard | 범위 | 대상 파일 (예상) |
|-------|------|---------------|
| shard-1 | `worker-signal.mjs` 모듈 신설 — 4 채널 입력 → 결정 규칙 출력 | `hub/team/worker-signal.mjs` (신규), 단위 테스트 |
| shard-2 | `tfx swarm list` union (메타 E #190) | `bin/tfx-swarm-list.mjs`, synapse-registry + swarm-logs 합집합 |
| shard-3 | `tfx-route.sh --job-status` 4-channel cross-check (#176) | `bin/tfx-route.sh`, status reporter |
| shard-4 | swarm orchestrator F7 (메타 B) cross-check | `hub/team/swarm-orchestrator.mjs` (또는 reconcile 위치) |
| shard-5 | 통합 테스트 + cross-review 회수 | `tests/integration/worker-signaling.test.mjs` |

shard 간 의존: shard-1 (모듈) 이 먼저, 나머지는 병렬 가능.

worktree 격리 필수 (cwd 공유 race) → `tfx-swarm` 사용. 메모리 룰 `feedback_swarm_cherry_pick.md` 준수 (cherry-pick 만, branch merge 금지).

## 5. 작업 순서 (multi-step)

1. **이번 세션 (PRD draft)**: 본 문서 commit. 4-channel spec + AC + shard 분할 확정.
2. **다음 세션 (shard-1 단독)**: `worker-signal.mjs` 모듈 + 단위 테스트 — 단일 PR.
3. **shard-1 머지 후**: shard-2/3/4 swarm 병렬. PRD 를 swarm 에 입력.
4. **shard-5 통합 테스트**: 합집합 후 prepare 에 npm test 통과 확인.
5. **release**: v10.16.0 minor (4 family 통합 = 새 기능).

## 6. Out of scope (이 PRD 가 해소하지 않음)

| 항목 | 이유 | 대안 |
|------|------|------|
| `prepare.mjs npm test EXIT=1` (체크포인트 작업 3) | 별개 root cause (eval-store fixture nested env). worker signaling 과 무관 | 별도 backlog issue 또는 fixture refactor |
| 메타 F (issue #191, integration auto-ff + 명시 보고) | 같은 ground truth 류이지만 **integration 단계** 의 보고 vs worker **lifecycle** 의 보고 — 분리 책임 | 메타 F 단독 PR |
| codex auth 캐시 (Issue #78) | 다른 family (account broker 도메인) | 별도 |

## 7. References

- 체크포인트: `20260425-191243-v10150-shipped-remaining-meta-f-and-worker-signaling.md`
- silent-flush evidence: `bkzdlw1nu` task — `/c/Users/tellang/AppData/Local/Temp/claude/.../tasks/bkzdlw1nu.output` (72s × 0B, status=quiet, pid 267034)
- 모델-직무 매핑 (PR [#184](https://github.com/tellang/triflux/pull/184)): gpt-5.5 메인 / gpt-5.4-mini 가성비 / gpt-5.3-codex escalation 중간
- escalation chain: `.claude/rules/tfx-escalation-chain.md`
- 메모리 룰: `feedback_swarm_cherry_pick.md` (cherry-pick 만, branch merge 금지), `feedback_tfx_async_false_failed.md` (#176 stdout.log 별도 경로 체크)
