# Shard 2 — P2 `scripts/test-lock.mjs` Supervisor Hardening

> Source: [docs/research/macos-process-lifecycle-leak-report-2026-05-18.md](../../docs/research/macos-process-lifecycle-leak-report-2026-05-18.md)
> Cited ranges: §"Test runner supervision gap" (lines 167-232), §"P2 Recommended Fix" (lines 410-428)
> Worktree branch: `fix/macos-lifecycle-s2-test-lock-supervisor`

## Problem

`scripts/test-lock.mjs` 는 concurrent start 만 막고 child lifetime 을 owning 하지 않음:

- 보고서 lines 192-207 의 발췌:
  ```
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(143);
  });
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, TEST_LOCK_PID: String(process.pid) },
  });
  child.on("exit", (code) => {
    releaseLock();
    process.exit(code ?? 1);
  });
  ```
- 누락 (보고서 lines 209-216):
  - timeout 없음
  - SIGINT/SIGTERM/SIGHUP child 로 forward 안 함
  - parent exit 시 child kill 안 함
  - process group / detached group 관리 없음
  - 10분 이상 lock 시 stale child 검출 없음
  - stale lock 제거 ≠ stale process cleanup
- `scripts/release/prepare.mjs` 의 10분 timeout (보고서 lines 220-228) 은 release path 한정 — `npm test`, `npm run test:unit`, `npm run test:integration` 미상속

라이브 evidence (보고서 lines 25-31, 35-38):
```
PID 72215, PPID 1, age ≈ 2일, 29.7GB footprint
Command: node --test --test-force-exit --test-concurrency=8 …
```
parent 가 죽고 launchd 가 reparent → 본 보고서의 30GB / 16GB RAM 사고 직접 원인

## Fix Direction (보고서 lines 414-421)

1. **timeout 도입**: env `TEST_LOCK_TIMEOUT_MS` (default 10min, release prepare 와 동일). 초과 시 child kill + non-zero exit
2. **signal forwarding**: parent 가 SIGINT/SIGTERM/SIGHUP 수신 → child 에 동일 signal forward → wait → exit
3. **parent shutdown → child kill**: child.kill('SIGTERM') → 5s grace → SIGKILL → wait → exit
4. **process group**: POSIX 환경에서 `detached: true` + `process.kill(-pid, 'SIGTERM')` 또는 동등한 group kill 검토 (보고서 line 419) — Windows 호환성 영향 분석 동반
5. **lock metadata 에 child PID 추가**: lock 파일 schema 에 `{ parent_pid, child_pid, started_at, timeout_ms }` 저장 — cleanup 이 정확한 PID 추적
6. **stale lock 처리 분기** (보고서 lines 427-428):
   - stale lock + live child PID → actionable diagnostic + non-zero exit (overwrite 금지, 보고서 line 420)
   - stale lock + dead child PID → cleanup + 정상 진행

## Acceptance Criteria (보고서 lines 425-428)

- Parent SIGTERM 수신 → child 종료 (forward 또는 kill)
- Child timeout 초과 → wrapper non-zero exit + child not alive (`kill -0 child_pid` exit non-zero)
- Stale lock + live child → actionable diagnostic (PID + age + command 노출), exit non-zero, lock 보존
- Stale lock + dead child → cleanup + 정상 진행
- 정상 종료 flow (timeout 미트리거) → 기존 동작 보존

## Regression Tests (필수 추가)

`tests/unit/test-lock.test.mjs` (신규):
- `parent SIGTERM forwarded to child` (보고서 line 425)
- `child timeout → non-zero exit + child killed within 5s grace` (line 426)
- `stale lock with live child → actionable diagnostic + non-zero exit + lock preserved` (line 427)
- `stale lock with dead child → cleanup + proceed` (line 428)
- `lock metadata schema includes child_pid` (회귀: schema 변경)

## Files (root + mirror)

| Root path | packages/triflux mirror |
|-----------|-------------------------|
| `scripts/test-lock.mjs` | byte-identical (cp 또는 동시 Edit) |
| `tests/unit/test-lock.test.mjs` | **mirror 제외** (`tests/` 는 npm files 미포함, `.claude/rules/tfx-mirror-policy.md §mirror 제외`) |

Mirror verify:
```bash
diff -q scripts/test-lock.mjs packages/triflux/scripts/test-lock.mjs   # exit 0
```

Note: `packages/triflux/scripts/__tests__/` 가 따로 테스트 mirror 한다면 동기 (PR #222 패턴), 단 일반 `tests/unit/` 은 미포함.

## Cross-review

- Author CLI: codex (gpt-5.3-codex)
- Reviewer: claude (opus-4-7)
- ultrareview 미사용

## Verify (PR body 에 포함)

```bash
pnpm test tests/unit/test-lock.test.mjs
TEST_LOCK_TIMEOUT_MS=500 node scripts/test-lock.mjs --test tests/unit/runtime-strategy.test.mjs
echo "exit: $?"
pgrep -f "node --test --test-force-exit" | wc -l   # 0
diff -q scripts/test-lock.mjs packages/triflux/scripts/test-lock.mjs
```

기대 결과: pnpm test 통과; 짧은 timeout 으로 child 즉시 종료 (non-zero exit + pgrep 0).
