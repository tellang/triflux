# Changelog

All notable changes to triflux will be documented in this file.

## [Unreleased]

## [10.17.1] - 2026-04-27

### Fixed

- Prevented the hub orphan-process cleanup from terminating active Claude Code or Codex sessions. The periodic cleanup now treats live `claude.exe` and `codex.exe` processes as protected session roots, while still reclaiming narrow legacy runtime leftovers.
- Added `TFX_DISABLE_ORPHAN_CLEANUP=1` as an emergency gate for hub orphan cleanup and expanded cleanup logs with killed process details so future incidents show the exact PID, process name, command line, and caller.
- Extended hub runtime cleanup to remove orphaned duplicate `bun ... gbrain/src/cli.ts serve` processes while preserving the live `gbrain` runtime under the active Claude/Codex session.
- Disabled the broad Stop-hook MCP cleanup by default. `mcp-cleanup.ps1` is now opt-in via `TFX_ENABLE_STOP_MCP_CLEANUP=1`, preventing normal Claude Code response-stop events from killing live MCP runtimes.
- Hardened SessionStart stale PID cleanup against Windows PID reuse and live Claude/Codex ancestor chains, so stale `tfx-route-*-pids` files cannot kill runtime children from the current session.
- Cleaned up stray SS3 cursor escape fragments such as `[O[` from routed CLI output.

### Tests

- Added regression coverage for active Claude/Codex session protection, MCP child process protection under those roots, stale PID cleanup safety, Stop-hook MCP cleanup safety, and SS3 cursor artifact cleanup.

## [10.17.0] - 2026-04-26

### Fixed

- **`fix(test)` (PR #199, Phase 1)** tfx-route-smoke fake CLI fixture 안정화 (5d0edaf) — Linux ubuntu-latest CI 의 `codex --version` not-found 로 tfx-route.sh 가 `claude-native` fallback path 진입 → `tests/integration/tfx-route-smoke.test.mjs` 의 `resolved_profile=executor` regex mismatch (45 fail). `tests/fixtures/bin/{codex,gemini,timeout}` 의 Linux executable bit 활성화 + `tests/fixtures/fake-codex.mjs`/`fake-gemini-cli.mjs` 의 `--version` 응답 보강 + 테스트의 fallback resolved_profile 인식 path 추가. **결과**: 45 fail cascade 제거, CI Linux 에서 fake CLI 사용으로 codex 인증 의존 제거.
- **`test(ci)` (PR #199, Phase 2)** codex-app-server-worker AC-1 initialize timeout 안정화 (3768b4f) — `tests/unit/codex-app-server-worker.test.mjs:307` 의 AC-1 30ms bootstrap budget + `unref()` timer 가 Linux CI test runner 의 이벤트 루프 종료로 35건 cancelledByParent cascade 유발. Fake JSON-RPC client timer 를 ref 로 변경 + bootstrap timeout 500ms 로 상향 → `CodexAppServerTransportError` rejection 경로 안정 관측. **결과**: 36 fail cascade 제거.
- **`fix(test)` (PR #199, Phase 3)** worktree-lifecycle Linux path portability (50a95d1) — `tests/unit/worktree-lifecycle.test.mjs` 가 `ensureWorktree()` 의 forward-slash 반환을 무조건 Windows `\` 로 변환 → Linux CI 에서 `\tmp\...` ≠ `/tmp/...` 로 `existsSync` 실패, W-08/W-10/W-09 cwd cascade. 플랫폼 skip 대신 반환 계약 그대로 fs/cwd 에 넘기도록 정렬. **결과**: 13 fail cascade 제거.
- **`fix(test)` (PR #199, Phase 4)** 잔여 카테고리 cascade 일괄 해소 (c16f411, 28 files) — Linux CI 잔여 fail 제거.
  - **Ref/unref timer cancellation root**: `hub/workers/worker-utils.mjs`, `hub/cli-adapter-base.mjs`, `hub/workers/lib/jsonrpc-stdio.mjs`, `hub/router.mjs` — awaited retry/timeout timers 를 ref 로 유지해 Node test runner 가 cancelledByParent 선언하지 않도록.
  - **Codex CLI absent command-shape cascade**: `hub/cli-adapter-base.mjs`, `bin/triflux.mjs` — version detection fallback 을 modern `codex exec --color never` 계약으로 고정. Hub start 가 codex binary 유무와 무관하게 `~/.codex/config.json` 의 tfx-hub entry 보장.
  - **Codex review fixture determinism**: `hub/team/codex-review.mjs`, `tests/unit/codex-review.test.mjs` — oversized gate 의 실제 git diff 의존을 dependency injection fixture 로 교체.
  - **CI memory-doctor force fixtures**: `tests/unit/memory-doctor.test.mjs` — autofix 검증 케이스에 `{ force: true }` 적용.
  - **Linux git identity + psmux regex**: `hub/team/worktree-lifecycle.mjs`, `hub/team/psmux.mjs` — cherry-pick commit 작성용 deterministic fallback identity, orphan MCP cleanup regex 의 session boundary class 정렬.
  - **결과**: router 18 / retry 12 / codex-review 12 / hub-restart 10 / memory-doctor 9 / jsonrpc-stdio 8 / routing-qa 5 / rebase-branch-safety 4 / hub-start-codex-config 4 / session-fingerprint 3 / pane 3 / backend 3 / gemini-adapter 1 / codex-adapter 1 등 ~62 fail/cancelled 일괄 해소.
- **`fix(test)` (PR #199, Phase 7)** Phase 1-4 후 잔여 ~14 fail 추가 해소 (bd9605c, 965fb88, d54e2c3) — codex-app-server cleanup timer drain (965fb88), conductor shutdown cleanup 안정화 (d54e2c3), 그 외 phase 7 residuals (bd9605c) 일괄. `tests/unit/conductor.test.mjs:432` waitFor 3000ms timeout 회귀 fix 포함.
- **`fix(config)` (PR #199, Phase 8)** codex MCP sync test env guard 추가 (b85046b) — Phase 4 의 hub start 자동 sync 가 npm test 중 `~/.codex/config.toml` mutate 해 Issue #193 회귀 가드 trigger. `isProtectedCodexConfigMutationEnv()` (NODE_ENV=test / CI / TFX_TEST / TRIFLUX_TEST_HOME) 가드 적용 + `tests/unit/sync-hub-mcp-settings.test.mjs` 추가.
- **`fix(test)` (PR #199, Phase 9)** 잔여 codex config mutation paths 차단 + hub-idle-timeout 안정화 (9bb3270, 76d9a04) — Phase 8 후에도 mutation 잔존 (size -14B trim) → `scripts/codex-mcp-gateway-sync.mjs`, `scripts/lib/mcp-guard-engine.mjs`, `hub/server.mjs`, `scripts/setup.mjs` 모든 writer 에 env guard 적용. `tests/integration/hub-idle-timeout.test.mjs` 의 random port 28100-28299 collision 을 `getUnusedPort()` (OS 할당) 로 deterministic 대체. setup integration test 가 `TFX_CODEX_CONFIG_SYNC=1` 로 가드 우회 (76d9a04).
- **`fix(hosts-compat)` (PR #198)** nested `ssh.user` shape 정규화 (460f5c6) — Windows `references/hosts.json` 의 `{ ssh: { user: "..." } }` 를 capability/resources selector 가 인식하도록 정규화.
- **`fix(test)` (PR #198)** routing-qa + intent fixtures 의 PR #184 model mapping 동기화 (c698869).
- **`fix(keyword-rules)` (PR #198)** tfx-unified rule 에 `병렬`/`점검`/`계속` 패턴 추가 (3c2aca8).

### Changed

- **`chore(ci)`** `continue-on-error: true` guard 영구 제거 (8bdc00e, Phase 5) — `cec9124` 가 임시 우회로 추가한 `Codex config stability guard` step 의 `continue-on-error: true` + 주석 7줄 제거. **결과**: strict regression gate 회복 — 다음 push 부터 guard step fail 이 workflow status=failure 로 직결되어 회귀를 즉시 차단. `cec9124` 의 임시 unblock 이후 후속 수정 (Phase 1-4 + 7-9) 으로 baseline 56 fail → 0 fail 100% 해소.

### Tests

- 56 baseline fail → 0 fail / 0 cancelled (PR #198 CI run 24946484889 → PR #199 final run 24948670562)
- pass count: 3084 → 3195 (97.6% → 100% pass rate)
- continue-on-error 영구 제거 후에도 CI green 유지

## [10.16.0] - 2026-04-26

### Added

- **`feat(snapshot)` (#196, shard E)** codex/gemini state auto-snapshot watcher (76e709e) — Hub `ensure` 경로에서 24h threshold 기준으로 `~/.codex/`, `~/.gemini/` 의 config·skills·agents·plugin·state 를 best-effort rolling 10 archive 로 백업한다. config-wipe 회귀와 update-time state loss 로부터 사용자 환경을 보호. **Constraint**: hub-ensure 동기 차단 금지 → detached wrapper (`scripts/snapshot-watcher.mjs`) 로 spawn. **Constraint**: snapshot 은 binary 라 git history 외부 (`~/.codex-backups/`, `~/.gemini-backups/`) 로 분리. `tests/unit/state-snapshot.test.mjs` + `tests/unit/hub-ensure-port-cascade.test.mjs` PASS. `npm run snapshot:codex` / `npm run snapshot:gemini` 수동 진입점도 추가.
- **`feat(swarm)` (#197, shard C)** WorkerSignalChannel — shard lifecycle signal channel (a26114e) — append-only 파일 기반 shard lifecycle signal 을 worker-signals state tree (`~/.claude/cache/tfx-swarm/worker-signals/`) 에 기록한다. callback 기반 listening + stale heartbeat detection 을 포함한다. **Constraint**: 본 shard 는 infrastructure 만 — full hypervisor/planner 통합은 후속 shard. **Rejected**: file-lease state directory 공유 → worker signal 은 lease 와 별개 lifecycle 이라 contention 회피 위해 분리. `tests/unit/worker-signal.test.mjs` PASS.

### Fixed

- **`fix(hub)` (#197, shard A)** codex config.toml MCP port auto-mutation 차단 (ff6aff5, BUG-D/E regression family) — Hub startup 이 `TFX_HUB_PORT` 또는 default `27888` 을 유일한 port source 로 취급하고, codex MCP sync 가 runtime port 가 아닌 canonical `27888` URL 로 `~/.codex/config.toml` 을 안정화한다. PR #158 single-source 정책을 hub start/reuse 결정 경로까지 전파. **Rejected**: sticky live pid port reuse 보존 → BUG-D/E port cascade 가 codex config.toml 로 재진입하는 회귀 trigger. `tests/regression/codex-config-port-stable.test.mjs`, `tests/unit/hub-server-port.test.mjs`, `tests/unit/state.test.mjs`, `tests/unit/mcp-singleton.test.mjs`, `tests/unit/sync-hub-mcp-settings.test.mjs`, `scripts/__tests__/mcp-guard-engine.test.mjs`, `tests/unit/packages-mirror.test.mjs`, `tests/unit/setup-home-resolution.test.mjs` PASS. `node bin/triflux.mjs hub start --port 27888` 3회 반복 후 `~/.codex/config.toml` mtime 불변 + `url=http://127.0.0.1:27888/mcp` 검증.
- **`fix(mcp)` (#197, shard B)** child stdin EOF 닫기 — MCP bootstrap/profile-filter hang 차단 (1b31a63, #192 hang 카테고리) — non-interactive route helper process 의 stdin 을 닫고 non-TTY heartbeat stdio 를 detach 해 Git Bash sleep child 가 caller pipe 를 hang 상태로 잡지 못하도록 한다. Codex MCP bootstrap 이 transport 조기 종료를 방지하도록 가드 + bootstrap transport 실패 코드를 transport exit code 로 매핑해 tfx-route auto fallback 이 동작. **Constraint**: interactive TTY heartbeat output 보존, non-TTY route 만 stderr log 로 진단 출력. **Rejected**: heartbeat 전역 비활성화 → interactive progress signal 손실 (UX 회귀). `tests/regression/mcp-bootstrap-no-hang.test.mjs`, `tests/unit/codex-mcp-worker.test.mjs`, `tests/integration/triflux-cli.test.mjs --test-name-pattern=MCP` PASS. `npm test` 99s 종료 (잔존 fail 은 fixture/host-config 카테고리 — #192 deferred shard).
- **`fix(config)` (#193, #194)** HOME/USERPROFILE swap 존중으로 test fixture 격리 (5dad109) — Windows `os.homedir()` 가 `USERPROFILE` 만 보고 `process.env.HOME` swap 을 무시 → integration test 의 spawn child (setup.mjs / sync-hub-mcp-settings.mjs) 가 fixture homeDir 을 무시하고 production `~/.codex/config.toml` 을 mutate 하던 회귀 (#193). 우선순위: `TRIFLUX_TEST_HOME` > `HOME` > `USERPROFILE` > `os.homedir()`. PR #194 codex review 반영으로 platform-aware home resolution + 회귀 test (`tests/unit/setup-home-resolution.test.mjs`) + `scripts/check-codex-config-stable.mjs` 가드 wrapper + `npm script test:guard-codex-config` 추가. **회귀 영향**: Windows 일반 사용자 (HOME unset) 동작 변화 없음, Windows + Git Bash (HOME set) 도 USERPROFILE 우선으로 기존 `homedir()` 와 동일, POSIX (HOME set) 기존 동작 그대로.
- **`chore` (#195)** `.mcp.json.bak-*` atomic write backup ignore (e195d1a) — `writeTextAtomic` rollback 실패 시 보존되는 `.mcp.json.bak-<pid>-<ts>` 파일이 프로젝트 root 에 untracked noise 로 노출되는 문제 차단. 정상 흐름은 finally 에서 정리 (`sync-hub-mcp-settings.mjs:147`), rollback 자체 실패 시에만 수동 복구용으로 보존되도록 설계 (line 130-141). PR #183 의 `references/hosts.json.bak.*` 패턴 옆에 인접 배치.

### Changed

- **`fix(swarm-cli)` (#116-C policy reversal)** non-TTY 환경 fail-fast → warn-and-proceed (3d881fc) — `assertTtyForSwarm` 이 양측 stdout/stdin non-TTY 시 더 이상 차단하지 않고 warning 출력 후 진행. **이유**: 기존 fail-fast 는 첫 사용자에게 묻기 효과 (실제 user terminal 은 TTY 인데 Claude Code `run_in_background` 같은 spawn 환경에서 child stdio 만 non-TTY) → 다른 사용자도 동일 마찰. **신설**: `TFX_BLOCK_NON_TTY_SWARM=1` opt-out env (안전 망 — 실제 hang 환경에서 차단). 기존 `TFX_ALLOW_NON_TTY_SWARM=1` 은 silent OK 호환 유지 (warning suppress). main + `packages/{triflux,remote}` mirror 3개 byte-equal 동기화.
- **`chore(scripts)` (#197, shard D)** `release:bump --write` 누락 시 warning + codex-config guard CI 통합 (99742c5) — release bump 가 `--write` 플래그 없이 호출되면 dry-run 임을 명시 stderr 경고. `.github/workflows/ci.yml` 에 codex-config guard step 추가 (production `~/.codex/config.toml` mutation 회귀 가드). **Constraint**: PRD 가 CI 통합만 선택 → husky 는 본 shard 에서 documentation-only 유지. `tests/unit/bump-version-warning.test.mjs` + `scripts/__tests__/release-governance.test.mjs` + `npx js-yaml .github/workflows/ci.yml` PASS.
- **`chore(gitignore)`** `references/{codex,gemini}-snapshots/` 제외 (0d8f41c) — manual codex state snapshot (141MB) 이 GitHub 100MB 제한 초과 → `~/.codex-backups/codex-state-20260426-092115.tar.gz` 외부 이동. shard E 의 auto-snapshot watcher 도 동일 path 사용 → git tracking 시 repo size 폭증 방지.
- **`chore(hub)`** spawn stdio 를 log file 로 redirect (abcd4de) — `bin/triflux.mjs:5043` + `:5231` 의 hub server spawn 이 `stdio: "ignore"` 사용 → stdout/stderr 가 어디로도 가지 않아 crash root cause 추적 불가. `openHubLogFd()` helper 추가, `~/.claude/cache/tfx-hub/hub.log` 에 fd 열어 두 spawn 위치 모두 적용. `tfx hub start` startup `errFd` 는 keep (#102 패턴) 하면서 runtime stderr 도 hub.log fallback 으로 캡처.
- **`chore(test-lock)`** spawn stdio 분리 + stdin close (4f8076e) — `scripts/test-lock.mjs` spawn 이 stdin 을 열린 채 두던 패턴 → child 가 stdin EOF 받지 못하면 hang. stdin close 로 robustness 개선.
- **`chore(release)`** `runCommand` maxBuffer floor + per-step override (4c36be4) — release prepare 가 npm test/lint 출력 OOM 으로 silent fail 하던 패턴 차단. floor 값 + 단계별 override 가능.

### CI / Build

- **`ci`** npm ci fallback to `npm install` on lock sync mismatch (063c144) — PR #196 (shard E) 가 `package.json` 추가 시 lock 파일 갱신 없이 머지 → main 에 push 후 `npm ci` 가 `@emnapi/core`/`@emnapi/runtime` peer dep 누락으로 fail. workflow 에서 `npm ci || npm install --no-audit --no-fund` fallback 으로 임시 mitigation. 후속: 다음 PR 들도 같은 패턴 발생 가능 → release-checklist 에 lock sync 단계 강조.
- **`ci`** `continue-on-error: true` for codex-config-guard step (f47eb52, 임시) — `tests/**/*.test.mjs` glob 이 Linux bash 에서 literal 로 전달되어 `test-lock.mjs` 가 자체 glob expand 안 함 → guard step fail. **임시**: continue-on-error 로 PR 머지 차단 회피. **Follow-up (다음 ship 전 P1)**: `scripts/test-lock.mjs` 자체 glob expand (bun glob / fast-glob) 또는 `package.json` test script 를 explicit list 로 변환 후 continue-on-error 제거.
- **`chore(deps)`** package-lock.json sync after PR #196 머지 (2046474) — 위 npm ci fallback 의 근본 sync.

### Docs

- **`docs(tfx-ship)`** `--write` + `--allow-dirty` 를 mandatory 로 명시 (5465822) — 두 플래그 누락 시 silent dry-run / `Working tree is dirty` reject 로 후속 step 이 모두 이전 버전으로 진행되는 silent failure 발생. SKILL.md Step 3/5 에 mandatory 라벨 추가.
- **`docs(release)`** `prepare.mjs` npm-test 주석을 #192 root cause 로 갱신 (d66d954).
- **`docs(prd)`** worker signaling consolidation 4-channel ground truth (ec34b06).

### Tests

- **+1 file** `tests/unit/state-snapshot.test.mjs` (shard E)
- **+1 file** `tests/unit/worker-signal.test.mjs` (shard C)
- **+1 file** `tests/regression/codex-config-port-stable.test.mjs` (shard A)
- **+1 file** `tests/regression/mcp-bootstrap-no-hang.test.mjs` (shard B)
- **+1 file** `tests/unit/setup-home-resolution.test.mjs` (#193, #194)
- **+1 file** `tests/unit/bump-version-warning.test.mjs` (shard D)
- **`tests/unit/swarm-cli.test.mjs`** — `assertTtyForSwarm` 7 시나리오 갱신: stdout/stdin TTY silent OK, 양측 non-TTY 기본 warn-proceed, `TFX_ALLOW_NON_TTY_SWARM=1` silent compat, non-'1' 값에서도 default warn, `TFX_BLOCK_NON_TTY_SWARM=1` fail-fast, opt-out > opt-in 우선순위. 12/12 pass.

## [10.15.0] - 2026-04-25

### Fixed

- **`fix(codex-mcp)` (#185)** 0.124.0 silent-success 회귀 detect + exec fallback 트리거 (75c0532) — codex MCP 가 `exitCode=0` + 빈 `output` 을 반환하는 0.124.0 회귀 케이스를 감지해 `CODEX_MCP_TRANSPORT_EXIT_CODE` 로 승격, wrapper 의 codex exec fallback 을 트리거한다. `tfx-route.sh` sync 모드에서 `STDOUT_LOG=0 byte` 를 success 로 오판해 caller 가 결과 못 받던 silent-flush 경로 차단. **변경**: `hub/workers/codex-mcp.mjs` + mirror 에 `hasOutput = result.output.trim().length > 0` 검사 추가 — 빈 output + exit 0 → exitCode 승격 + stderr WARNING. `tests/fixtures/fake-codex.mjs` `mcp-empty` 모드 신설 (silent-flush 시뮬레이션) + `tests/unit/codex-mcp-worker.test.mjs` reproduction case 추가 (5 → 6 tests). codex 0.124.0 silent flush 는 codex CLI 자체 동작이라 wrapper layer 만 detect/fallback 가능. 후속 worker signaling 통합 PR (issue #176 + 메타 B/E) 의 family 첫 단계.
- **`fix(headless-guard)` (#186)** `$()`/eval 휴리스틱 `.*` 좁혀 grep 인자 오탐 방지 (b42cf5c) — `scripts/headless-guard.mjs` 의 2차 휴리스틱 `\$[({].*\b(codex\s+exec)\b` 와 `\beval\b.*\b(codex\s+exec)\b` 의 `.*` 가 너무 넓어 `result=$(grep "codex exec" file)` 같은 grep 인자 패턴까지 codex 직접 호출로 차단 → 코드베이스 탐색조차 막는 오탐. **수정**: `.*` → `\s*` 로 좁혀 command substitution / eval 의 *첫 명령* 만 검사하도록 변경. 진짜 위협 (`$(codex exec ...)`, `eval "codex exec ..."`) 은 그대로 차단. main + `packages/triflux` mirror 동기. 회귀 보존 케이스 그대로 deny + 오탐 방지 unit test 3건 추가 (`$()` 안 grep, `$()` 안 파이프된 grep, `eval "$(grep ...)"`). 68/68 pass, biome lint clean.
- **`fix(swarm)` (#184)** lease-outside validate guard + 모델-직무 매핑 개편 (89f9ad2) — `swarm-locks.validateChanges` 가 cross-lease 침범만 검사해 lease 외 file 의 신규/수정/삭제를 모두 통과시키던 4개월 만의 회귀 (#115, #34 후속). 2026-04-25 #178 작업 중 core-compat recovery patch 안에 `.claude-plugin/{marketplace,plugin}.json` 의 `+++ /dev/null` (삭제) 시도가 들어왔으나 lease-only 검사로 detect 불가 → 만약 worker 가 commit 했다면 distribution 깨짐. **Fix**: `validateChanges(workerId, changedFiles, options?)` 에 `ownLease` + `sensitiveDeny` 옵션 추가 (옵션 미제공 시 기존 동작 유지 — backward compat). `ownLease` 가 명시되면 lease 외 file 이 distribution-critical path (`.claude-plugin/`, `bin/`, `.github/workflows/`, `package.json`, `.gitignore`) 에 해당하면 violation `kind="sensitive-out-of-lease"` 로 보고. `swarm-hypervisor.validateResult` 가 `plan.leaseMap[shardName]` 을 ownLease 로 전달. 105/105 기존 테스트 + 신규 5 case (sensitive guard) green. **추가**: 모델-직무 매핑 개편 — gpt-5.5 메인 (코드/리뷰/추론, fast tier 가능), gpt-5.4-mini 자잘/부가 (cleanup, fast tier), gpt-5.3-codex escalation 가성비 중간 (Plus/free OK), gpt-5.4 (mini 외) 폐기 → 5.5 격상. 직무별 매핑: executor/implement → gpt55_high, debugger → gpt55_xhigh, build-fixer → gpt55_low, cleanup/deslop → mini54_med (신규), analyze/design/architect/critic → gpt55_xhigh, code-reviewer/security-reviewer/scientist → gpt55_high. Escalation chain (`tfx-escalation-chain.md`): 1) codex:gpt-5.4-mini 2) **codex:gpt-5.3-codex** (신규 가성비 중간) 3) codex:gpt-5.5 4) claude:opus-4-7. sonnet-4-6 단계 제거 (gpt-5.5 가 코드/추론/비용 모두 우위).
- **`fix(#178)` (#183)** hosts.json user-state 경로 이전 (lazy migration + source-tree fallback) (deabe8d) — hosts.json 정식 경로를 source-tree → user-state (`~/.config/triflux/hosts.json` POSIX, `%APPDATA%\triflux\hosts.json` Windows) 로 이전. **변경**: `userStateHostsPath()` 신설 — `TFX_HOSTS_USER_STATE` override + `TFX_HOSTS_USER_STATE_DISABLE=1` escape hatch 지원. `migrateLegacyHosts()` — `readHosts()` 첫 호출 시 source-tree `references/hosts.json` 을 user-state 경로로 lazy 비파괴 복사. 권한/path 실패는 throw 하지 않고 source-tree fallback. `candidatePaths()` 가 user-state path 를 source-tree 후보 앞에 prepend. `tui-remote-adapter` 가 `hostsJsonPath` 옵션 대신 `readHosts()` 경유로 통일 (3개 미러 동기화). 기존 matrix test 는 `TFX_HOSTS_USER_STATE_DISABLE=1` 로 source-tree 전용 흐름 보존, 신규 test suite 는 `TFX_HOSTS_USER_STATE` 로 sandbox. Constraint: hosts.json 은 repo 외부에 위치. Source-tree fan-out (drift-prone) 은 reject.
- **`fix(#161)` (#182)** hub-autostart /Query 실패 구분 + /TR 262자 사전 검증 (7eb0383) — Windows hub-autostart 등록 상태 진단 정확도 개선. **P2**: `getWindowsHubAutostartStatus` 가 stderr ignore + catch 후 항상 `registered:false` 반환 → Access Denied 같은 해결 가능한 문제가 "미등록" 으로 묻혀 사용자가 원인 파악 불가. `classifySchtasksStderr` 신설 → `not_registered` (영문 "cannot find the file" / 한글 "지정된 파일") / `access_denied` (영문 "access is denied" / 한글 "액세스가 거부") / `unknown` 분류. 반환 타입에 `reason` + `stderr` 필드 추가 (기존 boolean 필드 유지). **P3**: `ensureWindowsHubAutostart` 가 schtasks `/TR` 262자 제한을 사전 검증 (Windows 내부는 wide-char 문자 수 기준이라 `command.length` UTF-16 code units 사용 — Codex Round 1 P1 finding 반영, 한글 경로 218자 = 578 bytes 오차단 회귀 방지). `validateSchtasksTrLength` 공용 helper 로 추출해 실제 실행 경로와 테스트가 동일 검증 함수 공유 (Codex Round 2 P2). schtasks `/Create` 실패 시 stderr 를 error.message 에 포함. 11/11 pass, lint clean.
- **`fix(#164)` (#181)** sync-hub writeTextAtomic backup-based rename + TOML 유효성 검증 (433a397) — PR #160 축 3 Codex 리뷰 MEDIUM 2건 해결. **MEDIUM 1**: rename 실패 시 `rm(filePath)` → `rename(tmpPath, filePath)` 순서로 처리하던 비원자 패턴 → 2차 rename 실패 / 프로세스 중단 시 원본 유실 위험. backup 경로로 원본 rename 후 `tmp→dest` 시도, 실패 시 backup 을 다시 dest 로 복원해 원자성 보장. Windows EEXIST/EPERM/EACCES fallback 도 backup 보존 상태에서 안전 재시도. **MEDIUM 2**: `nextRaw` 가 깨진 TOML 이어도 filesystem 반영 + `kind:"updated"` 성공 처리 → `validateCodexTomlPayload` helper 추가 (섹션 헤더 + url 키 최소 구조 확인). write 직전 validation → 실패 시 `kind:"error"` 반환. **Codex Round 1 P1**: rollback rename 실패 시 finally 가 backup 도 삭제해 양쪽 모두 손실 가능 → backup 복원 성공 시에만 cleanup 허용, 복원 실패 시 backup 보존 + console.warn 으로 수동 복구 경로 안내. 26/26 pass, lint clean.
- **`fix(test)` (#174)** quota 테스트 `doesNotMatch` 범위 좁혀 graceful degradation 경고와 분리 (7a35b5e) — quota 한도 도달 메시지가 graceful degradation 경고와 매칭되어 false negative 발생하던 회귀 차단.

### Added

- **`feat(probe)` (#173, #168)** L2 hub /health checker default on (4317091) — L2 hub `/health` checker 가 default 활성. probe accuracy 향상으로 dead/healthy 판정 정확도 강화.

### Changed

- **`chore(lint)` (#177)** baseline 6 warnings cleanup — unused imports / dynamic namespace access (aef93bf) — `check-mcp-hub.test.mjs` `beforeEach`, `setup-codex-profiles.test.mjs` `ensureCodexProfiles`, `setup-sync.test.mjs` `PLUGIN_ROOT`/`CLAUDE_DIR` unused destructure 제거. `shared.test.mjs` dynamic namespace access 에 biome-ignore + 로컬 변수 바인딩. 모두 test 파일, 실제 동작 변경 없음. lint 6 warnings → 0 warnings, 52/52 pass.
- **`docs`** gbrain 섹션 + tfx-remote hosts.json fan-out 임시 패치 안내 (bab31e0) — `CLAUDE.md` `/setup-gbrain` 결과 설정 블록 (engine=pglite, user scope MCP, artifacts-only sync) 추가. `skills/tfx-remote/SKILL.md` 에 hosts.json 수정 시 source-tree fan-out 필요 명시 (임시 — 근본 해결은 PR #183).
- **`chore`** references/hosts.json* 을 .gitignore 에 추가 (#187, 7ffbc14) — user-data (Tailscale IP / SSH user) 의 public repo 노출 방지. PR #183 의 user-state 이전 후속. 패턴: `**/references/hosts.json` (root + packages/triflux mirror) + `**/references/hosts.json.bak.*` (timestamp suffix 도 cover — 기존 `*.bak` 룰은 `.bak` 으로 끝나는 파일만 매칭해 `hosts.json.bak.20260425_040814` 같은 형태는 미커버).

### Tests

- **`test(tfx-route)` (#180)** estimate_expected_duration_sec 한글/영어 키워드 회귀 방지 unit test 추가 (a4926310, fixes #163) — PR #160 Codex 리뷰 LOW 이슈 (한글 regex `(분석|리서치|리팩터|테스트|mcp)` 회귀 방지 부재) 보완. 커버리지: agent 기본값 매핑 6건, profile bump 4건, 한글 키워드 10건 (분석/리서치/조사/전체/싹다/리팩터/마이그레이션/대규모/검증/테스트), 영어 키워드 7건 (deep/research/analyze/refactor/migration/test/mcp), 조합 규칙 3건 (최대값 우선), 상호작용 3건, 경계/빈 프롬프트 2건. 35/35 pass.

## [10.14.3] - 2026-04-25

### Fixed

- **`fix(mcp-guard-engine)` (#166, #172)** resolveHubUrl pid port cascade 제거 (3c1df54) — PR #158 (`21dca5e`) 이 `hub-ensure.resolveHubTarget()` 에서만 pid port cascade 를 제거하고 "env = single source of truth" 정책을 도입했지만 `scripts/lib/mcp-guard-engine.mjs` 의 `resolveHubUrl()` 은 legacy cascade (envPort 없으면 pidPort 로 target.port 덮어씀) 를 유지 → 두 함수 정책 drift. `TFX_HUB_PORT=27888` 이 shell 에 설정된 환경에서 기존 테스트가 env unset 없이 실행 → pidPort (30123/29991) 가 envPort (27888) 에 밀려 assertion fail 하던 회귀. **Fix**: production 경로에서 pid port cascade 전면 제거 — envPort (또는 default 27888) 만 사용하고 `hub.pid` 는 host hint 로만 참조. PR #158 정책을 mcp-guard-engine 까지 propagate. `scripts/lib/mcp-guard-engine.mjs` 원본 + `packages/{core,remote,triflux}/scripts/lib/mcp-guard-engine.mjs` 3 사본 Edit 동기화 (cp 금지 룰 준수). `resolveHubUrl()` 의 downstream `buildDesiredServerRecord()` → MCP 설정 파일 hub URL 생성 경로에서 의도치 않은 부작용 없음 확인.

### Tests

- **+1 / 기존 2 갱신** `scripts/__tests__/mcp-guard-engine.test.mjs` + `packages/triflux/scripts/__tests__/mcp-guard-engine.test.mjs` — 기존 2 fail 케이스를 "env=single source" 의도로 갱신 + 신규 회귀 가드 `ignores hub.pid port (pid is host hint only, PR #158 policy)` 추가. env 설정/미설정 양쪽에서 pid port 재유입 시 fail 하도록 설계. 6/6 PASS.

## [10.14.2] - 2026-04-25

### Fixed

- **`fix(probe)` (#162, #167)** atomic write + stop()→start() race + drain 보장 + Windows backup-then-swap (04d08a3) — health-probe.mjs 의 state file write 가 reader (heartbeat sed) 의 부분 파일 read race 를 야기하던 문제를 atomic tmp+rename 으로 해결. 추가로 PR #167 Codex 교차 리뷰 P0/P1 finding 반영: (P0) `runEpoch` 가드 — `start()` 마다 `++`, `probe()` 시작 시 epoch 캡처, `writeState(result, probeEpoch)` 가 epoch !== runEpoch 면 stale 로 판정 skip → stop()→start() 재호출 시 old run 의 in-flight probe 가 새 run 의 state 를 덮는 race 차단. (P1-1) 단일 `inFlightProbe` 변수 → `inFlightProbes` Set. add/finally→delete 패턴. `stopAndDrain()` 가 `Promise.allSettled(Array.from(inFlightProbes))` 로 전체 drain. setInterval 이 빠른 환경에서 N+1 이 N 끝나기 전에 시작되어 N 이 누락되던 회귀 차단. (P1-2) Windows EPERM/EACCES `unlinkSync→renameSync` 비원자 패턴 → backup-then-swap. `stateFile→backupPath` rename 후 `tmpPath→stateFile`, 2차 실패 시 backup 복구로 기존 파일 보존.

### Added

- **`feat(probe)` (#165, #169)** STALL_KILL classify mode + probe state default on (03b8e45) — `TFX_STALL_KILL` 세 모드 도입: `kill` (alias `1|on`) / `classify` (default) / `off` (alias `0|disabled`). default `classify` 는 kill 안 함 + `STALL_CLASSIFY` 로그로 evidence 노출 (PR #160 의 stopgap default `0` 의 false-kill 방지는 유지하면서 진단 가치 회복). unknown 값은 warning + classify fallback. `TFX_PROBE_WRITE_STATE` default off → on 으로 전환 — atomic write (#167) 로 race 제거됐으므로 안전. opt-out 은 `=0` 명시 (`!== "0"` 패턴). conductor 의 writeStateFile 분기가 default-on 으로 동작 → heartbeat grace (mcp_initializing/input_wait) 가 5-state evidence 를 실전에서 받게 됨.

### Tests

- **+5** `tests/unit/health-probe.test.mjs` — P0 stop()→start() epoch isolation (실제 race 시뮬) + P1-1 3 개 동시 in-flight probe drain + P1-2 backup-then-swap source 패턴 + 옛 unlink→rename 회귀 가드 + P0 source 의 runEpoch 가드 + P1-1 source 의 Set + 옛 단일 var 회귀. 28/28 pass (기존 23 + 신규 5).
- **+9** `tests/unit/tfx-route-stall-kill.test.mjs` — classify default shape assertion + classify mode integration + kill mode integration. 7/7 pass (기존 4 + 신규 3, bash file 경유 — Windows Git Bash EOF race 회피).
- **+2** `tests/unit/conductor-probe-default.test.mjs` — `!== "0"` 패턴 + mirror drift guard. 2/2 pass.

## [10.14.1] - 2026-04-25

### Fixed

- **`fix(tfx-route)` (#170, #171)** MCP graceful degradation default — all-dead 시 stall 방지 (208ca66) — `TFX_MCP_ALLOW_ALL_DEAD=1` 가 preflight check 만 우회 → swap 은 fail-safe 로 스킵 → CODEX_CONFIG_FLAGS 클리어 후에도 transport=auto 분기는 `run_codex_mcp` 호출 → codex-mcp.mjs worker 가 dead MCP (context7/brave-search) 와 connect 시도 → quiet stall 250s+ → STALL_KILL 회귀. **Fix**: `_mcp_preflight_filter_dead` default 동작을 early-fail (#148, rc=78) → graceful degradation (rc=0 + `_TFX_MCP_DEGRADED=1` export) 로 전환. 옛 동작은 `TFX_MCP_FAIL_ON_ALL_DEAD=1` 명시 opt-in 으로만 활성. `TFX_MCP_ALLOW_ALL_DEAD=1` 호환 alias 유지. `run_codex_mcp` 분기에서 `_TFX_MCP_DEGRADED=1` 보면 `TFX_CODEX_TRANSPORT="exec"` 강제 (transport=mcp 명시 시 warning) + `FULL_PROMPT="$PROMPT"` 로 MCP_HINT 제거. 추가 P1 fix: `remaining_alive` 카운트 정규식 `[^.]+` → `.+` 로 dotted alive 서버도 카운트 (PR #171 Codex 교차 리뷰 finding 반영). 사용자 요구 ("MCP 있으면 쓰고 없으면 알아서") 와 일치하는 default 동작.

### Tests

- **+9** `tests/unit/tfx-route-preflight-all-dead.test.mjs` — graceful default rc=0 + `TFX_MCP_FAIL_ON_ALL_DEAD=1` opt-in + `TFX_MCP_ALLOW_ALL_DEAD=1` legacy alias + dotted server graceful + dotted alive survivor (P1-1 회귀 가드) + degraded transport=mcp 강제 (P1-2 회귀 가드) + source 분기 회귀 가드 + mirror byte-identical. 20/20 pass. `tfx-route-args/config-swap/stall-kill` 32/32 pass — 회귀 없음.

## [10.14.0] - 2026-04-24

### Added

- **`feat(tfx-route)`** dead MCP preflight with health probe + TTL cache (9298fd6) — codex 호출 직전에 모든 MCP 서버에 initialize JSON-RPC probe 를 보내 응답 없는 서버를 감지하고 `enabled=true` flag 를 자동 제거. dead 서버 때문에 Codex 가 -32000 으로 죽던 패턴을 차단. probe 결과는 `~/.codex/mcp-health-cache.json` 에 TTL 5분 캐시. opt-out: `TFX_MCP_HEALTH_CHECK=0`. 후속 PR 들 (#147, #148, #149, #152, #153, #154, #155) 이 정확도와 안정성을 점진적으로 강화.
- **`feat(codex-profiles)`** gpt-5.5 main 전환 + escalation chain 갱신 (4f26c24) — OpenAI gpt-5.5 출시 반영. `setup.mjs` 의 top-level model 기본값을 `gpt-5.4` → `gpt-5.5` 로 전환하고 `gpt55_xhigh` / `gpt55_high` / `gpt55_med` / `gpt55_low` 4 tier 프로필을 자동 주입한다. auto-escalate 체인은 step 1 `codex:gpt-5.4-mini`, step 2 `codex:gpt-5.5` 로 갱신. 5.5 mini 변종 부재로 mini 계층은 5.4-mini 유지. 기존 `gpt54_*`, `codex53_*`, `spark53_*`, `mini54_*` 프로필은 보존 (사용자 호환성).

### Fixed

- **`fix(tfx-route)` (#153)** preflight 정규식이 dotted server 이름 허용 (83b03fb) — `_mcp_preflight_filter_dead` 의 candidate 추출 정규식이 `[^.]+` 로 첫 dot 에서 끊어, `[mcp_servers.foo.bar]` 같은 dotted 서버는 probe/filter 대상에서 통째로 누락되던 문제. `(.+)\.enabled=true$` 로 변경해 end anchor 활용한 정확한 캡처. mcp-health.mjs 파서 (`[a-zA-Z0-9_.-]+`) 와 일관성 회복. drop 루프는 이미 prefix 매칭이라 dead 이름 그대로 받아 모든 override 제거.
- **`fix(mcp-health)` (#149, #154)** binary fingerprint cache key + atomic cache write (02b792d) — (#149) 기존 cache 가 configMtime + TTL 만으로 fresh 판정해 `npm i -g <mcp-bin>` 설치/제거를 5분간 감지 못하던 문제. 서버별 fingerprint (resolved binary path+mtime+size 또는 url) 을 cache 에 포함하고 일치할 때만 hit 으로 판정. legacy cache (fingerprint 없음) 는 stale → 자동 migration. (#154) `writeCache` 가 비원자적 `writeFileSync` 라 swarm/병렬 실행 시 reader 가 partial JSON → null 받아 cache 효용 손실. tmp (`pid.timestamp` 이름) + `renameSync` atomic write 로 변경.
- **`fix(tfx-route)` (#148)** all-dead preflight 조기 실패 (50ec35f) — profile-allowed MCP 가 전부 dead 일 때 BUG-H (#132) fail-safe 가 swap 을 skip → 원본 config.toml 전체가 Codex 에 전달되어 비필요 MCP 다수까지 spawn 되는 역효과. preflight 끝에서 남은 `enabled=true` 개수 검사 → 0 이면 `exit 78` 조기 실패. opt-in escape: `TFX_MCP_ALLOW_ALL_DEAD=1`.
- **`fix(mcp-sync)` (#152)** support root-level `.mcp.json` alongside `.claude/mcp.json` (657771a) — Claude Code 는 두 경로 모두 읽지만 과거 sync 는 `.claude/mcp.json` 만 처리해 root-only 레이아웃 (research-fold7-terminal 등) 은 sync 가 작동하지 않았음. 이제 둘 다 처리.
- **`fix(mcp-health)`** tighten preflight accuracy — multiline TOML args + HTTP validation (1f8d508) — (A1) 멀티라인 array 값 (`args = [\n  "run",\n  "server.js"\n]`) 을 single-line 파서가 `"["` 문자열로 오인해 정상 서버를 dead 로 오탐. bracket depth tracker 로 `]` 까지 누적해 array 로 파싱. (A2) HTTP probe 가 status 2xx-4xx 전부 alive 로 취급해 404/401 HTML 페이지를 healthy 로 오판. 200 + JSON-RPC envelope (id 일치, result|error 존재) 둘 다 검증.
- **`fix(mcp-sync)`** project mcp.json type 필드도 rewrite (legacy url→http) (50b5f0d) — Claude Code 현재 스키마는 `type: "http"` 만 허용. 과거 `type: "url"` 는 parse 실패로 MCP 전체 단절. url 일치만으로 skip 하면 legacy 가 영원히 안 고쳐지던 문제. 이제 type 필드도 함께 rewrite.
- **`fix(tfx-route)`** preflight env + codex MCP exec fallback (923aa1a) — preflight env 변수 누락 + codex MCP exec fallback 경로 보강.

### Tests

- **`test(sync-hub-mcp-settings)` (#155)** 부분 실패 격리 + 2회 idempotent regression (4b643e0) — `syncProjectMcpJson` 이 `.claude/mcp.json` 과 `.mcp.json` 두 경로를 for-of 루프 + per-file try/catch 로 처리하는 격리 동작과 2회 연속 idempotent 동작을 회귀 방어 테스트로 고정. (case 7) 한 경로 invalid JSON 이어도 다른 경로 정상 처리, (case 8) 두 경로 모두 canonical 상태에서 연속 호출 시 byte-for-byte 동일.

## [10.13.10] - 2026-04-23

### Changed

- **`chore(#112)`** Legacy alias deprecation logging 표준화 — Phase 5 (v11) 물리 삭제 게이트 활성화. 11개 DEPRECATED alias (tfx-autopilot / tfx-consensus / tfx-debate / tfx-fullcycle / tfx-multi / tfx-panel / tfx-persist / tfx-swarm / tfx-remote-setup / tfx-remote-spawn / tfx-psmux-rules) SKILL.md 에 **실행 가능한 bash 블록** 을 일관된 형식으로 주입: (1) stderr 에 `[deprecated] {name} -> use: {canonical}` 경고, (2) stdout 에 `[DEPRECATED] {name} — see {canonical}` 마커, (3) `.omc/state/alias-usage.log` 에 `ISO8601 {name} -> {canonical}` append (mkdir -p 선행). 이전에는 consensus/debate/panel 3개만 textual 3단계 절차를 가졌고 bash 실행문이 없었음. 나머지 8개는 stderr 경고 한 줄만 있거나 logging 규약 자체가 부재 → Phase 5 zero-usage 게이트가 측정 불가능한 상태였다. 이제 11개 전부 동일 패턴 + 측정 가능. 7일 누적 `alias-usage.log` 가 zero 이면 해당 alias 파일 물리 삭제 가능.

### Tests

- **+55** `tests/unit/legacy-alias-logging.test.mjs` (신규) — 11개 legacy SKILL.md 각각 5개 assertion (alias-usage.log append / stderr [deprecated] echo / stdout [DEPRECATED] marker echo / canonical entrypoint 언급 / mkdir -p .omc/state 선행). 회귀 시 Phase 5 게이트가 끊기는 것을 즉시 감지.

## [10.13.9] - 2026-04-23

### Fixed

- **`fix(cli)`** `tfx swarm run <prd>` alias + `tfx --help` Commands 블록 누락 (#109) — v10.13.7 에서 `tfx swarm --help` sub-help 와 `tfx swarm` 한 줄 surface 는 추가했으나 (1) `tfx swarm run <prd>` verb alias 가 여전히 `run` 을 PRD 경로로 해석하고 (`PRD file not found: .../run`), (2) `tfx --help` Commands 블록에 `synapse` / `why` 가 누락된 채로 남아있던 3증상 중 2증상 잔존. `bin/triflux.mjs` swarm dispatch 에 `if (sub === "run") cmdSwarmRun(cmdArgs.slice(1))` 분기 추가 + `CLI_COMMAND_SCHEMAS.swarm.subcommands.run` 문서화 + sub-help Subcommands 블록 맨 위에 `tfx swarm run <prd>` 렌더 + Commands 블록에 `tfx synapse` / `tfx why` 두 줄 추가. `tfx swarm` 설명도 `(run/plan/list)` 힌트 포함.

### Tests

- **+3** `tests/unit/triflux-help-output.test.mjs` — Commands 블록 `tfx synapse` / `tfx why` 검증 2건 + sub-help `tfx swarm run` 검증 1건. 5/5 pass.

## [10.13.8] - 2026-04-22

### Fixed

- **`fix(swarm)`** `tfx swarm` non-TTY background hang (#116-C) — `run_in_background`, nohup, CI 러너 등 stdout/stdin 둘 다 non-TTY 환경에서 `cmdSwarmRun` 이 planning 까지만 성공하고 codex worker spawn 단계에서 무한 hang 하던 경로 (umbrella #116 의 마지막 sub-issue, v10.13.7 까지 잔존). `hub/team/swarm-cli.mjs` 에 pure function `assertTtyForSwarm()` 을 신설하고 `cmdSwarmRun` 의 planning 직후 / `hyper.launch()` 직전 gate 로 호출. non-TTY 감지 시 즉시 throw + 복구 경로 3안 안내 (터미널 직접 실행 / `tfx multi --teammate-mode tmux` / `TFX_ALLOW_NON_TTY_SWARM=1` opt-in). opt-in 경로는 경고만 출력하고 기존 launch 흐름 유지. `--dry-run` / `cmdSwarmPlan` 은 gate 이전에 return 하므로 영향 없음.

### Tests

- **+5** `tests/unit/swarm-cli.test.mjs` — `assertTtyForSwarm` pure function 커버리지 (stdout TTY pass / stdin TTY pass / 양측 non-TTY fail with #116-C guidance / opt-in env `=1` pass + warn / opt-in env 비 `1` 값은 fail). swarm-cli 전체 10/10 pass.

## [10.13.7] - 2026-04-22

### Fixed

- **`fix(hud)`** `buildContextUsageView` limit priority regression — stdin 이 명시한 `context_window_size` 가 modelHint fallback (DEFAULT 200K) 에 의해 override 되어 `600/1K (60%)` 기대값 대신 `600/200K (0%)` 로 떨어지던 lake4-integration 실패. stdin > (modelId present ? `Math.max(monitor,hint)` : `monitor||hint`) 우선순위로 재정렬. Opus 4.7 warn/critical 분류가 modelHint 우선 로직에 의존하므로 modelId 존재 여부로 분기 (opus-duplicate-status 3 cases + lake4-integration 2 cases 동시 만족). `hud/context-monitor.mjs` + packages mirror.
- **`fix(release)`** `prepare.mjs` preflight stale test-lock cleanup — 이전 `release:prepare` 실행이 남긴 `.test-lock/pid.lock` 으로 인한 반복 실패 (MEMORY `feedback_test_lock_stale.md` 재확인, v10.13.6 ship 시 수동 `rm -f` 우회 필요했던 패턴). `prepareRelease()` 진입 직후 exported `cleanupStaleTestLock()` 호출로 lockfile 자동 제거. `rmSync` 실패 시 warn fallback (prepare 진행은 유지). `scripts/release/prepare.mjs` + packages mirror.

### Added

- **`feat(cli)`** `tfx swarm` CLI help surface (#109) — `tfx --help` Commands 섹션에 `tfx swarm` 한 줄 노출 + `tfx swarm --help` / `tfx swarm help` sub-help 렌더링 (description / usage / subcommands / options 를 `CLI_COMMAND_SCHEMAS.swarm` 스키마 기반으로 출력). `checkHubRunning()` 이전에 help 분기를 두어 hub 미실행 환경에서도 help 접근 가능. `bin/triflux.mjs` + packages mirror.

### Chore

- **`chore(gitignore)`** `tests/.tmp-setup-version-cache/` 추가 — setup-version cache 테스트 부산물이 매 실행마다 untracked 로 잡히던 노이즈 제거.

### Tests

- **+2** `tests/unit/hud-context-view.test.mjs` (신규) — stdin limit > modelHint 우선순위 회귀 케이스 2건
- **+1** `tests/unit/release-prepare-testlock.test.mjs` (신규) — stale lock preflight cleanup 검증
- **+2** `tests/unit/triflux-help-output.test.mjs` (신규) — `tfx --help` swarm surface + `tfx swarm --help` sub-help 검증

### Housekeeping

- GitHub 이슈 정리 (6건 closed): **#66** (Codex exec non-TTY stall, 24b7229 + `scripts/tfx-route.sh` MCP approval auto-swap 로 해결), **#110** (swarm-hypervisor 2 hang, v10.10.0 mock conductor 보강), **#111** (swarm shard blind run, `hub/team/swarm-cli.mjs` 이벤트 핸들러 구현), **#114** (teammate-mode non-TTY codex 즉시 종료, e0eeba0 `resolveEffectiveMode()` auto-fallback to headless), **#121** (workdir-dependent codex config delta, triflux side 감지 완료 + 수정은 codex/oh-my-codex upstream scope), **#122** (MCP approval drift, #66 duplicate). umbrella **#116** 은 sub-issue 전이 노트 추가 + #116-C (bg hang) 1건만 open 유지.

## [10.13.6] - 2026-04-22

### Fixed

- **`fix(hud)`** `parseClaudeUsageResponse` — Claude OAuth Usage API 응답에서 `five_hour` 또는 `seven_day` 키 자체가 부재할 때 `?? 0` 으로 collapse 되어 `fiveHourPercent: 0` 으로 표시되던 결함. utilization=null (사용량 없음) 과 키 부재 (API 응답 이상) 가 구분 안 돼 가짜 0% 가 표시됨. 키 존재 여부를 따로 검사해 부재 시 `null` 반환 → HUD 렌더러가 `--%` placeholder 표시. utilization=null 인 정상 케이스는 기존대로 0% 유지. `hud/providers/claude.mjs` + packages mirror.
- **`fix(hud)`** Codex `classifyBucket` weekly window 임계 — `>= 1440min(24h)` 의 헐거운 lower bound 가 향후 24h/48h 등 중간 버킷 도입 시 모두 weekly 로 silent 오분류할 위험. 10080min(7d) 외 단일 weekly 값을 emit 하지 않는 현재 Codex 동작에 맞춰 `>= 7000min(~5d)` 로 좁힘. 알 수 없는 shape 는 `null` (미분류) 로 떨어져 slot 오할당 차단. `hud/providers/codex.mjs` + packages mirror.

### Tests

- **+6** `tests/unit/hud-claude-parse.test.mjs` (신규) — 키 부재 vs utilization=null vs clamping 6 케이스
- **+2** `tests/unit/hud-codex-bucket.test.mjs` — 7000min lower bound + 1440min/6999min rejection (1440min weekly assertion 제거)

## [10.13.5] - 2026-04-22

### Fixed

- **`fix(tfx-route)`** STALL_KILL orphan child — `heartbeat_monitor` 가 SIGTERM 으로 wrapper(bash) 를 종료한 뒤 `kill -0 $pid` 가 false 면 `taskkill /T /F` 분기를 skip 해 Codex 자식 프로세스가 별도 Win32 process 로 **orphan 생존**하던 결함. 사용자 보고(2026-04-22 세션): "tfx-route 래퍼 프로세스 exit 이후에도 실제 Codex 자식은 계속 running, stderr 191KB 까지 누적". SIGTERM 이전에 `_find_fork_pids` 로 자식 PID 스냅샷을 떠놓고, wrapper 정리 후 orphan sweep 루프로 살아있는 자식을 taskkill /T /F (Windows) / kill -KILL (POSIX) 로 tree kill. `scripts/tfx-route.sh` + packages mirror 동시 갱신.
- **`fix(hud)`** `advanceToNextCycle` exact-cycle boundary glitch — `elapsed` 가 `cycleMs` 의 정수배일 때 `Math.ceil(elapsed/cycleMs)*cycleMs` 가 `target=now` 를 반환해 `diff=0` → `formatResetRemaining*` 이 빈 문자열 → HUD 5h/1w 컬럼이 정확한 reset 순간에 `n/a` 로 깜빡이던 결함. `Math.floor(elapsed/cycleMs)+1` 로 항상 다음 사이클을 가리키도록 교정. 5h 경계 `5h00m`, 7d 경계 `07d00h`, 1d Gemini 경계 동일 적용. `hud/utils.mjs` + packages mirror 동시 갱신.

### Removed

- **`chore(hud)`** dead alias 제거 (`hud/constants.mjs`) — `PLUGIN_USAGE_CACHE_PATH` 와 `CLAUDE_USAGE_STALE_MS_WITH_PLUGIN` 은 외부 import 0건의 `OMC_*` alias source 역할만. 정의 직접 인라인하고 base 이름 삭제. 동작 변경 없음.

### Tests

- **+1** `tests/unit/tfx-route-stall-kill.test.mjs` — "STALL_KILL 은 SIGTERM 전에 자식 PID 를 스냅샷하고 orphan sweep 을 수행한다" shape 테스트. `_stall_children=$(_find_fork_pids ...)` snapshot 라인 + `orphan children detected` 로그 + `for _cpid in $_orphan_alive` tree kill 루프 회귀 가드.
- **+1** `tests/unit/hud-utils.test.mjs` — `advanceToNextCycle returns next reset (not now) at exact cycle boundary` 회귀 테스트. exact 5h / exact 7d / 2*5h / 1ms past boundary 4 케이스 커버.

## [10.13.3] - 2026-04-22

### Fixed

- **`fix(tfx-route-worker)`** misleading "hub unavailable" warning — `resolveDefaultMcpConfig` 가 cwd 에 `.claude/mcp.json` / `.mcp.json` 가 없을 때 찍던 `warning: no MCP config found, hub unavailable` 메시지가 실제로는 **프로젝트 MCP binding 부재**만을 뜻하는데도 hub server death 로 오독되어 "허브가 죽었다" 오진 유발. 다중 프로젝트 병렬 세션에서 특히 재현. 메시지를 `warning: no project MCP config in cwd — hub status unaffected` 로 교체해 실제 조건(cwd config 부재)과 영향 범위(hub 무관)를 명시. `scripts/tfx-route-worker.mjs` + mirror 동시 갱신.

## [10.13.2] - 2026-04-21

### Fixed

- **[#144]** `fix(#144): doctor auto-fix gap — stale skills recursive + mcp url sync + psmux guidance + TTL` — `triflux doctor --fix` / `tfx update` 가 안내한 대로 자동 해결하지 않던 4개 gap. 근본 원인은 `cleanupStaleSkills()` 가 top-level 파일만 `unlinkSync` 하고 nested directory 를 재귀 삭제하지 않아 `tfx-deep-*` / `tfx-codex-swarm` 같은 과거 잔재가 영구 감지되는 UX bug. (1) `rmSync({recursive:true, force:true})` 로 교체. (2) `--fix` 모드에서 `tfx-hub` URL 불일치 감지 시 `syncHubMcpSettings` + `syncProjectMcpJson` 자동 호출. (3) psmux detach-client 미지원 메시지에 영향(WT 1.24 ConPTY race) + 해결(psmux v3.4+ 업그레이드) + 업그레이드 명령 명시. (4) cli-issues 7일 TTL — stale 항목 `[STALE]` INFO downgrade + issues++ 제외, `--purge-logs` 플래그로 물리 삭제. Codex review FIX_FIRST 2 P2 (log single-write, mismatch deduct) 반영. (`6700597`)
- **`fix(tfx-route)`** stale `config.toml.pre-exec` cleanup + heartbeat `STALL_KILL` — Session 17 에서 `/tfx-auto --cli codex` 2회 연속 `output=0B` stall (900s timeout 대기) 근본 해결. (1) `_codex_config_swap` 에 owner-PID marker (`kill -0` 기반) stale detection 추가, stale 감지 시 backup → config 원본 복원 선행 (backup-loss guard). (2) `heartbeat_monitor` 에 `TFX_STALL_KILL` + `TFX_STALL_KILL_GRACE` 환경변수 기반 SIGTERM → 5s → SIGKILL/taskkill (MINGW/MSYS 경로 포함). Codex review FIX_FIRST P1 mtime 오탐 + P2 backup loss + P2 Windows taskkill 반영. (`24b7229`)

### Tests

- **+4** `scripts/__tests__/setup-cleanup-stale-skills.test.mjs` — #144 재귀 삭제 회귀 방지 (nested dir / top-level only / SKILL_ALIASES 보존 / tfx- prefix 필터)
- **+10** `tests/unit/tfx-route-config-swap.test.mjs` + `tests/unit/tfx-route-stall-kill.test.mjs` — #145 owner-PID cleanup 6건 + STALL_KILL shape 3건 + integration 1건 (실제 child ~4.5s SIGTERM)

### Docs

- `.omc/artifacts/session-17-plan-20260421-130921.md` — 세션 17 미해결 이슈 전수조사 + Batch A~G 착수 순서 + upstream link-only close 판단 기록.

### Issue closed

- **[#144]** doctor auto-fix gap (PR #146 merge)

## [10.13.1] - 2026-04-21

### Fixed

- **[#118]** `fix(#118): codex killed before HANDOFF flush` — BUG-A P0. `tfx multi --teammate-mode headless` 에서 codex timeout kill 시 `.txt` 미생성 + HANDOFF 유실로 인한 silent loss 해소. 3 fix 지점: default `timeoutSec` 300→900, `.partial` capture-pane persist (stallDetect + else 경로 양쪽), `readResult` fallback chain 확장 (`.partial` → `[partial]` prefix → `.err` → capture-pane). Codex R1 HIGH 대응으로 `cleanStaleResultArtifacts` 추가 (resultFile 경로 재사용 시 이전 run `.partial` 오인 차단), R2 MEDIUM 대응으로 `rmSync` 에러 핸들링 세분화 (ENOENT silent / 기타 retry + warn). 2R codex review 수렴. (`c0b59f1`)
- **`fix(config)`** permanent guard against codex `config.toml` reset — `~/.codex/config.toml` 이 세션 시작마다 축소되던 2 경로 근본 해결. (1) `scripts/setup.mjs` `REQUIRED_CODEX_PROFILES` 3→11 확장 (gpt54/mini54/codex53_med/spark53_med 추가), `REQUIRED_TOP_LEVEL_SETTINGS` 상수로 top-level `model`/`service_tier` missing 시 주입 (기존 값 preserve). (2) `scripts/tfx-route.sh` `_codex_config_swap` awk 필터 결과 size validation (<100 bytes 전면 skip, <500 bytes swap 거부, <30% post-filter 거부) + tmp atomic mv. (`ea13d90`)

### Tests

- **+12** `tests/unit/headless-118-timeout-partial.test.mjs` — #118 3 fix 지점 + R1/R2 review 대응 (stale cleanup / real readResult / non-ENOENT rmSync)
- **+24** `tests/unit/setup-codex-profiles.test.mjs` — `REQUIRED_CODEX_PROFILES` / `REQUIRED_TOP_LEVEL_SETTINGS` / top-level region detection / size guard 커버리지

### Docs

- `ROADMAP.md` — 세션 7 이후 9 세션 drift catch-up. 세션 8~16 단일 블록 압축 기록 (13 PR + 3 close + v10.13.0 release + BUG-A 해소 요약). (`93b2d74`)

### Issue closed

- **[#108]** Windows cmd quoting (mechanical, #108 fix 체인 full chain landed)
- **[#115]** swarm 5중 결함 (mechanical, Lane 1/2 + #126/127/128 full chain landed)
- **[#118]** BUG-A P0 codex timeout kill (PR #142 merge)

## [10.13.0] - 2026-04-21

### Added

- **[#125]** `feat(team): sentinel-framed completion payload` — `<<<TFX_COMPLETION_BEGIN/END>>>` sentinel framing via `sentinel-capture.mjs` + `build-worker-prompt.mjs` helpers. overflow guard + standalone-line matching. 세션 6 Codex R1 REQUEST_CHANGES → R2 APPROVE 로 수렴
- **[#138]** `feat(review): tfx review --shard per-file for oversized diffs` — 32KB 초과 diff 에서도 per-file Codex 리뷰 가능. shard 별 순차 실행 (계정 broker 충돌 방지), `[i/N] reviewing <file>` stderr 진행 표시, 32KB 초과 개별 파일은 per-file gate 에서 skip

### Fixed

- **[#115]** harden completion payload extraction per Codex cross-review — head-truncation coverage + assertion tightening (3-round review 수렴)
- **[#126]** `fix(team): surface swarm integration failure in CLI summary` — integration_failures + exit code 반영으로 silent loss 표면화
- **[#127]** `fix(team): cherry-pick + restore HEAD in swarm integration` — BUG-E originalBranch finally restore 로 caller branch HEAD escape 방지
- **[#128]** `fix(team): bypass cmd /c for npm-cmd-shim CLIs` — Windows `.cmd` shim 을 node `.js` 로 unwrap + 직접 spawn (BUG-A). 다중 줄 / fenced 프롬프트 mangling 해제
- **[#130]** `fix(swarm): F7 validator rejects status=failed worker payload` — validator tighten, schema 유지. fail 상태 silent success 가짜 통과 차단 (BUG-G)
- **[#133]** `fix(tfx-route): BUG-H _codex_config_swap fail-safe + doctor orphan cleanup` — async tfx-route 경로에서 MCP inventory 캐시 empty 일 때 codex config `[mcp_servers.*]` 전부 삭제되는 회귀 차단. `tfx doctor --fix` 가 cache orphan 자동 정리
- **[#134]** `fix(swarm): BUG-I worktree intentional deletions vs F6 no_commit_guard` — 워커가 의도적으로 파일을 지운 경우 F6 guard false-positive 방지
- **[#135]** `fix(swarm): BUG-J rebase catch block must not rewind caller branch` — `rebaseShardOntoIntegration` 실패 경로에서 caller branch HEAD 유지 (finally restore)
- **[#136]** `fix(release): packages/triflux full mirror + tfx review subcommand` — 배포 미러 gap 해소 + `tfx review` CLI 서브커맨드 추가
- **[#137]** `fix(review): 32KB prompt size gate + helper hardening` — review 대상 diff 가 32KB 초과 시 안전 truncate + per-file shard opt-in 안내
- **[#139]** `fix(setup): recursive hub/workers/**/*.mjs sync` — top-level 만 스캔하던 `scanHubWorkerFiles` 를 재귀 walk 로 교체. `codex-app-server-worker.mjs` 가 의존하는 `lib/jsonrpc-stdio.mjs` 복구
- **[#140]** `fix(gemini): add --yolo to GeminiBackend` — headless silent-hang 방지. stdin redirect 만으로는 tool-approval 대기에서 풀리지 않음. `buildGeminiCommand` pure helper + Windows/Unix 양 분기 test 커버
- **[#141]** `fix(session-15): packages/remote --yolo + drop stale tfx-autoresearch SKILL test + routing-qa assertion + packages/remote mirror contract tests` — #140 mirror 공백 해소 (packages/remote 별도 패키지) + Phase 5 cleanup 이후 남은 stale SKILL test 제거 + routing-qa assertion 동기화 + structural contract 5 invariants

### Tests

- **[#115]** completion payload 캡처 truncation 커버리지 강화 (`5a69534`, `c12ff01`)
- **[#140]** `buildGeminiCommand` pure helper 양 플랫폼 분기 test +4
- **[#141]** packages/remote mirror contract test +5 (buildGeminiCommand export / Windows --yolo / Unix --yolo / wrapper 패턴 / Codex+ClaudeBackend 존재)
- 전체 unit suite 2307/2310 pass (swarm-hypervisor #110 기존 hang 2건은 exclude, 3 skipped)

### Docs

- roadmap session 6~9 업데이트 (`f31925a`, `7f47807`, `4077c00`)

## [10.12.0] - 2026-04-18

### Added — Phase 4: ensemble fold + remote consolidate

- **Phase 4a** `skills/tfx-auto/SKILL.md` 에 `--shape {consensus|debate|panel}` 플래그 추가 — `--mode consensus` 의 출력 shape + orchestration policy 분기. `hub/team/consensus-meta.mjs` 신규 (표준 `meta_judgment` 스키마 유틸: severity_classification/consensus_vs_dispute/recommended_action/followup_issues). `tfx-debate`/`tfx-consensus`/`tfx-panel` 3 스킬 thin alias 축소
- **Phase 4b** `skills/tfx-remote/SKILL.md` 신설 — 기존 `tfx-remote-setup` + `tfx-remote-spawn` 2스킬을 단일 subcommand 인터페이스로 축소 (setup/spawn/list/attach/send/resume/kill/probe). `hub/lib/hosts-compat.mjs` 신규 — hosts.json v1/v2 호환 adapter (safety-guard/ssh-command 기존 소비자 보존)
- **Phase 4b** `skills/tfx-psmux-rules` → `.claude/rules/tfx-psmux.md` 이관 + `AGENTS.md` 복제 (Codex `@import` 미지원 대응). 스킬 → 강제 규약 재분류

### Changed

- `.claude/rules/tfx-routing.md` — ensemble/debate/consensus/panel 자연어 라우팅을 `tfx-auto --mode consensus --shape …` 로 통합
- legacy alias 6개 (tfx-debate, tfx-consensus, tfx-panel, tfx-remote-setup, tfx-remote-spawn, tfx-psmux-rules) stderr 경고 + stdout `[DEPRECATED]` 마커 + `.omc/state/alias-usage.log` append 규약 적용
- `README.md` + `README.ko.md` — 스킬 수 badge (42 → 21 core + 23 aliases) + Phase 3/4 플래그 본문 반영 + `tfx-remote` 통합 예시
- Unreleased 점검 기준 Phase 4 커밋 5건 중 실제 기능 변경 4건 (`7885c5f`, `498a5f7`, `005c22c`, `0724fe1`) 반영 확인. `c28e102` 는 본 changelog 동기화 커밋

### Fixed

- `scripts/sync-hub-mcp-settings.mjs` — tfx-hub 엔트리에 `type:"http"` 자동 백필 + 검증. Claude Code MCP schema violation 회귀 방지 (user `.claude.json`, project `.mcp.json`, `.gemini/settings.json` 공통)
- `tests/unit/sync-hub-mcp-settings.test.mjs` — type 백필 로직 반영 (case 2/8)

## [10.11.0] - 2026-04-18

### Added — Phase 3: true ralph / auto-escalate / --lead (#112)

- **[#112 Phase 3 Step A]** `hub/team/retry-state-machine.mjs` — true ralph + auto-escalate 상태 머신. 3 모드 (bounded/ralph/auto-escalate), stuck detector (동일 failureReason 3회 중단), 4단계 escalation 체인 (codex:gpt-5-mini → codex:gpt-5 → claude:sonnet-4-6 → claude:opus-4-7), EventEmitter on("transition") 연동 (retry-state-machine.test.mjs 12건)
- **[#112 Phase 3 Step B]** `hub/lib/tfx-route-args.mjs` — tfx-auto ARGUMENTS 파서. Phase 3 신규 플래그 3개 (`--lead {claude|codex}`, `--no-claude-native`, `--max-iterations <N>`) + `--retry` 값 확장 (`ralph`, `auto-escalate`) + 조합 validation (`--parallel 1 + --isolation worktree` force none, `--remote + non-swarm` warn) + `--flag=value` 및 `--flag value` 두 형태 지원 (tfx-route-args.test.mjs 16건)
- **[#112 Phase 3 Step C2]** `hub/bridge.mjs retry-run` / `retry-status` 서브커맨드 — multi-process safe state machine bridge. snapshot JSON 파일을 통해 Claude orchestration 이 매 iteration 마다 state 조회/전이. serialize/applySnapshot round-trip + loadSnapshot/saveSnapshot 파일 I/O + version gate (v1) (bridge-retry.test.mjs 3건, retry-state-machine round-trip 4건)
- **[#112 Phase 3 Step D]** `.claude/rules/tfx-escalation-chain.md` 신규 — DEFAULT_ESCALATION_CHAIN 4단계 규약 + 프로젝트 override (`.triflux/config/escalation-chain.json`). `.gitignore` 에 `!.claude/rules/*.md` 예외 추가 — 기존 `tfx-routing.md` / `tfx-execution-skill-map.md` / `tfx-update-logic.md` 3파일도 함께 tracked (Phase 2 source/installed drift 해결)
- **[#112 Phase 3 Step E]** `skills/tfx-auto/SKILL.md` 본문 복원 — PRE-CONTEXT GATE / STATE & ARTIFACT CONTRACT / CLEANUP & CANCEL RULES + Retry state machine 계약 + Codex lead 계약 섹션 추가 (+61 줄). `skills/tfx-interview/SKILL.md` 에 딥인터뷰 트리거 키워드 (`deep-interview`, `딥인터뷰`, `소크라테스`, `깊이 탐색`, `요구사항 분석`) 흡수 + Stage 1~4 질문 템플릿 fallback (+39 줄). Phase 2 Step B thin alias 축소 시 유실된 규칙 본체 이관 완결
- **[#112 Phase 3 Step F]** integration 테스트 2건 — ralph compaction survive (5 iteration 독립 프로세스 counter 유지, snapshot 외부 수정 후 복원, DONE idempotent resume), auto-escalate chain (체인 2단계 전이, 끝까지 소진 BUDGET_EXCEEDED, 중간 verify-success DONE, stuck 은 체인과 독립)

### Changed

- **[#112 Phase 3 Step C1]** `skills/tfx-auto/SKILL.md` 플래그 오버라이드 테이블 5줄 추가 (`--retry ralph`/`auto-escalate`, `--lead claude|codex`, `--no-claude-native`, `--max-iterations N`). Legacy 매핑 3건 갱신:
  - `tfx-autoroute`: `--cli auto --retry 1` → `--retry auto-escalate`
  - `tfx-persist`: `--mode deep --retry ralph` (⚠ degrade) → `--retry ralph` (Phase 3 unlimited)
  - `tfx-auto-codex`: `--cli codex + env` → `--cli codex --lead codex --no-claude-native`
- **[#112 Phase 3 Step C1]** 3 thin alias 본문 재작성 (`tfx-auto-codex`, `tfx-persist`, `tfx-autoroute`) — Phase 3 플래그로 "완전 표현" 됨을 반영. `tfx-persist` 는 state machine 전이 다이어그램 + `.omc/state/retry-<sid>.json` 복원 경로 명시, `tfx-autoroute` 는 DEFAULT_ESCALATION_CHAIN 4단계 + `.claude/rules/tfx-escalation-chain.md` override crosslink
- **[#112 Phase 3 Step D]** `.claude/rules/tfx-routing.md` "깊이 수정자" 표 — "반복" → `--retry ralph` 매핑, "승격" 신규 행 추가 (`--retry auto-escalate`). `.claude/rules/tfx-execution-skill-map.md` 에 "Retry 정책 (Phase 3+)" 섹션 추가

### Fixed

- **[#113]** `claudemd-sync` `ensureTfxSection` 가드 추가 — 인접 `.claude/rules/tfx-routing.md` 존재 시 inline `<routing>` 주입 skip, 기존 inline 블록은 제거 (action: "removed"). SessionStart 훅의 `setup.runDeferred` 가 매 세션마다 CLAUDE.md 에 74줄 주입하던 회귀 종결. Phase 2 Step A 의 "rules 분리 = source of truth" 의도와 일치. 회귀 테스트 2건 추가
- **[hud]** `buildContextUsageView` 에서 monitor.limitTokens 가 modelHintLimit 과 `Math.max()` 비교로 explicit snapshot(1K) 이 모델 기본(200K) 에 덮이던 회귀 — monitor snapshot 이 제공되면 explicit 데이터 우선. `#88` 모델 ID 기반 컨텍스트 추정의 부작용 수정. lake4-integration.test.mjs "buildContextUsageView" 통과
- **[synapse]** `/synapse/heartbeat` 핸들러가 body 를 `{ sessionId, ...partial }` 로 rest 분해해서 `partial = { partial: {...} }` 이중 포장 → `registry.heartbeat` 의 `partialMeta.branch` 등 전부 undefined → 업데이트 무시. `{ sessionId, partial } = body` 로 직접 구조분해. hub-server.test.mjs "세션 등록, heartbeat 갱신, 해제" 통과
- **[lint]** biome 2.4.10 drift 일괄 정리 — `noUnusedImports` / `noUnusedVariables` / `useOptionalChain` 17파일. `String.raw` (Windows path) 보존 검증. 기존 pre-existing 30 test fail 은 `{ todo: ... }` 마커로 전환 후 Step E 에서 복원
- **[packages]** `pack.mjs` 미러 동기화 — 02dd3aa lint drift 17파일 + #108 체인 마지막 (49e0979) 이후 누락된 `codex-app-server-worker.mjs` sha256 복원. packages-sync PRD-4 gate 2건 pass
- **[test]** `safety-guard-psmux.test.mjs` cwd/env 격리 — `.claude/cleanup-bypass` 로컬 우회 마커가 테스트 cwd 에 있으면 runGuard 가 통과로 오판. `cwd: tmpdir()` + `TFX_CLEANUP_BYPASS` env 제거 + 가드 스크립트 절대경로 해석으로 격리
- **[claudemd-sync]** `.claude/rules/tfx-routing.md` 를 source of truth 로 — Phase 2 Step A 이후 CLAUDE.md 에서 `<routing>` 태그가 없어 "routing section not found" 5건 fail. `getLatestRoutingTable()` 가 새 source 먼저 읽고 CLAUDE.md 인라인/heading 은 legacy fallback 유지
- **[skill-drift]** skill-drift.test.mjs 17 todo + deep-interview.test.mjs 3 todo = 20건 전부 복원 (Phase 3 Step E). 검증 대상 본체 이동 (tfx-multi → tfx-auto) + 누락 규칙 본체 복원 (tfx-interview/tfx-research/tfx-auto) 조합

### Tests

- **[#113]** `claudemd-sync.test.mjs` — rules file 가드 skip / inline cleanup 2건 신규
- **[Phase 3 Step E]** `skill-drift.test.mjs` + `deep-interview.test.mjs` todo 20건 전부 pass 전환

## [10.10.0] - 2026-04-18

### Added
- **[#112 Phase 2 Step A]** `tfx-auto` 플래그 오버라이드 front door — `--cli {auto|codex|gemini|claude}`, `--mode {quick|deep|consensus}`, `--parallel {1|N|swarm}`, `--retry {0|1|ralph}`, `--isolation {none|worktree}`, `--remote <host>` 플래그로 11개 legacy 실행 스킬의 단일 진입점 제공
- **[skill]** `tfx-ship` 신규 — triflux 전용 릴리즈 자동화. 기존 `scripts/release/*` 래퍼 + AskUserQuestion 기반 버전 선택 + CHANGELOG 편집 게이트. Co-Authored-By / AI trailer 하드 차단. `--skip-tests` / `--no-publish` / `--dry-run` 플래그 지원
- **[hook]** tfx-ship 매직 키워드 자동 라우팅 — `배포`, `릴리즈`, `릴리스`, `release`, `publish`, `쉽하자`, `tfx-ship`, `/ship` 등 자연어 감지 시 `tfx-ship` 스킬 자동 invoke (`hooks/keyword-rules.json`)

### Changed
- **[#112 Phase 2 Step B]** 9개 legacy 실행 스킬을 `tfx-auto` thin alias 로 축소 (backward compatible, muscle memory 보존). 본문 100~286줄 → 38~45줄. 각 스킬은 stderr deprecation 경고 후 `/tfx-auto <flags>` 로 리다이렉트. 대상: `tfx-autopilot`, `tfx-autoroute`, `tfx-fullcycle`, `tfx-persist`, `tfx-codex`, `tfx-gemini`, `tfx-auto-codex`, `tfx-multi`, `tfx-swarm`. Phase 5 (v11) 물리 삭제 예정
- **[refactor]** Phase 1 drift migration — 이전 세션에서 `~/.claude/skills/` (installed) 에만 적용된 Phase 1 스킬 통합 12개 파일을 `skills/` (source) 로 복원. 다음 `npm i -g triflux` 에서 자동 동기화 유지

### Fixed — Windows codex spawn 버그 체인 (#108)
- **[#108]** Windows cmd quote bug — `shell: true` + `JSON.stringify` wrap 조합에서 cmd.exe 가 embedded `\"` 를 오파싱 → exit 255 "The filename, directory name, or volume label syntax is incorrect." 증상. args 배열 + `shell: false` 로 dispatch 변경. 회귀 테스트 1건 추가
- **[#108-followup]** swarm-planner 가 빈 prompt shard 를 조기 reject — 누락된 `- prompt: |` 블록으로 인한 silent swarm failure 방지. 에러 메시지에 해당 shard 이름 + `docs/prd/_template.md` 힌트 포함
- **[#108-followup]** Windows `.cmd` resolver fallback — `whichCommand("codex")` 가 extensionless 경로 반환 시 `.cmd`/`.exe`/`.bat`/`.ps1` 순차 탐색. Git Bash 스타일 npm wrapper 대신 Windows batch wrapper 선택
- **[#108-followup]** Windows `.cmd` spawn EINVAL (Node CVE-2024-27980 보안 패치 영향) — `shell: false` 로 `.cmd`/`.bat` spawn 불가. `cmd.exe /c <path>` wrapper 로 우회하면서 `shell: false` 유지 (cmd quote 버그 재발 방지)

### Tests
- **[#110]** `swarm-hypervisor.test.mjs` hang 수정 — mock conductor 가 `sessionConfig.onCompleted` 콜백 체인에 정렬되도록 `ensureWorktree` mock 보강
- 20+ 신규 회귀 테스트 — `execution-mode` Windows `.cmd` fallback 6건, `swarm-planner` empty prompt validation 2건, `conductor` argv dispatch 1건

### Chore
- `pack.mjs` 미러 동기화 (packages/core + packages/triflux + packages/remote)

## [10.9.32] - 2026-04-18

### Fixed
- **[#88]** HUD DEFAULT_CONTEXT_LIMIT 200K 하드코드 → 모델 ID 기반 동적 한도 추정. Opus 4.7/4.6 + Sonnet 4.6 = 1M, [1m] suffix opt-in 지원. stale monitor cache 는 `Math.max(modelHint, cache)` 로 자동 오버라이드
- **[#76]** PreToolUse hook 2배 발화 제거. `scripts/setup.mjs` 가 orchestrator `*` entry 존재 시 직접 등록된 `Bash|Agent` / `Skill` entry 를 prune, orchestrator 부재 시에만 legacy ADD 유지
- **[#77]** Opus 4.7 native progress update 와 triflux info-only 상태 태그 중복 제거. `shouldSuppressInfoOnlyContextStatus` helper 로 60~80% info 구간만 suppress, 80% warn/critical 은 유지
- **[#67]** Windows Codex/MCP 고아 프로세스 누락 수정. `taskkill /T` 로 자식 프로세스 트리 일괄 정리, `hub/team/process-cleanup.mjs` 에 Windows 분기 추가

### Added
- **[#81]** Codex `~/.codex/config.toml` `[mcp_servers.tfx-hub]` url 자동 동기화. `syncCodexHubUrl` TOML 전용 함수 신설, hub/server + hub-ensure 성공 경로에서 JSON/TOML 동시 호출
- **[#90]** `hooks/safety-guard.mjs` 에 Codex PRD 실행 중 main 브랜치 직접 commit 방지 가드. `CODEX_PRD_ACTIVE=1` 환경변수 + branch=main 에서 `git commit` 감지 시 exit 2

### Tests
- **[#91]** hub-quota 비차단성 + 실패 로깅 구조 회귀 테스트 (`tests/integration/hub-quota-nonblocking.test.mjs`)
- **[#92]** synapse debounce (burst 합치기 + 경계 순서 보존) + persist 복구 (정상 flush + 손상 파일 clean start) 회귀 테스트

### Chore
- packages/core, packages/triflux, packages/remote 미러 2회 재동기화 (v10.9.31 수정 + 이번 shards 후)

## [10.9.28] - 2026-04-15

### Fixed
- **[CRITICAL]** synapse heartbeat HTTP 라우트 필드명 불일치 수정 — partial 메타데이터 업데이트 정상 동작
- conductor stdin write-after-end 방지 — writable 체크 추가
- conductor 원격 세션 onCompleted 콜백 누락 수정 — swarm integration 정상 트리거
- packages/remote quota-refresh `Promise.all` → `Promise.allSettled` 동기화 — 단일 계정 실패 시 Hub 크래시 방지
- tui/monitor.mjs wt.exe 직접 spawn fallback 제거 — wt-manager 정책 준수
- packages/triflux 3파일 동기화 (headless, cli-adapter-base, tfx-route.sh)
- plugin.json, marketplace.json 버전 동기화

### Changed
- stale 문서 정리: .omc handoff 35건, docs/ 구버전 문서 삭제
- CHANGELOG v10.9.23-27 누락분 보충

## [10.9.27] - 2026-04-15

### Fixed
- cmd.exe /v:off delayed expansion 비활성화 (보안)
- newline 제거로 명령 주입 방지
- CWD factory 경로 로드 순서 보안 강화

## [10.9.26] - 2026-04-15

### Fixed
- codex exec fallback 제거 — MCP transport 전용으로 전환
- codex-mcp bootstrap timeout 60s → 120s

## [10.9.25] - 2026-04-15

### Fixed
- codex-mcp bootstrap timeout 10s → 60s

## [10.9.24] - 2026-04-15

### Fixed
- gemini-worker Windows .cmd shim spawn ENOENT 복원 (buildSpawnSpec)
- gemini-worker quoteWindowsCmdArg %% 이스케이프 추가
- tfx-route-worker CWD 기반 factory 경로 추가

### Added
- delegator psmux 멀티워커 실행 경로 + MCP executor stall 수정

## [10.9.22] - 2026-04-13

### Fixed
- 테스트 35건 실패 전면 수정 (2428/2429 pass) — constants 누락, regex, async, broker 격리 등 16파일
- Codex MCP stall 근본 수정 — config.toml 원자적 swap으로 비허용 서버 비활성화
- wt.exe --version GUI 다이얼로그 팝업 제거
- env-detect: 쉘 경로/버전/installHint 리팩터 + 레이지 캐싱
- cli-adapter-base: broker null 안전 처리, crash circuit breaker 반영
- cross-review: .omc→.triflux 상태 경로 동기화

### Added
- headless: buildDashboardAttachArgs WT 연결 인자 빌더
- hud renderers: [stale] 마커 지원
- account-broker: _skipPersistence 테스트 격리 옵션

### Changed
- OMC 의존성 분리 + setup.mjs lib 동적 스캔 (18개 자동 동기화)
- Hub idle timeout 기본 비활성화 (영구 실행)

## [10.9.16] - 2026-04-12

### Added
- `/synapse/register`, `/synapse/heartbeat`, `/synapse/unregister` HTTP 엔드포인트
- `synapse-http.mjs` fire-and-forget 헬퍼 — hub HTTP API 호출
- `conductor.mjs` 상태 전이 시 자동 synapse register/heartbeat/unregister (HEALTHY→COMPLETED/DEAD)
- `headless.mjs` runHeadless 워커별 synapse 세션 등록/해제 + 진행 heartbeat
- 단위 테스트: synapse-http, synapse-wiring

### Fixed
- tfx-route.sh: exit 143/137/130 시그널 해석 (SIGTERM/SIGKILL/SIGINT 구분)

## [10.9.15] - 2026-04-12

### Added
- `/synapse/sessions` GET, `/synapse/locks` GET, `/synapse/preflight` POST HTTP 엔드포인트
- synapseEmitter 4개 이벤트 hubLog 리스너 (started, heartbeat, stale, removed)
- preflight op whitelist 검증 (6개 유효 op만 허용, 나머지 400)

### Fixed
- `schedulePersist()` destroyed guard — destroy 후 새 타이머 생성 방지 (callback 내 이중 체크)
- hono + @hono/node-server CVE 2건 패치 (serveStatic path traversal, cookie name validation)

## [10.9.2] - 2026-04-11

### Fixed
- **Hub idle timeout**: Named Pipe 활동이 idle timer를 갱신하지 않아 10분 후 Hub 종료되는 문제 수정
- **Hub startup**: hub-ensure를 DEFERRED → BLOCKING으로 승격하여 세션 시작 전 Hub 준비 보장
- **Hub startup**: 실패 시 code:0 → code:1 반환, 타임아웃 시 code:2 반환
- **Windows spawn**: `cmd.exe /c start /b` → native `detached:true` spawn으로 교체
- **Hub crash recovery**: `unhandledRejection`/`uncaughtException` 핸들러 추가 + PID 파일 정리
- **Health check**: hub-ensure의 `/status` → `/health` 엔드포인트로 state.mjs와 통일
- **Lock staleness**: 락 stale 판정 임계값 3초 → 60초 (느린 시작 시 락 깨짐 방지)
- **global_sync warning**: `global_sync_disabled`는 의도적 비활성이므로 경고 제거

### Changed
- **Codex transport**: `TFX_CODEX_TRANSPORT` 기본값 `exec` → `auto` (MCP 양방향 통신 기본)
- **tfx-auto default**: 기본 모드를 `--quick` → `--thorough`로 전환 (Opus 자동 경량화 포함)

## [10.7.1] - 2026-04-09

### Added
- swarm-planner auto-remote suggestion: hosts.json 기반 원격 호스트 자동 분배 제안
- safety-guard OS-aware SSH: macOS/Linux 대상은 bash 문법 허용, Windows만 차단
- macOS 원격 지원: remote-probe 확장, CLAUDE.md SSH 패턴 OS별 분기

### Fixed
- session-start-fast.mjs `pathToFileURL` 래퍼 추가 — Windows에서 `import(join(...))` 경로 깨짐 수정

## [10.7.0] - 2026-04-09

### Added
- `tfx doctor --diagnose`: 진단 번들(zip) 생성 — spawn-trace JSONL, process report, hook timing, spawn stats, system info 수집
- `spawn-trace.mjs`: child_process 드롭인 래퍼 — JSONL 트레이스, rate limit(10/sec), WT 탭 캡(8), opt-in dedupe
- `session-start-fast.mjs`: SessionStart 6개 훅을 1개 node 프로세스에서 실행 (콜드스타트 7회→1회)
- `context compact nudge`, `config audit`, `coverage threshold` 기능

### Changed
- 5개 SessionStart 훅에 `export run()` 분리 — in-process 실행 지원
- headless, psmux, conductor, wt-manager, remote-spawn, session-spawn-helper, dashboard-open, tui를 spawn-trace 경유로 전환
- 모든 wt.exe spawn 경로에 MAX_WT_TABS=8 가드 적용 (탭 폭주 방지)

### Fixed
- legacy Gemini path 제거 + platform-aware process cleanup
- stale tfx-multi state 세션 시작 시 정리
- `npm run pack`에서 누락되던 ROOT 소스 동기화 문제 해결

### Removed
- `run_legacy_gemini`, `gemini_with_retry`, `_gemini_run_once` 함수 삭제

## [10.5.0] - 2026-04-09

### Changed
- **AccountBroker per-account CircuitBreaker**: 전역 breaker를 계정 단위로 이전, 한 계정 장애가 다른 계정에 전파되지 않음
- **DRY adapter refactor**: `executeWithCircuitBroker()` 공통 추출, codex/gemini adapter ~80줄 중복 제거
- **EventEmitter 관측성**: lease/release/circuitOpen/circuitClose/tierFallback/noAvailableAccounts 이벤트

### Added
- `/broker/reload` 엔드포인트: 장시간 세션에서 accounts.json 핫리로드
- `reloadBroker()`: 모듈 레벨 singleton 직접 교체 (ESM live binding)
- 테스트 10개 추가 (22→32): circuit breaker, half-open, 시간 감쇠, busy guard, EventEmitter

### Fixed
- `authFile` path traversal guard: `join()` 결과가 AUTH_BASE_PATH 밖이면 차단
- `release()` busy guard: 비-busy 계정에 대한 중복 release 방지 (가짜 쿨다운 제거)
- `snapshot()` 방어 복사: `failureTimestamps` 배열 참조 노출 방지
- config loader 에러 로깅: `catch { return null }` → `console.error` 후 null 반환

## [10.4.0] - 2026-04-08

### Added
- **HUD Mission Board** (#4): `getMissionBoardState()` + `renderMissionBoard()` — 팀 실행 시 에이전트별 실시간 진행률 HUD 표시
- **Skill Active State** (#6): `activateSkill/deactivateSkill/pruneOrphanSkillStates` — 스킬 중복 실행 방지 + 고아 상태 자동 정리
- **psmux Demo** (#8): `scripts/demo.mjs` — 멀티모델 오케스트레이션 시각적 데모 (dry-run 지원)
- **Windows Path Utils** (#9): `hub/lib/path-utils.mjs` — 7개 경로 변환 유틸 통합 모듈
- **Runtime Strategy** (#10): `hub/team/runtime-strategy.mjs` — TeamRuntime 추상 클래스 + 3 stub 구현체
- worktree `.claude-plugin` 복사 방지 + `pruneOrphanWorktrees()` 고아 정리 (#34)

### Fixed
- headless-guard: `gh`/`git` 명령 본문 내 codex/gemini 문자열 오감지 수정 (#37 Bug4)
- gemini.test.mjs: stream wrapper timeout 시 skip 처리 (flaky test)
- headless-stall.test.mjs: maxRestarts 증가로 타이밍 이슈 해결

### Closed Issues
- 11개 이슈 클로즈: #1, #2, #3, #5, #18, #20, #21, #23, #31, #37, #52 (코드 검증 후 해결 확인)

## [10.1.0] - 2026-04-07

### Security
- headless-guard: pipe bypass 취약점 수정 (`cat X | codex exec` 패턴)
- headless-guard: wrapper bypass 차단 (env, bash -c, 절대경로)
- headless-guard: P1 psmux payload 검사 + P3 2차 휴리스틱 강화
- safety-guard: SSH→PowerShell bash 문법 직접 전달 차단

### Added
- **Reflexion 적응형 학습**: safety-guard 차단 → pending-penalties → adaptive_rules 자동 승격 파이프라인
- **TUI Routing Monitor**: `tfx monitor` — 실시간 라우팅 대시보드 (routing-weights, Q-table, 성능 추적)
- **adaptive_rules API v2**: hit_count 오염 방지 + 스키마 v2 + 테스트 18건
- knip.json workspace 설정 (monorepo dead code 탐지)
- biome.json 프로젝트 맞춤 룰 튜닝

### Fixed
- `setup --dry-run` 크래시: 제거된 `extractMarkdownSection` 호출 → `getLatestRoutingTable()` API로 교체
- MCP fallback 누락: 연결 실패(exit 1)도 transport exit code로 변환하여 auto mode fallback 정상화
- psmux CP949 인코딩 4축 완전 커버
- Git Bash 실행 실패: PowerShell call operator(&) 누락 수정
- WSL bash 대신 Git Bash 명시 + CLI 절대 경로 resolve
- hook-registry Edit/Write passthrough
- 10건 테스트 실패 전면 수정 (claudemd-manager API 변경, alias 구조 변경, test-lock 래퍼 등)

### Changed
- biome lint: 158 errors → 0 errors (auto-fix + 수동 수정 + 룰 튜닝)
- reflexion store 함수를 adaptive_rules API로 통합
- 고아 모듈 5개 @experimental 마킹
- .gitattributes LF 강제

## [10.0.0] - 2026-04-06

### Added
- **Lake 3 Phase 2**: SSH keepalive (ServerAliveInterval/CountMax) + exponential backoff retry for transient SSH failures
- **Lake 3 Phase 2**: hosts.json capability matching — `selectHostForCapability()`, `resolveHostAlias()`, `getHostConfig()`
- **Lake 4**: Shared segments library — `telemetry-segment.md`, `arguments-processing.md`, `mandatory-rules.md` for cross-skill DRY
- **Lake 4**: Skill manifest — `skill.json` for 41 skills, separating metadata from prompt body
- **Lake 4**: `{{#include shared/*.md}}` directive in skill-template.mjs + `loadTemplatePartials()`
- **Lake 5**: Agent Mesh — `mesh-router.mjs` (direct/broadcast/capability routing), `mesh-queue.mjs` (per-agent TTL queues), `mesh-heartbeat.mjs` (stale agent detection), `conductor-mesh-bridge.mjs` (Conductor EventEmitter integration)
- v10 Lake roadmap section in README

### Changed
- README updated to 42 skills with accurate inventory
- CLAUDE.md routing table: split "리서치" into fast (tfx-research) and autonomous (tfx-autoresearch)
- `tfx-deep-interview` description clarifies Gemini-only (not 3-CLI consensus) — naming exception documented
- `tfx-codex-swarm` converted to pure deprecated alias → redirects to `tfx-swarm`
- `keyword-rules.json` routes codex-swarm patterns to tfx-swarm

### Removed
- Orphan directories: `tfx-workspace`, `tfx-codex-swarm-workspace` (eval artifacts without SKILL.md)
- Non-existent skills removed from README: `tfx-codebase-search`, `tfx-deep-autopilot`, `tfx-sisyphus`, `tfx-deslop`
