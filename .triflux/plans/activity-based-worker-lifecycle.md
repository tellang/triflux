# PRD: activity-based worker lifecycle — 킬 평면의 활동 기반 재배선

- 상태: proposed (2026-07-10)
- 출처: tfx-interview 타임아웃 전수 감사 (272 raw → 95 논리 사이트, 판정 no 4 / questionable 38 / yes 53)
- 선행 조치: no-판정 4건은 별도 커밋으로 즉시 수정됨 (SKILL.md 6곳 bg 전환, tfx-route:1463 3600, 죽은 지침 정정, dead param 제거)

## 배경 / 문제

triflux에는 활동 기반 판정기가 3개 있다 — `scripts/tfx-route.sh` heartbeat_monitor(활동 3소스: stdout+stderr+codex rollout, probe grace, 기본 classify), `hub/cli-adapter-base.mjs:411` stall 감지(30s 무변화), `hub/team/headless.mjs:476` stallTimeout(활동 시 리셋). 그러나 **어느 것도 wall-clock 킬 타이머를 연장하지 않는다.** 킬 평면(coreutils `timeout` bin 4곳, headless completionTimeout, adapter runProcess timeoutTimer, hub assign deadline)은 전부 활동 무관 순수 wall-clock이라, 출력이 계속 흐르는 성실한 워커도 잘린다 (실사고: 워커 600s 컷).

확정 정책 (2026-07-10 인터뷰):

1. **워커 실행은 wall-clock으로 죽이지 않는다.** 개입 트리거 = 무활동(stall) 20분 (기본 1200s, env 조정 가능).
2. **개입 사다리** (킬은 최후 수단): ① interrupt + 재지시 (채널 보유 경로 — 세션·컨텍스트·토큰 보존) → ② graceful 종료 + resume 이어받기 → ③ SIGTERM → ④ SIGKILL.
3. wall-clock은 **최후 방어선**으로만 유지 (기본 6h — 16GB fanless 머신 자원누수 방어).
4. 활동 신호 = stdout/stderr/rollout/resultFile 변화. 기존 감지기 3개를 재사용하고 판정 기계를 새로 만들지 않는다.

## Non-goals

- 인프라 방어선(liveness TTL, network/MCP 타임아웃, cleanup grace) 제거 — 유지. questionable 항목의 개별 재심사만 부록 B에서 후속.
- Claude Code 하니스 foreground Bash 600s 캡 변경 (저장소 밖, 불가) — SKILL.md bg 전환으로 이미 우회.
- codex/agy CLI 내부 타임아웃 변경.

## Shards

### T1 route-stall-kill — `scripts/tfx-route.sh`

- heartbeat stall 판정을 개입 집행으로 승격: `TFX_STALL_THRESHOLD` 기본 300 → **1200s (20min)**, `TFX_STALL_KILL` 기본 `classify` → 사다리 호출 모드(T5 배선 전까지는 `kill` 동작으로 우선 이행 가능하되 기본 전환은 T5와 함께).
- `TIMEOUT_BIN` 집행부 4곳(:2212/:2247/:2573/:2680)의 인자를 lane `DEFAULT_TIMEOUT`에서 **최후 방어선 `TFX_HARD_CEILING_SEC` (기본 21600)** 로 교체. lane DEFAULT_TIMEOUT은 heartbeat `expected_duration`/보고용 advisory로 강등.
- coreutils `timeout`에 `-k 5` 추가 (SIGTERM 무시 좀비 차단). `_no_timeout` fallback(:41)은 경고 강화 + `tfx doctor` 체크 추가 (머신별 행동 분열 가시화).
- **내부 타이머 포함 (Codex 리뷰 P1)**: stream-worker 경로는 `TIMEOUT_SEC*1000`을 `scripts/tfx-route-worker.mjs --timeout-ms`(:2206)로도 전달하고 내부 Claude/Antigravity 워커가 이를 자체 SIGTERM wall-clock으로 사용 — 외곽 `TIMEOUT_BIN`만 교체하면 내부 타이머가 여전히 활동 중 워커를 죽인다. 내부 타이머도 활동 연장으로 전환하고 activity-reset 테스트를 추가한다.
- 미러: `packages/triflux/scripts/tfx-route.sh` byte-identical cp.

### T2 headless-activity-extend — `hub/team/headless.mjs`

- `completionTimeout`을 wall-clock에서 **무활동 판정**으로 교체: lastChangeAt 기준 20min 무활동 시 개입, 절대 상한은 `TFX_HARD_CEILING_SEC`. `.partial` persist 계약(#118)은 유지.
- `waitForDaemonCompletion`(:1276): 스트림 진행 메시지 수신 시 데드라인 연장 + `.partial` persist 추가 (현재 없음).
- 기본값 3계층 불일치 해소: `parse-args.mjs:77` CLI 기본 300s 제거 → lane/route 기본에 위임. `runHeadless` 900 fallback은 유지.

### T3 adapter-activity-extend — `hub/cli-adapter-base.mjs`, `hub/codex-adapter.mjs`, `hub/gemini-adapter.mjs`

- `runProcess` timeoutTimer(:472)를 기존 stall 감지(:411)와 통합: 활동 시 데드라인 연장, 무활동 20min 시 개입, 절대 상한 6h.
- codex 재시도 `timeout×2`(:57) 재검토 — 활동 연장이 생기면 배가 로직 불필요.
- **`hub/workers/codex-app-server-worker.mjs` 포함 (Codex 리뷰 P1)**: app-server transport는 자체 `setTimeout` SIGTERM(timeoutMs)을 가져 notification이 계속 흘러도 발화한다. progress notification이 데드라인을 연장하도록 전환 + 테스트 (T5 interrupt 프로토콜과 별개의 실행 타이머임에 주의).
- 미러: packages/triflux cp + packages/remote는 Edit만 (`@triflux/core` import 보존).

### T4 hub-coordination-extend — `hub/router.mjs`, `hub/store.mjs`, `hub/lib/memory-store.mjs`, `hub/server.mjs`, `hub/tools.mjs`

- assign `timeout_ms/ttl_ms` 기본 600000ms **5중 하드코딩 → 단일 상수 모듈 SSOT화**.
- 워커 활동 → `status=running` progress **자동 보고 배선** (기존 연장 장치 router:1261 활용, 새 메커니즘 금지).
- deadline 기준을 `created_at` → dispatch 시점으로 (큐 대기가 실행 예산 잠식하는 문제).
- 늦은 완성 결과: attempt mismatch 즉시 폐기 대신 결과 보존 + supervisor 통지 (완성 작업 유실 방지).
- handoff ttl 만료(600000ms) 시 무통지 dead letter → 발신자 통지 추가. `swarm-locks.mjs` LOCK_TTL 10min에 갱신(heartbeat renewal) 메커니즘 추가.

### T5 intervention-ladder — 신규 `hub/team/intervention.mjs` (가칭)

- 무활동 20min 도달 시 채널 판별 → interrupt + 재지시:
  - Claude daemon 경유: UDS sendInput interrupt → 재지시 프롬프트 주입
  - tmux pane: `send-keys C-c` → 재지시
  - codex app-server UDS: turn interrupt (reference: `reference_codex_app_server_uds_wire`)
- 재지시 후에도 무활동이면 graceful 종료 + resume 1회 (`claude -p --resume <session>`, `codex exec resume`) — capability probe 후 미지원이면 스킵.
- 이후 SIGTERM → 5s → SIGKILL (+orphan sweep, heartbeat_monitor 기존 로직 재사용).
- T1~T3의 개입 지점이 이 사다리를 호출하도록 배선.

### T6 test-contract-refresh — `tests/`, `scripts/headless-guard.mjs`

- `tests/unit/headless-stall.test.mjs:255` "출력이 변해도 만료" wall-clock 계약 → 활동 연장 계약으로 교체.
- `tests/unit/headless-guard.test.mjs:181` 로컬 사본 테스트 drift 해소 — 프로덕션 `buildCommand` 직접 import. guard 300 floor(:347)는 `max(route lane 기본, 명시값)` 으로 (PRD p3-swarm-infra-fixes ISSUE-5 방향).
- `tests/fixtures/bin/timeout` Windows shim에 duration 의미론 복원 (kill 경로 blind spot 해소).

## 수용 기준 (공통)

- 활동이 지속되는 워커는 절대 상한(6h) 전까지 죽지 않는다 — 신규 테스트로 고정.
- 무활동 20min 워커는 사다리를 타고 종료된다 — 채널별(케이스: interrupt 성공/resume 성공/최종 kill) 테스트.
- lint/format은 **변경 파일 한정** (repo-wide biome 금지 — lease escape 방지).
- packages 미러 동기 (`.claude/rules/tfx-mirror-policy.md`), 커밋 스코프 규약 준수 (hub 작업=fix(hub), route=fix(route) 등).
- PRD/프롬프트에 메인 repo 절대경로 정적 앵커 금지 — cwd 동적 grounding.

## 리스크

| 리스크 | 완화 |
|--------|------|
| 장고 추론 무출력 → 오탐 개입 | rollout/resultFile 활동 소스 필수 + 20min 여유 + probe grace 유지 |
| resume 미지원 CLI 버전 | capability probe 후 graceful 단계 스킵 (사다리 ③으로 직행) |
| progress 자동 보고 없는 legacy 워커 | T4는 하위호환 — 기존 명시 보고 경로 유지, 자동 보고는 additive |
| 절대 상한 6h가 새 wall-clock 사고 유발 | 상한 도달 전 1h 시점 HUD/notify 경고 |

## 부록 A — 이번 즉시-수정으로 이미 해소된 것 (재작업 금지)

- SKILL.md 6곳 (tfx-review/prune/qa/analysis/plan/research) fg `--timeout 600` → `run_in_background` + 1800
- `scripts/tfx-route.sh` xhigh 리매핑 lane 600 → 3600
- `skills/tfx-review/SKILL.md` Error Recovery 죽은 "--timeout 900" 지침 정정
- `hub/team/swarm-hypervisor.mjs` `_integrationTimeoutMs` dead param 제거
- `scripts/tfx-gate-activate.mjs` 레거시 alias 문구 bg 전환

## 부록 B — questionable 잔여 (개별 재심사 대상, 이 PRD 범위 밖)

hub 조율 평면 외 인프라·표시 계열: `uds-orchestrator` marker 90s/turn 120s (T3 유사 패턴이지만 UDS 스트림 — T5에서 함께 판단), `codex-review.mjs` 180s, `cli-agy.mjs` 900s(auth 배리어 무시), `bridge.mjs` assign sync 120s vs 잡 600s 층위 비정합, `async.mjs:95` SIGTERM-only, `native.mjs` spark 600s, release `test-lock` 600000ms 성장 감시. 전체 판정표는 감사 세션 산출물(`.tfx/plans/timeout-audit-20260710.md`, 세션 로컬) 참조.
