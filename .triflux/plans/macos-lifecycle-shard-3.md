# Shard 3 — P3a Hub Stale Retirement + P3b Version Drift

> Source: [docs/research/macos-process-lifecycle-leak-report-2026-05-18.md](../../docs/research/macos-process-lifecycle-leak-report-2026-05-18.md)
> Cited ranges: §"Hub server accumulation" (lines 56-97), §"Hub detached singleton gap" (lines 234-271), §"P3 Recommended Fix" (lines 430-447)
> Live evidence (P3b, 본 작업 중 추가 발견 — 2026-05-18 재부팅 직전 캡처): pid file 가리키는 `PID 86156 / port 29196 / v10.21.0-867d18a3` 는 dead, active hub 는 `PID 61463 / port 27888 / v10.20.2-efabb91b` (옛 version). 재부팅으로 자연 해결됐으나 동일 재발 방지를 위해 코드 fix 필수.
> Worktree branch: `fix/macos-lifecycle-s3-hub-retirement`

## Problem

### P3a — Hub stale retirement (보고서 §"Hub detached singleton gap", lines 234-271)

`scripts/hub-ensure.mjs` 가 detached + unref start 후 target host/port health 만 확인:

- 보고서 lines 242-249 의 발췌:
  ```
  const child = spawn(process.execPath, [serverPath], {
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  ```
- 보고서 lines 254-262 의 발췌:
  ```
  if (await isHubHealthy(host, port)) { … return … }
  const started = startHubDetached(port);
  ```
- 누락 (보고서 lines 264-270):
  - repo-wide / user-wide stale hub reaper 없음
  - `~/.claude/cache/tfx-hub/hub.pid` 가 live current hub 가리키는지 검증 안 함
  - random port 위 옛 hub 정리 안 함
  - 새/옛 hub 공존 시 version-aware retirement 없음

라이브 evidence (보고서 lines 60-91): 46개 hub/server.mjs (전부 PPID=1, 누적 RSS 677 MB), pid file (port 29196, v10.21.0-867d18a3) vs active /health (port 27888, v10.20.2-efabb91b) 불일치.

### P3b — Version drift (작업 중 추가 발견, 보고서 §P3 의 구체 사례)

- v10.21.0 새 hub 가 :27888 점유 시도 → 옛 v10.20.2 LISTEN 중 → `:29196` 으로 cascade → pid file 갱신
- PID 86156 (:29196) 죽고 옛 PID 61463 (:27888) 살아남음
- 결과: 사용자가 옛 version 으로 작업 (pid file 은 새 version 가리키지만 실제 traffic 은 옛 version 으로)
- 보고서 P3 가 명시한 "version-aware retirement" 부재의 구체 사례

## Fix Direction (보고서 lines 434-440)

1. **`scripts/hub-ensure.mjs` startup 검증 강화**:
   - pid file 의 PID alive 확인 (`process.kill(pid, 0)` exit code)
   - 해당 PID 가 실제 `hub/server.mjs` 인지 (proc cmd 매칭)
   - listening port == pid file port (`lsof -nP -iTCP:<port> -sTCP:LISTEN`)
   - `/health` 응답 `version` == 기대 version
   - 불일치 시 명시 warn + retirement 시도
2. **port-collision + version mismatch → retire**:
   - 옛 hub 에 SIGTERM → 5s grace → SIGKILL → port 점유 풀린 뒤 새 hub bind
   - retire 실패 시 random-port cascade 허용하되 stderr warn (silent 금지)
3. **`bin/triflux.mjs doctor` stale hub diagnostic 추가**:
   - PPID=1 인 hub/server.mjs 목록: PID, version, uptime, port, 외부 ESTABLISHED connection count
   - 총 RSS estimate
4. **opt-in cleanup CLI**:
   - `tfx doctor --cleanup-stale-hubs` (active healthy hub 명시 제외)
   - default dry-run (보고서 line 446: "cleanup excludes the active healthy hub")
   - 명시 `--apply` 시 실제 SIGTERM/SIGKILL

## Acceptance Criteria (보고서 lines 442-447)

- Stale pid file 이 active default hub 를 masking 안 함 (line 444)
- 여러 옛 hub 가 doctor 에서 보고됨 (line 445)
- cleanup 이 active healthy hub 제외 (line 446)
- repo/worktree 별 hub 격리 또는 명시 cross-worktree 보고 (line 447)
- P3b 회귀: port-collision + version mismatch → 옛 hub retire 시도 + 새 hub bind 또는 명시 warn

## Regression Tests

`tests/integration/hub-singleton.test.mjs` 확장:
- `stale pid file does not mask active default hub` (보고서 line 444)
- `multiple old hubs reported in doctor output` (line 445)
- `cleanup excludes the active healthy hub` (line 446)

`tests/unit/hub-ensure-version-drift.test.mjs` (신규, P3b 회귀):
- `port-collision + version mismatch → old hub retire attempted`
- `retire failure → cascade with stderr warn (not silent)`
- `pid file pointing to dead PID → invalidated and rewritten`

`tests/unit/doctor-stale-hubs.test.mjs` (신규):
- `doctor lists PPID=1 hub/server.mjs with version + uptime + port`
- `doctor --cleanup-stale-hubs --dry-run excludes active healthy hub`

## Files (root + mirror)

| Root path | packages/triflux mirror |
|-----------|-------------------------|
| `scripts/hub-ensure.mjs` | byte-identical |
| `bin/triflux.mjs` (doctor 명령 확장) | byte-identical |
| `tests/integration/hub-singleton.test.mjs` | mirror 제외 |
| `tests/unit/hub-ensure-version-drift.test.mjs` | mirror 제외 |
| `tests/unit/doctor-stale-hubs.test.mjs` | mirror 제외 |

Mirror verify:
```bash
diff -q scripts/hub-ensure.mjs packages/triflux/scripts/hub-ensure.mjs   # exit 0
diff -q bin/triflux.mjs packages/triflux/bin/triflux.mjs   # exit 0
```

## Cross-review

- Author CLI: codex (gpt-5.3-codex)
- Reviewer: gemini (pro25) — architecture cross-check (Plan-level)
- ultrareview 미사용

## Cross-cut Coordination

`bin/triflux.mjs doctor` 는 Shard 4 도 확장 (P4b SessionEnd schema + detached tmux reporting). **머지 순서**:
- 권장: S3 → S4 (S4 PR 이 S3 branch 위 rebase) — doctor 출력 conflict 회피
- 또는 stacked PR (S4 base = S3 branch)
- swarm worker 가 자동 rebase 못 하면 PR head 사용자 또는 다음 lane (S4 worker) 가 명시 rebase

## Verify (PR body 에 포함)

```bash
pnpm test tests/integration/hub-singleton.test.mjs tests/unit/hub-ensure-version-drift.test.mjs tests/unit/doctor-stale-hubs.test.mjs
tfx doctor 2>&1 | grep -E "stale|hub|PPID"   # stale hub 항목 노출
tfx doctor --cleanup-stale-hubs --dry-run 2>&1 | grep -E "active|excluded|skip"   # active 제외
diff -q scripts/hub-ensure.mjs packages/triflux/scripts/hub-ensure.mjs
diff -q bin/triflux.mjs packages/triflux/bin/triflux.mjs
```

기대 결과: 모든 명령 0 exit. doctor 가 stale hub 보고. cleanup --dry-run 출력에 active hub 가 "skipped/excluded" 로 명시.
