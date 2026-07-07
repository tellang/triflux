# PRD — 상주 자율 Sonnet CTO 매니저

**Consensus**: ~82% | **Rounds**: 1 (+critic 비평 통합) | **Models**: Codex(Architect) + Claude Opus(Planner) + Claude Opus(Critic)
**작성**: 2026-07-01 | **상태**: ✅ 계획 확정 (하이브리드 2-tier, 2026-07-01 사용자 승인) | **원안**: 사용자 옵션 C "풀 자율 상주" → 하이브리드로 전환

---

## ⚠️ USER CHALLENGE — 원안 대비 방향 전환 제안

사용자 원안은 **"백그라운드에 별도 Sonnet을 상시 띄워 CTO를 관리"**(옵션 C, 풀 자율 상주)였다.
그러나 **3개 모델이 만장일치로 "문자 그대로의 24/7 live Sonnet 세션은 default 부적합"**으로 수렴했다. 근거 3중:

1. **RAM**: 상주 Claude Code 세션 = 영구 ~0.5–1GB 프로세스, 절대 free 안 됨. m5(MacBook Air M5 fanless 16GB)에서 hub + swarm(≤10) 위에 영구 +1 → swap/yellow memory_pressure(문서화된 back-off 신호). (Critic CRITICAL/perf)
2. **토큰**: 24/7 live loop는 유휴에도 구독 토큰을 계속 소진. (Planner risk)
3. **Compaction 소유권**: Claude Code 하니스가 세션 수명·compaction을 소유 → triflux가 상주 세션의 context 폭발을 강제 관리 불가. 다일 세션은 lossy auto-compact로 CTO 판단 저하. (Critic MEDIUM/edge)

→ **tfx-autoplan-principles의 user-challenge 규칙 적용**: 두 모델 이상이 사용자 원래 방향을 바꾸자고 합의하면 자동 확정하지 않고 사용자에게 올린다. 기본값은 사용자 원안 유지. **이 PRD의 권장안(하이브리드)은 사용자 승인 전까지 제안일 뿐이다.**

**✅ 해소 (2026-07-01)**: 사용자가 하이브리드 2-tier 채택을 명시 승인. 순수 24/7 상주는 `TFX_CTO_MODE=bridge` opt-in으로만 유지. 이 PRD는 하이브리드 기준으로 확정.

---

## 설계 방향 (합의 권장안 = 하이브리드 2-tier)

"항상 살아있는 CTO"를 단일 24/7 Sonnet이 아니라 **2계층**으로 구현한다:

- **Tier-1 (상주, 경량)** — 경량 Node 데몬(~30MB) `cto-manager`가 항상 살아 있으며 hub HTTP/MCP + fs 만으로 다음을 수행. **LLM 불요(mechanical)**:
  1. CTO role leader 유지 (register + heartbeat + takeover_role)
  2. hygiene 실제 archive 실행 (dry-run→승인→apply, move-not-delete)
  3. 이벤트/체크포인트/스웜 로그 retention·회전
  4. compact nudge 강화 (advisory only)
- **Tier-2 (지능, episodic)** — 판단이 필요한 순간에만 `conductor.spawnSession({agent:'claude',model:'sonnet'})` 또는 `claude-worker --resume`로 headless Sonnet 1턴을 띄워 collect/North-Star 합성/hygiene 분류 결정만 얻고 **종료**(기존 cto-auto-collect 120s 디바운스 패턴). 상주 TUI 아님.

**옵션(opt-in)**: 사용자가 진짜 풀 상주를 원하면 `TFX_CTO_MODE=bridge`로 native-bridge interactive-attach 경로를 opt-in 활성(Codex 제안). default는 bounded.

### 상주 3경로 트레이드오프 (합의)

| 경로 | 메커니즘 | 장점 | 단점 | 판정 |
|------|----------|------|------|------|
| **a. hub-supervised respawn** | conductor.spawnSession + 완료 시 재spawn | 상태머신/health/broker 재사용, headless 저RAM | task-scoped(maxRestarts=3+maybeAutoShutdown)라 상위 드라이버 필요, hub 내부라 hub 죽으면 CTO 소멸 | **Tier-2 지능 spawn 경로** |
| **b. native-bridge interactive-attach** | daemon-pty-tmux-bridge runBridge + roster | 진짜 long-lived, claude agents 가시성 | TUI 고RAM(fanless 치명), tmux/pty 복잡, 사람지향 | **opt-in only (TFX_CTO_MODE=bridge)** |
| **c. launchd/systemd 감독** | install-mcp-gateway-startup template 파생 | 재부팅 생존, OS KeepAlive 자동재기동, **hub 독립 → hub bounce 생존** | OS별 설치/권한, 유휴 24/7 점유 | **Tier-1 경량 데몬 상주 경로 (권장)** |

**상주 위치 미합의 해소**: Codex는 hub 내부 CTOManager(경로 a supervisor)를 권했으나, Critic의 CRITICAL("roleStates는 router in-memory Map → hub 재시작 시 CTO leadership 소멸")이 결정적. **별도 경량 데몬(경로 c 감독)이 hub-bounce 생존 요구를 만족** → Planner 안 채택. 단 미설치 시 SessionStart hub-ensure가 대체 기동 경로.

### 자율 loop 설계 (합의: liveness=fixed, work=event+debounce, unbounded=배제)

- **heartbeat**: fixed-interval 60~90s (lease TTL 및 120s sweep보다 작게). role lease 갱신은 주기적이어야 GC pause/장기 tool call 중 reelect away 방지.
- **hygiene/retention work**: event-driven(synapse.session.started/ended, swarm complete) + debounce(cto-auto-collect 미러) 또는 append size-trigger.
- **ralph 무한 loop 배제**: task 수렴용이지 steady-state 감독용 아님. 자연 정지 없어 토큰/RAM 지속 소진.
- **per-cycle budget (Critic 필수)**: sweep당 max tool calls/tokens/wall-clock + 동일 action 반복 circuit-break. conductor maxRestarts=3은 crash-loop만 커버, runaway-**healthy** loop는 이 budget이 유일 방어.

### CTO role 유지 프로토콜 (합의)

- `agent_id = cto-manager-<host>`, `capabilities:['cto']`.
- **순서 강제**: register → 첫 heartbeat로 `lease_expires_ms` 채워 `isCandidateLive`(router.mjs:257-261) 성립 → `takeover_role({role:'cto',agent_id})`. 비-live 후보로 takeover 호출 시 `ROLE_CANDIDATE_UNAVAILABLE`.
- **heartbeat**: 60~90s로 lease 갱신. sweeper `reelectStaleRoles`(router.mjs:1364-1371)가 유일 live 후보인 매니저를 자동 승계하므로 평시엔 후보 유지만.
- **실패 재획득**: hub down → hub-ensure 재기동 후 재-register+재-takeover. lease 만료 → 재-register 먼저. hub identity(pid/epoch) 변화 감지 시 재-register. 외부 live cto leader(사람 세션) 존재 → `getRoleSnapshot` 확인 후 back-off(explicit takeover 금지, epoch churn 회피). 3회 연속 실패 → `cto_manager_degraded` ledger append + spawn 중단.
- **split-brain guard**: 기존 `isCandidateLive` + `ensureRoleLeader`/`reelectStaleRoles`를 권위로 삼고 별도 election 안 만듦. **PR#444/#445 leaderEpoch/transferredCount 불변식 미파손**.

### hygiene archive 실행부 (합의)

현재 `applyHygieneRows`(cto/hygiene.mjs:520-564)는 `hygiene_applied` ledger ack만 append(실제 이동 0). 신규:

- **executor 위치**: `cto/hygiene-actions.mjs`(신규). `cto/hygiene.mjs`는 projection/locking/CLI facade로 유지.
- **archive target**: `.triflux/lake/archive/YYYYMMDD/` — `memory-doctor.mjs:481-483` renameSync 패턴(동일 fs; EXDEV 시 copy+unlink fallback). **move-not-delete → 복구 가능**.
- **operations**: superseded checkpoint / stale session 산출물 → archive 이동. orphan worktree(git remove/삭제) = **v1 자동 금지**, 보고만 + `request_human_input` MCP로 사람 ack.
- **게이트 (3중)**: (1) `dry_run:true` default(hygiene.mjs:416) → planned ops/bytes/digest/live-safety JSON 반환. (2) `TFX_CTO_HYGIENE_APPLY=archive` env. (3) 기존 steward lock(hygiene.mjs:441-505). delete는 별도 `TFX_CTO_HYGIENE_DELETE=1` 없이 금지.
- **second-actor 승인 (Critic/교차검증 정책)**: apply는 unlink/rename 전 out-of-band ack(다른 에이전트가 쓴 ledger ack row 또는 human gate). 동일 세션 self-approve 금지.
- **target 검증**: 모든 target이 lakeRoot 하위 AND `project_root_hash` 일치. live session 소유 산출물 skip(getActive() 교차).
- **멱등**: `hygiene_key` dedup(hygiene.mjs:398-400) 재사용.

### retention 정책 (합의: 상주 CTO와 함께/전에 ship — HARD 선행조건)

- `ledger.jsonl`: single-writer lock 유지. 50MB 또는 30일 초과 시 `ledger-YYYYMMDD-HHMMSS.jsonl.gz` 회전, 최근 10MB/14일 tail은 in-place 유지. current.json/md 재생성 후 `retention_applied` event.
- `swarm-events.jsonl`: run별 25MB/14일 초과 시 gzip archive. active run은 mtime + registry live check로 skip.
- `batch-events.jsonl`: 기존 200줄→100줄 정책 유지하되 공통 retention util로 이관(byte/age 병용).
- **락**: `.triflux/lake/retention.lock` + per-run `.retention.lock`.
- **active-session 제외 (Critic)**: retention은 hub `getActive()` 세션 소유 log 제외. in-place truncate 아닌 archive 이동.
- **readJsonLines tail cap (Critic)**: collect.mjs:567/hygiene.mjs:583의 full-file load를 bounded tail window로 전역 강제(1GB+ ledger OOM 방지).
- **synapse TTL 유지**: server.mjs:2265 pruneExpired(interactive 5m/clean 2h/dirty 24h)는 live-session pruning이라 변경 없음.

### compact 정책 (합의: 강제 불가 = HARD CONSTRAINT)

- **허용**: PreCompact 스냅샷 + PostToolUse 80%/90% nudge 강화. nudge marker를 session/project scoped로. 90% critical은 marker 무관 주기 재알림.
- **금지**: main 작업 세션 compact 강제 트리거 (Claude Code 하니스 소유). "강제 불가"를 코드 주석 + 문서에 hard-constraint로 박아 후속 오구현 차단.
- CTOManager는 `compact_needed` advisory event만 publish.
- **CTO 자체 세션 (Critic)**: 모든 CTO state를 hub/.triflux/lake로 외부화 → 영원한 단일 세션 대신 N시간마다 fresh-restart(kill+respawn) + 외부 store 복원.

### kill-switch (합의: 매 cycle read)

- `TFX_CTO=0` / `TFX_CTO_MANAGER=0`: 데몬 timer·spawn·archive apply·retention apply 전부 비활성 (default off — 도입만으로 동작변화 0).
- `TFX_CTO_HYGIENE_APPLY=off|archive`, `TFX_CTO_RETENTION=0`, `TFX_CTO_MODE=bounded|bridge`, `TFX_CTO_MAX_TOKENS`(loop cap).
- **boot이 아닌 매 cycle read** (Critic): fs-mutation+계정 leasing 하는 자율 에이전트엔 매 cycle 하드 disable 필요.

---

## 태스크 (order 반영)

| ID | 제목 | 복잡도 | deps |
|----|------|--------|------|
| T1 | kill-switch + config surface (TFX_CTO_* env, default off) | S | — |
| T4 | hygiene archive 실행부 (executor, dry-run/승인/steward lock, move-not-delete) | L | T1 |
| T5 | retention/rotation 모듈 (ledger/swarm-events/batch-events, active-session 제외, tail cap) | M | T1 |
| T2 | cto-manager 데몬 스켈레톤 (single-instance lock, 스케줄러, env-gate no-op) | M | T1 |
| T3 | CTO role 유지 프로토콜 모듈 (register→heartbeat→takeover, 재획득, back-off) | M | T2 |
| T6 | on-demand Sonnet 추론 spawn (episodic headless, extractCompletionPayload 회수) | M | T2,T3 |
| T7 | 상주 수퍼비전 OS unit (launchd/systemd, opt-in, idle-skip, mac+linux, win32 미지원) | M | T2 |
| T8 | compact nudge 강화 (advisory, hard-constraint 명시) | S | T3 |
| T9 | 회귀 가드 테스트 (아래 테스트 전략) | L | T3,T4,T5,T6 |
| T10 | packages 3-layer 미러 동기화 | S | T2~T8 |
| T11 | 교차검증(Codex 리뷰) + .claude/rules·MEMORY 갱신 | S | T1~T10 |

**order**: T1 → T4 → T5 → T2 → T3 → T6 → T7 → T8 → T9 → T10 → T11
(retention T5는 hard 선행조건이라 데몬 T2 앞에 당김.)

**per-cycle budget (T2/T6에 배선)**: max tool calls/tokens/wall-clock per sweep + 동일 action 반복 circuit-break.

---

## 파일 변경

**신규**:
- `hub/team/cto-manager.mjs` (상주 데몬) — 또는 Codex 안대로 `hub/cto-manager.mjs`
- `hub/cto-role-client.mjs` (register/heartbeat/takeover wrapper, retry/backoff)
- `hub/log-retention.mjs` (회전/압축)
- `cto/hygiene-actions.mjs` (dry-run plan + archive executor)
- 테스트: `tests/unit/cto-manager.test.mjs`, `tests/cto/hygiene-actions.test.mjs`, `tests/unit/log-retention.test.mjs`

**수정 (root SSOT)**:
- `hub/server.mjs` (TFX_CTO gate, unref 타이머 또는 데몬 attach 지점), `hub/tools.mjs`(MCP tools), `hub/pipe.mjs`, `hub/bridge.mjs`, `cto/hygiene.mjs`(executor 위임), `cto/index.mjs`(CLI), `hooks/hook-orchestrator.mjs`(nudge)
- `scripts/install-mcp-gateway-startup.mjs` 파생(OS unit template)

**미러**: root SSOT 변경 후 packages/triflux(byte) + packages/core(bridge self-import 대상만 minimal cp) + packages/remote(@triflux/core import 변환, Edit만). npm pack --dry-run ~1MB 확인.

**신규 API surface**: MCP `cto_manager_status`/`cto_hygiene_plan`/`cto_hygiene_apply`/`cto_retention_run`; CLI `tfx cto manager status|start|stop|wake`, `tfx cto hygiene --dry-run|--apply`, `tfx cto retention`; HTTP `/cto/manager*`, `/cto/hygiene*`, `/cto/retention*`.

---

## 리스크 & 완화 (Critic 통합, 심각도순)

| 심각도 | 리스크 | 완화 |
|--------|--------|------|
| **CRITICAL** | broker days-long lease vs 30min TTL double-lease (account-broker.mjs:68 LEASE_TTL, :827 reaper) | 상주 CTO는 persistent lease 금지. **Claude는 broker 밖(codex/gemini만 관리)이라 lease=null 정상** → 실제 저위험. 향후 claude 계정 broker 도입 시 per-action lease+즉시 release |
| **CRITICAL** | hub 재시작이 CTO leadership 소멸 (roleStates in-memory Map, 비영속) | 별도 데몬(경로 c)이 hub 독립 생존. heartbeat마다 hub liveness 검증, 404/reset 시 재register. worktree-codex-dispatch-hub-path-capture 재발 주의 |
| **MAJOR** | WORK 계층 split-brain (2 데몬이 각자 sweep/archive/rotate) | machine-global singleton guard(tray 싱글턴 패턴) + 모든 autonomous action 전 hub "still leader?" 재확인 |
| **MAJOR** | leaderEpoch thrash (반복 takeover, heartbeat flapping) | 재register 지수백오프, 이미 leader면 takeover skip. PR#444/#445 불변식 락 테스트 |
| **MAJOR** | idle 상주 세션이 stale로 오분류·archive | CTO가 < staleMs마다 liveness marker touch, 자기 세션은 자기 hygiene projection에서 제외 |
| **MAJOR** | 실제 archive가 잘못된 대상 삭제 (dry-run/승인 gate 부재) | dry-run→ack→apply, target lakeRoot 하위 AND project_root_hash 일치 검증, rm 금지 rename-to-archive |
| **MEDIUM** | runaway-healthy loop (maxRestarts=3 미커버) | per-iteration budget(tool calls/tokens/wall-clock) + 동일 action circuit-break |
| **MEDIUM** | steward-lock staleMs auto-steal이 hijack 허용 (hygiene.mjs:494) | lock holder가 장기작업 중 mtime refresh + pid liveness 검증 후에만 steal |
| **MEDIUM** | RAM: 16GB fanless 영구 slot | 명시적 RAM 회계 — 상주 중 유효 worker cap 10→9, active swarm 중 CTO sweep 자동 suspend |
| **MEDIUM** | retention이 live 세션 log 삭제 | getActive() 소유 log 제외, archive 이동(truncate 금지) |
| **LOW** | public snapshot 누출 (account id/auth path/session path) | broker publicSnapshot()만 경유, env/authFile/host/raw-timestamp 누출 안 됨 assert |
| **LOW** | unbounded ledger read OOM | readJsonLines tail cap 전역 강제 |

---

## 테스트 전략 (Critic 주도)

**unit**:
- reelectStaleRoles live-leader no-op (PR#445 불변식을 상주-CTO 회귀로부터 락: leaderEpoch monotonic, transferredCount 불변)
- isCandidateLive 경계 (lease_expires_ms == now/now-1/now+1, strict >)
- **AccountBroker TTL pruner vs 장기 lease** (30min 초과 진행 → busy flip → 재lease → double-lease; 상주 CTO가 lease-free 될 때까지 이 테스트는 FAIL해야 함 = 가드)
- takeoverRole 멱등성 (현재 leader가 takeover → changed=false, epoch 불변)
- hygiene archive target guard (project_root_hash mismatch → apply 거부)
- log rotation: active 세션 소유 log는 rotate/삭제 안 됨
- kill-switch: TFX_CTO_RESIDENT=0=launch 차단, TFX_CTO_ARCHIVE=0=apply no-op, 매 cycle 재read

**integration**:
- Hub crash → CTO failover (register→hub kill→respawn→120s 내 재확보; in-memory 영속 gap 처리 증명)
- 두 상주 CTO launch (singleton guard 거부; 우회 시 steward lock+leader 재확인이 double archive 방지)
- 상주 CTO + 10-worker swarm RAM (swap-out storm 없음, 유효 cap -1)
- broker starvation (단일 codex 계정 점유 시 다른 lane circuit → CTO가 Claude-only/lease-free 증명)
- 장기 compaction (CTO 세션 compact 강제 → role reg+threshold가 외부 store에서 생존)

**edge_case**:
- 장기 tool call 중 heartbeat lapse (GC pause > TTL → reelect away 후 epoch thrash 없이 clean 재register)
- 작업 중 steward lock 탈취 (mtime stale 유도 → 동시 파괴적 apply 없음/lake 손상 없음)
- quiet-but-live 세션 (TTL 초과 idle이나 프로세스 살아있음 → archive 안 됨)
- ledger.jsonl 1GB+ (tail-read bounded, OOM 없음)
- **mirror parity** (router.mjs/server.mjs CTO 추가 후 packages/{core,remote,triflux} diff -q; PR#444/#445 sweeper 테스트 모든 미러 green 유지)

---

## 미합의 / 결정 대기

1. **[USER CHALLENGE — 최우선]** 순수 24/7 상주(원안 C) vs 하이브리드 2-tier(합의 권장). 위 헤더 참조. 사용자 결정 필요.
2. **상주 위치** (hub 내부 vs 별도 데몬): Critic 근거로 별도 데몬 권장했으나 Codex는 hub 내부 supervisor 이점(타이머/broker 재사용) 주장. 별도 데몬이 hub HTTP/MCP로 접근하면 양쪽 이점 → 합의로 수렴하나 구현 세부는 T2에서 확정.
3. **broker 위험도**: Critic CRITICAL vs Planner "Claude broker 밖이라 저위험". 사실 확인 완료(Planner 옳음) → per-action lease는 향후 claude 계정 broker 도입 시에만.

---

## 근거 파일 인덱스 (전부 직접 확인)

- `cto/hygiene.mjs`: :226-416 projection, :441-505 steward lock, :494 staleMs auto-steal, :520-564 applyHygieneRows(ack만), :398-400 dedup, :416 dry_run default
- `hub/router.mjs`: :257-261 isCandidateLive, :439-491 ensureRoleLeader, :1038-1116 takeoverRole, :1364-1371 reelectStaleRoles, :1349 unref timers
- `hub/server.mjs`: :1539-1582 register/heartbeat, :1689-1718 /bridge/register, :2240-2335 unref sweeper timers, :2254 SESSION_TTL, :2265 synapse pruneExpired
- `hub/account-broker.mjs`: :68 LEASE_TTL_MS, :827-838 TTL reaper, :843-983 lease, :987-1009 release, :1092-1105 activeLeases carry
- `hub/team/conductor.mjs`: :498-535 finite restart/dead, :793-817 completed release, :1079-1087 maybeAutoShutdown, :1107-1189 spawnSession, :1158-1173 claude lease=null
- `hub/team/cto-auto-collect.mjs`: :9 env-gate, :27-119 debounce+runCollect
- `hub/workers/claude-worker.mjs`: :115 --model, :126-127 --resume
- `scripts/install-mcp-gateway-startup.mjs`: :185-204,367-374 plist KeepAlive/systemd Restart
- `scripts/hub-ensure.mjs`: :637-664 detached start, :666-829 health-gated run
- `hooks/hook-orchestrator.mjs`: :569-600 80/90% nudge
- `hooks/pre-compact-snapshot.mjs`: :129-170 PreCompact additionalContext
- `hub/memory-doctor.mjs`: :481-483 renameSync .tfx/archive (archive move 패턴)
- `cto/events.mjs`: :394 appendCtoEvent (회전 없음)
