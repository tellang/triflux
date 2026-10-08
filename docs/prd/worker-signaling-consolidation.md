부분 폐기: 2026-10-08 swarm 실행 및 상태 집계 항목 퇴역(ADR-0025). tfx-route 관련 요구사항은 별도 검토.

# Worker Signaling Consolidation PRD

date: 2026-04-25
status: 부분 폐기. swarm 실행 및 상태 집계 항목은 폐기했다. tfx-route 쪽 결함은 #176(PR #213)과 PR #185 로 고쳤고, 4채널 통합 판정 규칙은 별도 검토한다.

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

## 4. 남은 검토 범위

issue #176의 `tfx-route.sh --job-status` 조기 실패 판정과 PR #185의 silent-flush guard는 별도 검토한다. 위 표의 swarm 실행, `tfx swarm list`, `worker-signal.mjs` 및 4채널 집계 요구는 ADR-0025에 따라 실행 대상에서 제외한다.

코드 변경을 병렬로 진행할 경우 작업별 worktree와 세션을 분리한다. 각 세션의 CLI 실행은 `tfx-auto`를 사용한다. Claude Agent에는 `isolation: worktree`를 지정할 수 있다. 구현 범위와 테스트는 남은 두 family를 다시 검토한 뒤 정한다.

## 6. Out of scope (이 PRD 가 해소하지 않음)

| 항목 | 이유 | 대안 |
|------|------|------|
| `prepare.mjs npm test EXIT=1` (체크포인트 작업 3) | 별개 root cause (eval-store fixture nested env). worker signaling 과 무관 | 별도 backlog issue 또는 fixture refactor |
| 메타 F (issue #191, integration auto-ff + 명시 보고) | 같은 ground truth 류이지만 **integration 단계** 의 보고 vs worker **lifecycle** 의 보고 — 분리 책임 | 메타 F 단독 PR |
| codex auth 캐시 (Issue #78) | 다른 family (account broker 도메인) | 별도 |

## 7. References

- silent-flush evidence: 백그라운드 task 출력이 72초 동안 0B 였고 status=quiet 로 남았다.
- 모델-직무 매핑 (PR [#184](https://github.com/tellang/triflux/pull/184)): gpt-5.5 메인 / gpt-5.4-mini 가성비 / gpt-5.3-codex escalation 중간
- escalation chain: `.claude/rules/tfx-escalation-chain.md`
- #176: stdout.log 별도 경로 체크
