# PRD: CI baseline 56 fail categorization + multi-shard fix

**Status:** Draft (next session)
**Date:** 2026-04-26
**Target:** triflux v10.17+ (continue-on-error 영구 제거)
**Background:** 9e2b6fc 가 회귀 가드 신뢰성 회복 의도로 `.github/workflows/ci.yml` 의 `continue-on-error: true` 제거 → Linux ubuntu-latest CI 에서 56 fail baseline 노출. cec9124 임시 복원으로 main green 회복했으나 회귀 가드 무력화 잔존.

## 목표

CI 56 fail 카테고리별 분석 → multi-shard fix → `continue-on-error: true` 영구 제거 (회귀 가드 신뢰성 영구 회복).

## 56 fail 분포 (from PR #198 CI run 24946484889, baseline cec9124)

| 파일 | fail count | 카테고리 추정 |
|------|-----------|--------------|
| tests/integration/tfx-route-smoke.test.mjs | 45 | bash + tfx-route shell test (Linux/Windows 차이) |
| tests/unit/codex-app-server-worker.test.mjs | 36 | codex MCP worker (Linux fixture or env) |
| tests/integration/router.test.mjs | 18 | hub router integration |
| tests/unit/worktree-lifecycle.test.mjs | 13 | git worktree (Linux fs 차이?) |
| tests/unit/retry.test.mjs | 12 | retry mechanism |
| tests/unit/codex-review.test.mjs | 12 | codex review test |
| tests/integration/hub-restart.test.mjs | 10 | hub auto-restart |
| tests/unit/memory-doctor.test.mjs | 9 | memory doctor diagnose |
| tests/unit/jsonrpc-stdio.test.mjs | 8 | jsonrpc stdio worker |
| tests/unit/routing-qa.test.mjs | 5 | route_agent (#192 fix 후 잔여) |
| tests/integration/workers.test.mjs | 5 | hub workers |
| tests/integration/tfx-route-team-bridge.test.mjs | 5 | bridge integration |
| tests/unit/rebase-branch-safety.test.mjs | 4 | git rebase safety |
| tests/integration/hub-start-codex-config.test.mjs | 4 | hub start integration |
| 기타 (5 files) | ~9 | misc |

**Total: 56 fail (3084/3196 pass = 96.5%)**

## Phase 1 — 분석 (2026-04-26 완료)

CI run 24946484889 의 fail 메시지 샘플 확인 결과, **단일 dominant root cause** 식별:

### 공통 root cause: ci.yml 에 codex CLI install step 부재

`.github/workflows/ci.yml` 17-34줄 검토 결과 `actions/setup-node@v4` 후 `npm run test:guard-codex-config` 실행만 있음. **codex/gemini CLI 설치 step 없음** → Linux ubuntu-latest 에서 `codex --version` not found / 0.0.0 → tfx-route.sh / hub modules 의 fallback path 진입 → 다수 테스트의 expected stdout 불일치.

### Cascade 분포

1. **tfx-route-smoke 45**: `tfx-route.sh` 가 codex 미설치 감지 → `claude-native` fallback. 테스트는 `resolved_profile=executor` regex 기대. 실제 출력은 `ROUTE_TYPE=claude-native\nAGENT=codex\nMODEL=sonnet...`. 단일 fix → 45 해소.
2. **codex-app-server-worker 36**: AC-1 `initialize timeout` (32ms) → `cancelledByParent` cascade 35건. AC-1 single root → 36 해소.
3. **worktree-lifecycle 13**: 6 subtests suite-level cascade. 개별 분석 필요.
4. **router 18 / retry 12 / codex-review 12 / hub-restart 10 / jsonrpc-stdio 8**: 대부분 codex 의존 cascade 추정.
5. **memory-doctor 9 / 기타 ~14**: Linux 환경 의존 (zip/sysInfo, fixture path).

### 보조 증거

- 테스트 stdout 에 `[tfx-route] 경고: gh 인증 미설정` + `[tfx-route] Codex 버전: 0.0.0` 출력됨 → codex CLI 부재 확정
- `/tmp/tfx-hub-codex-wfQHeB/.codex/config.json` ENOENT → fixture setup 도 codex 의존 path

### 원래 카테고리 추정 (참고 보존)

- **bash/tfx-route shell** (tfx-route-smoke 45) — Linux bash 와 Windows Git Bash 의 글로빙/quoting/heredoc 차이, codex MCP 0.124.0 silent flush, MCP server context7/exa disconnected 환경 의존
- **codex MCP worker** (codex-app-server-worker 36, jsonrpc-stdio 8) — Linux fixture 누락 또는 codex CLI version 차이
- **hub integration** (router 18, hub-restart 10, workers 5, hub-start-codex-config 4, team-bridge 5) — hub TCP/MCP 환경 의존
- **git worktree** (worktree-lifecycle 13, rebase-branch-safety 4) — Windows path vs POSIX path 가정 차이
- **retry/review** (retry 12, codex-review 12) — codex CLI mock 또는 timing 의존
- **memory-doctor** (9) — 진단 번들 생성 (zip/sysInfo) Linux 환경
- **잔여 routing-qa 5** — PR #198 fix 후에도 남은 — local Windows 6 → CI Linux 5 (1 차이)

## Phase 2 — Multi-shard fix

각 카테고리 별 shard:
- Shard A: tfx-route-smoke 45 fail 분석 + fix (가장 큰 — 별 multi-sub-shard 가능)
- Shard B: codex MCP worker (codex-app-server-worker + jsonrpc-stdio) ~44 fail
- Shard C: hub integration (router + hub-restart + workers + hub-start + team-bridge) ~42 fail
- Shard D: git worktree (worktree-lifecycle + rebase-branch-safety) 17 fail
- Shard E: retry/review/memory-doctor ~33 fail
- Shard F: routing-qa 잔여 5 + 기타

**예상 작업량**: 1-2시간 (각 shard 10-20분 codex executor)

## 진입 가이드 (다음 세션)

```bash
# 1. CI baseline log 받기
gh run view 24946484889 --log-failed > /tmp/ci-baseline-fails.log

# 2. 카테고리별 fail 추출
grep -oE "tests/[a-z/-]+/[a-z-]+\.test\.mjs" /tmp/ci-baseline-fails.log | sort | uniq -c | sort -rn

# 3. 각 카테고리 shard PRD 분리 (옵션) 또는 단일 PRD multi-shard
# 4. tfx swarm plan → tfx swarm run
```

## 완료 조건 (전체)

- [ ] CI fail count: 56 → 0 (또는 명백한 환경 의존만 남기고 categorize/skip)
- [ ] `.github/workflows/ci.yml` 의 `continue-on-error: true` 제거 (cec9124 revert)
- [ ] 후속 ship 시 `npm test` 회귀 가드 신뢰성 영구 회복

## 공통 규약 (위반 금지)

- 커밋 메시지에 Co-Authored-By, Generated with Claude, AI-assisted, 🤖 절대 금지
- `--no-verify`, `--amend`, `--no-gpg-sign`, `--no-edit` 사용 금지
- mirror 동기화 필수 (`node scripts/pack.mjs all`)
- biome lint clean 유지
- sensitive paths (`.claude-plugin/`, `bin/`, `.github/workflows/`, `package.json`, `package-lock.json`, `.gitignore`) 는 swarm shard 가 직접 touch 금지 (단 ci.yml 의 continue-on-error 제거는 마지막 단계 별 commit)

## 우선순위 판단

- **P0**: Linux 환경 의존 fail 식별 + skip 가능 여부 판단 (예: `it.skipIf(process.platform === 'win32')`)
- **P1**: 회귀 fail (recent commit이 의도치 않게 깬 것) — git bisect로 식별
- **P2**: 기존 stale fail (오래된 fixture, 의도된 보류) — defer 또는 skip 마커
- **P3**: 잠재 무관 환경 노이즈 (CI runner timing, memory limit) — retry로 완화

## Reference

- PR #198 CI run: 24946484889 (https://github.com/tellang/triflux/actions/runs/24946484889)
- 9e2b6fc: continue-on-error 제거 (회귀 가드 회복 의도)
- cec9124: continue-on-error 임시 복원 (main green hotfix)
- session32 → session33 체크포인트 chain
- f47eb52: 임시 우회 commit (#192 hang fix 시 첫 추가)

## Phase 1 fix 결과

- Commit hash: 이 단일 Phase 1 커밋 (최종 SHA는 커밋 생성 후 deliverable에 기록)
- Files changed:
  - `tests/fixtures/bin/codex` (Linux executable bit)
  - `tests/fixtures/bin/gemini` (Linux executable bit)
  - `tests/fixtures/bin/timeout` (Linux executable bit)
  - `tests/fixtures/fake-codex.mjs`
  - `tests/fixtures/fake-gemini-cli.mjs`
  - `tests/integration/tfx-route-smoke.test.mjs`
  - `.triflux/plans/2026-04-26-ci-baseline-56-fail-categorization.md`
- Rationale: option (b) 선택. CI에 실제 Codex/Gemini CLI 설치 및 인증 우회를 추가하는 것은 Phase 1 범위를 넘고 auth 변수가 크다. 대신 smoke test가 번들 fake CLI를 Linux CI에서도 실행 가능한 fixture로 사용하도록 executable bit와 fake `--version`을 보강했다. 또한 현재 라우터 정책에 맞게 no-op 승격은 `exit_code: 68`로 검증하고, executor auto MCP 정책은 `context7` 단독 허용으로 정렬했다.
- Expected impact: `tests/integration/tfx-route-smoke.test.mjs`의 CI Linux `codex not found → claude-native fallback` cascade를 제거하여 baseline 45 fail 해소 예상.

## Phase 2 fix 결과

- Commit hash: 이 단일 Phase 2 커밋 (최종 SHA는 커밋 생성 후 deliverable에 기록)
- Files changed:
  - `tests/unit/codex-app-server-worker.test.mjs`
  - `.triflux/plans/2026-04-26-ci-baseline-56-fail-categorization.md`
- Rationale: option (a) 선택. 이 unit suite는 `spawnFn`과 fake JSON-RPC client를 주입하므로 실제 `codex` CLI 부재나 fixture `PATH` 문제가 root가 아니다. AC-1 `initialize timeout` 테스트가 30ms bootstrap budget과 `unref()` timer에 의존해 Linux CI에서 test runner가 이벤트 루프 종료로 subtest를 취소할 수 있었다. Timeout fake를 ref timer로 바꾸고 bootstrap timeout을 500ms로 올려 실제 `CodexAppServerTransportError` rejection 경로를 안정적으로 관측하게 했다.
- Expected impact: `tests/unit/codex-app-server-worker.test.mjs`의 AC-1 `initialize timeout` 단일 root를 제거하여 PR #199 CI의 해당 파일 36 fail cascade 해소 예상.

## 다음 세션 시작 시 (context-restore 활용)

```bash
# /tfx-auto 또는 /context-restore 후
cat .triflux/plans/2026-04-26-ci-baseline-56-fail-categorization.md
gh run view 24946484889 --log-failed | grep -oE "tests/[a-z/-]+/[a-z-]+\.test\.mjs" | sort | uniq -c | sort -rn

# 각 fail 카테고리 deep-dive 후 swarm PRD 분할 작성
# tfx swarm plan → tfx swarm run
```
