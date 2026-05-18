# Shard 4 — P4a tmux Cleanup Policy + P4b SessionEnd Hook JSON Schema

> Source: [docs/research/macos-process-lifecycle-leak-report-2026-05-18.md](../../docs/research/macos-process-lifecycle-leak-report-2026-05-18.md)
> Cited ranges: §"Detached tmux sessions and zombies" (lines 136-163), §"SessionEnd cleanup is intentionally report-only" (lines 328-342), §"P4 Recommended Fix" (lines 449-465)
> Live evidence (P4b, 본 작업 중 추가 발견 — 세션 종료 hook 라이브 캡처):
> ```
> Hook JSON output validation failed — (root): Invalid input
> ```
> 출력 schema 가 `{systemMessage, hookSpecificOutput: {hookEventName, additionalContext}}` 인데 Claude Code 최신 SessionEnd hook schema 와 mismatch — 매 세션 종료 시 validation error 발생.
> Worktree branch: `fix/macos-lifecycle-s4-tmux-cleanup-schema`

## Problem

### P4a — tmux cleanup policy gap (보고서 §"Detached tmux sessions and zombies", lines 136-163)

라이브 evidence (보고서 lines 139-156): 11개 detached tmux session (omx-projects-*, tfx-mac-multi-smoke-*, tpcg-brief-* 등) + 8 zombie. tmux 가 detached session 을 설계대로 보존 — 단 cross-project + 오래된 unattended 세션이 누적되는 workflow 와 충돌. 보고서 line 162: "lifecycle policy is too weak for this workflow".

`hooks/session-end-cleanup.mjs` 는 의도적으로 report-only (보고서 lines 336-340):
```
// Report-only by default. Opt-in cleanup only removes the repo-local
// .triflux/subagents/subagents.json file when stale running lifecycle state is
// present. It never kills processes or touches external HOME/MCP configs.
```
안전하지만 lifecycle gap 보존 — Shard 1 의 mux identity fix 와 결합해야 macOS path 에서 `tmux` 사용.

### P4b — SessionEnd hook JSON schema mismatch (작업 중 추가 발견)

- `hooks/session-end-cleanup.mjs::buildOutput()` 가 `{systemMessage, hookSpecificOutput: {hookEventName, additionalContext}}` 반환
- Claude Code current hook schema 는 PreToolUse / PostToolUse / Stop / SessionEnd 마다 `hookSpecificOutput` 구조 다름 — SessionEnd 의 정확한 shape 미일치
- 매 세션 종료 시 `Hook JSON output validation failed — (root): Invalid input` 발생 → hook 의 cleanup signal 이 Claude Code 에 미반영, 로그만 누적

## Fix Direction (보고서 lines 453-459)

### P4a

1. **`hooks/session-end-cleanup.mjs` detached tmux session 리포트 확장**:
   - 각 session 의 age, cwd, command, 추정 process tree memory (보고서 line 456)
   - macOS path 는 mux === "tmux" 사용 (Shard 1 의 fix 의존)
   - psmux-specific Windows cleanup 과 분리 보존 (보고서 line 458)
2. **`bin/triflux.mjs doctor` 에 detached session 항목 추가** (S3 와 lockstep)
3. **명시 cleanup CLI**:
   - `tfx doctor --cleanup-stale-tmux --prefix tfx-*` (age threshold 옵션, default dry-run)
   - prefix/scope 밖 session 거부 (보고서 line 464)
4. **report-only default 유지** — 명시 옵션 없이 session kill 안 함 (line 463)

### P4b

1. **SessionEnd hook schema 정합화**:
   - Claude Code current spec (SessionEnd hookSpecificOutput) 확인 후 `buildOutput()` return shape 갱신
   - shape 후보: `{ continue: boolean, suppressOutput?: boolean, decision?: 'allow'|'block', reason?: string }` 또는 SessionEnd 전용 키 — spec 우선
2. **출력 검증**:
   - `buildOutput()` 가 spec 준수하는지 inline shape check 또는 (가능하면) zod 같은 validation 도입은 dep 추가 금지 정책 위반 — 자체 함수
3. **회귀 방어**:
   - validation error 0 회귀 테스트

## Acceptance Criteria (보고서 lines 462-465 + P4b)

- macOS cleanup path 가 `tmux` 사용 (line 462; Shard 1 의존)
- report-only default path 가 session kill 안 함 (line 463)
- explicit cleanup 이 prefix/scope 밖 session 거부 (line 464)
- doctor 출력에 detached session count + memory estimate 포함
- SessionEnd hook 출력 → Claude Code validation 통과 (Invalid input 0)

## Regression Tests

`tests/unit/session-end-cleanup.test.mjs` (신규):
- `report-only default → sessions not killed (mock spawn assertion)`
- `cleanup with --prefix tfx-* matching → only matching sessions killed (default dry-run)`
- `cleanup with prefix not matching → session refused with diagnostic`
- `buildOutput() return value passes SessionEnd hook spec shape check`

`tests/unit/doctor-macos-hooks.test.mjs` 확장:
- `doctor output includes detached tmux session count`
- `doctor output includes memory estimate per session`

## Files (root + mirror)

| Root path | packages/triflux mirror |
|-----------|-------------------------|
| `hooks/session-end-cleanup.mjs` | byte-identical |
| `bin/triflux.mjs` (doctor 확장 — S3 와 lockstep) | byte-identical |
| `tests/unit/session-end-cleanup.test.mjs` | mirror 제외 |
| `tests/unit/doctor-macos-hooks.test.mjs` | mirror 제외 |

Mirror verify:
```bash
diff -q hooks/session-end-cleanup.mjs packages/triflux/hooks/session-end-cleanup.mjs   # exit 0
diff -q bin/triflux.mjs packages/triflux/bin/triflux.mjs   # exit 0
```

## Cross-review

- Author CLI: codex (gpt-5.3-codex)
- Reviewer: claude (opus-4-7)
- ultrareview 미사용

## Cross-cut Coordination

`bin/triflux.mjs doctor` 는 Shard 3 의 stale hub diagnostic 과 함께 확장. **머지 순서 S3 → S4 권장**:
- S4 PR 은 S3 branch (`fix/macos-lifecycle-s3-hub-retirement`) 위 rebase 또는 stacked
- S3 머지 후 S4 가 main rebase 후 doctor 출력 통합

Shard 1 의존: macOS cleanup path 가 `mux === "tmux"` 로 동작하려면 S1 의 `detectMultiplexer()` fix 가 main 에 머지된 상태여야 자연스러움. 단 PR 단위에서는 독립 (S4 의 cleanup 호출이 S1 fix 이후에도 인터페이스 안정).

## Verify (PR body 에 포함)

```bash
pnpm test tests/unit/session-end-cleanup.test.mjs tests/unit/doctor-macos-hooks.test.mjs
tfx doctor 2>&1 | grep -iE "detached|tmux|session"   # detached session 항목 노출
node hooks/session-end-cleanup.mjs --self-test 2>&1 | grep -i "schema"   # validation pass
diff -q hooks/session-end-cleanup.mjs packages/triflux/hooks/session-end-cleanup.mjs
diff -q bin/triflux.mjs packages/triflux/bin/triflux.mjs
```

기대 결과: 모든 명령 0 exit. doctor 가 detached tmux session 보고. SessionEnd hook self-test 가 schema validation pass.
